import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AdapterRef, AssetRef, WorkflowManifest } from '../contract/types.js';
import type { ContractValidator } from '../contract/validator.js';
import { manifestSha256 } from '../lib/canonical-json.js';
import type { ComfyPrompt } from './comfy-client.js';

/**
 * Workflow packages (owned and supplied by Track A). One directory per
 * workflow version:
 *
 *   <packages_dir>/<workflow_key>/<version>/manifest.json       VEC workflow manifest
 *   <packages_dir>/<workflow_key>/<version>/workflow_api.json   ComfyUI graph in API format (exported by Track A)
 *   <packages_dir>/<workflow_key>/<version>/bindings.json       where VEC inputs go in that graph
 *
 * The bridge never reads model names or chooses models: the graph is used as
 * delivered, and only the bound inputs are replaced per job.
 */
export interface InputTarget {
  node: string;
  input: string;
}

export interface ParameterBinding extends InputTarget {
  /** String template using {parameter} placeholders; default is the parameter value itself. */
  template?: string;
  /** Lookup table from the parameter value to the input value (e.g. aspect ratio → width). */
  map?: Record<string, string | number | boolean>;
  type?: 'string' | 'integer' | 'number' | 'boolean';
}

export interface Bindings {
  parameters?: Record<string, ParameterBinding[]>;
  /** Reference roles (persona reference roles and per-job roles) → LoadImage-style inputs, filled in order. */
  references?: Record<string, InputTarget[]>;
  /** Adapter slots in order; unused slots get their weight inputs set to 0. */
  adapters?: (InputTarget & { weight_inputs?: string[] })[];
  seed?: InputTarget[];
  output_count?: InputTarget[];
  outputs: { node: string; kind: 'image' | 'video' }[];
}

export interface WorkflowPackage {
  manifest: WorkflowManifest;
  manifestSha256: string;
  graph: ComfyPrompt;
  bindings: Bindings;
  dir: string;
  warnings: string[];
}

const target = { type: 'object', required: ['node', 'input'], properties: { node: { type: 'string' }, input: { type: 'string' } } };
const BINDINGS_SCHEMA = {
  type: 'object',
  required: ['outputs'],
  additionalProperties: false,
  properties: {
    parameters: {
      type: 'object',
      additionalProperties: {
        type: 'array',
        items: {
          ...target,
          properties: { ...target.properties, template: { type: 'string' }, map: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } }, type: { enum: ['string', 'integer', 'number', 'boolean'] } },
          additionalProperties: false,
        },
      },
    },
    references: { type: 'object', additionalProperties: { type: 'array', items: { ...target, additionalProperties: false } } },
    adapters: { type: 'array', items: { ...target, properties: { ...target.properties, weight_inputs: { type: 'array', items: { type: 'string' } } }, additionalProperties: false } },
    seed: { type: 'array', items: { ...target, additionalProperties: false } },
    output_count: { type: 'array', items: { ...target, additionalProperties: false } },
    outputs: {
      type: 'array',
      minItems: 1,
      items: { type: 'object', required: ['node', 'kind'], additionalProperties: false, properties: { node: { type: 'string' }, kind: { enum: ['image', 'video'] } } },
    },
  },
};
const validateBindings = new Ajv2020({ allErrors: true, strict: false }).compile(BINDINGS_SCHEMA);

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function checkTarget(graph: ComfyPrompt, t: InputTarget, where: string, problems: string[]): void {
  const node = graph[t.node];
  if (!node) problems.push(`${where}: node ${t.node} is not in workflow_api.json`);
  else if (!(t.input in (node.inputs ?? {}))) problems.push(`${where}: node ${t.node} (${node.class_type}) has no input "${t.input}"`);
  else if (Array.isArray(node.inputs[t.input])) problems.push(`${where}: node ${t.node} input "${t.input}" is a link, not a value`);
}

export function loadPackage(dir: string, validator: ContractValidator): WorkflowPackage {
  const manifest = readJson(join(dir, 'manifest.json')) as WorkflowManifest;
  const m = validator.validate('workflow-manifest', manifest);
  if (!m.ok) throw new Error(`manifest.json is not a valid VEC workflow manifest: ${JSON.stringify(m.violations).slice(0, 500)}`);
  if (manifest.workflow_key.startsWith('__conformance__')) throw new Error('reserved workflow key');
  const graph = readJson(join(dir, 'workflow_api.json')) as ComfyPrompt;
  if (!graph || typeof graph !== 'object' || Array.isArray(graph) || !Object.values(graph).every((n) => n && typeof n.class_type === 'string' && typeof n.inputs === 'object')) {
    throw new Error('workflow_api.json must be a ComfyUI graph in API format ({ "<id>": { "class_type": ..., "inputs": {...} } })');
  }
  const bindings = readJson(join(dir, 'bindings.json')) as Bindings;
  if (!validateBindings(bindings)) throw new Error(`bindings.json is invalid: ${JSON.stringify(validateBindings.errors).slice(0, 500)}`);
  const problems: string[] = [];
  const warnings: string[] = [];
  for (const [p, targets] of Object.entries(bindings.parameters ?? {})) targets.forEach((t, i) => checkTarget(graph, t, `parameters.${p}[${i}]`, problems));
  for (const [r, targets] of Object.entries(bindings.references ?? {})) targets.forEach((t, i) => checkTarget(graph, t, `references.${r}[${i}]`, problems));
  (bindings.adapters ?? []).forEach((t, i) => {
    checkTarget(graph, t, `adapters[${i}]`, problems);
    for (const w of t.weight_inputs ?? []) checkTarget(graph, { node: t.node, input: w }, `adapters[${i}].weight_inputs`, problems);
  });
  (bindings.seed ?? []).forEach((t, i) => checkTarget(graph, t, `seed[${i}]`, problems));
  (bindings.output_count ?? []).forEach((t, i) => checkTarget(graph, t, `output_count[${i}]`, problems));
  for (const o of bindings.outputs) if (!graph[o.node]) problems.push(`outputs: node ${o.node} is not in workflow_api.json`);
  const props = Object.keys((manifest.input_schema as { properties?: Record<string, unknown> }).properties ?? {});
  const required = ((manifest.input_schema as { required?: string[] }).required ?? []) as string[];
  const used = new Set<string>(Object.keys(bindings.parameters ?? {}));
  for (const targets of Object.values(bindings.parameters ?? {})) for (const t of targets) for (const m2 of (t.template ?? '').matchAll(/\{([a-zA-Z0-9_]+)\}/g)) used.add(m2[1]!);
  for (const r of required) if (!used.has(r) && r !== 'seed') problems.push(`required parameter "${r}" is not bound`);
  for (const p of props) if (!used.has(p) && p !== 'seed') warnings.push(`parameter "${p}" is not bound and will be ignored`);
  if (manifest.outputs.count.max > 1 && !bindings.output_count?.length) problems.push('outputs.count.max > 1 needs an output_count binding');
  if ((manifest.references?.adapters?.max ?? 0) > (bindings.adapters?.length ?? 0)) problems.push('manifest allows more adapters than bound adapter slots');
  if (problems.length) throw new Error(problems.join('; '));
  return { manifest, manifestSha256: manifestSha256(manifest as unknown as Record<string, unknown>), graph, bindings, dir, warnings };
}

/** Loads every package under the directory; invalid ones are reported and not exposed. */
export function loadPackages(root: string, validator: ContractValidator): { packages: Map<string, WorkflowPackage>; errors: { dir: string; error: string }[] } {
  const packages = new Map<string, WorkflowPackage>();
  const errors: { dir: string; error: string }[] = [];
  let keys: string[] = [];
  try {
    keys = readdirSync(root).filter((k) => statSync(join(root, k)).isDirectory());
  } catch (err) {
    errors.push({ dir: root, error: (err as Error).message });
    return { packages, errors };
  }
  for (const key of keys) {
    for (const version of readdirSync(join(root, key)).filter((v) => statSync(join(root, key, v)).isDirectory())) {
      const dir = join(root, key, version);
      try {
        const pkg = loadPackage(dir, validator);
        if (pkg.manifest.workflow_key !== key || pkg.manifest.version !== version) throw new Error(`directory must be <workflow_key>/<version> (manifest says ${pkg.manifest.workflow_key}/${pkg.manifest.version})`);
        packages.set(`${key}@${version}`, pkg);
      } catch (err) {
        errors.push({ dir, error: (err as Error).message });
      }
    }
  }
  return { packages, errors };
}

function coerce(value: unknown, type: ParameterBinding['type']): unknown {
  switch (type) {
    case 'string':
      return String(value);
    case 'integer':
      return Math.trunc(Number(value));
    case 'number':
      return Number(value);
    case 'boolean':
      return Boolean(value);
    default:
      return value;
  }
}

/** Placed reference images (already uploaded to ComfyUI): role → ComfyUI input names, in order. */
export type PlacedReferences = Map<string, string[]>;

/** Builds the per-job graph: a copy of Track A's graph with only the bound inputs replaced. */
export function buildPrompt(
  pkg: WorkflowPackage,
  job: { parameters: Record<string, unknown>; seed: number; outputCount: number; adapters: AdapterRef[]; references: PlacedReferences },
): ComfyPrompt {
  const g = structuredClone(pkg.graph);
  const set = (t: InputTarget, v: unknown) => {
    g[t.node]!.inputs[t.input] = v;
  };
  for (const [name, targets] of Object.entries(pkg.bindings.parameters ?? {})) {
    for (const t of targets) {
      if (t.template) set(t, t.template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, k: string) => (job.parameters[k] === undefined ? '' : String(job.parameters[k]))).replace(/\s+,/g, ',').trim());
      else if (job.parameters[name] !== undefined && t.map) {
        const mapped = t.map[String(job.parameters[name])];
        if (mapped !== undefined) set(t, coerce(mapped, t.type));
      } else if (job.parameters[name] !== undefined) set(t, coerce(job.parameters[name], t.type));
    }
  }
  for (const t of pkg.bindings.seed ?? []) set(t, job.seed);
  for (const t of pkg.bindings.output_count ?? []) set(t, job.outputCount);
  const slots = pkg.bindings.adapters ?? [];
  slots.forEach((slot, i) => {
    const a = job.adapters[i];
    if (a) {
      set(slot, a.engine_ref);
      for (const w of slot.weight_inputs ?? []) set({ node: slot.node, input: w }, a.weight ?? 1);
    } else {
      for (const w of slot.weight_inputs ?? []) set({ node: slot.node, input: w }, 0);
    }
  });
  for (const [role, targets] of Object.entries(pkg.bindings.references ?? {})) {
    const names = job.references.get(role) ?? [];
    targets.forEach((t, i) => {
      if (names[i]) set(t, names[i]);
    });
  }
  return g;
}

/** References a job needs uploaded: persona references and per-job references whose role is bound. */
export function boundReferences(pkg: WorkflowPackage, refs: AssetRef[]): AssetRef[] {
  const roles = pkg.bindings.references ?? {};
  const perRole = new Map<string, number>();
  return refs.filter((r) => {
    const slots = roles[r.role]?.length ?? 0;
    const used = perRole.get(r.role) ?? 0;
    if (used >= slots) return false;
    perRole.set(r.role, used + 1);
    return true;
  });
}
