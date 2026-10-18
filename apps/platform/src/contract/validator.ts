import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020, type ErrorObject as AjvError, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

// ajv-formats ships CommonJS; under NodeNext the plugin function is exposed as `.default`.
const addFormats = addFormatsModule.default;

const BASE = 'https://contracts.aios.internal/vec/v1/';

export type ContractSchemaName =
  | 'engine-info'
  | 'workflow-list'
  | 'workflow-manifest'
  | 'job-submission'
  | 'job-status'
  | 'error-response'
  | 'resource-state'
  | 'release-request'
  | 'release-response';

export interface Violation {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  violations: Violation[];
}

function toViolations(errors: AjvError[] | null | undefined): Violation[] {
  return (errors ?? []).map((e) => ({
    path: e.instancePath || '/',
    message: `${e.message ?? 'invalid'}${e.params && 'additionalProperty' in e.params ? `: ${String(e.params.additionalProperty)}` : ''}`,
  }));
}

/**
 * Validates payloads against the Visual Engine Contract JSON Schemas loaded from
 * contracts/visual-engine/schemas, and compiles per-workflow input schemas
 * (cached by manifest hash).
 */
export class ContractValidator {
  private readonly ajv: Ajv2020;
  private readonly paramsAjv: Ajv2020;
  private readonly validators = new Map<ContractSchemaName, ValidateFunction>();
  private readonly inputSchemaCache = new Map<string, ValidateFunction>();

  constructor(contractDir: string) {
    this.ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(this.ajv);
    const schemaDir = join(contractDir, 'schemas');
    for (const file of readdirSync(schemaDir).filter((f) => f.endsWith('.schema.json'))) {
      this.ajv.addSchema(JSON.parse(readFileSync(join(schemaDir, file), 'utf8')));
    }
    const refs: Record<ContractSchemaName, string> = {
      'engine-info': `${BASE}engine-info.schema.json`,
      'workflow-list': `${BASE}workflow-list.schema.json`,
      'workflow-manifest': `${BASE}workflow-manifest.schema.json`,
      'job-submission': `${BASE}job-submission.schema.json`,
      'job-status': `${BASE}job-status.schema.json`,
      'error-response': `${BASE}error-response.schema.json`,
      'resource-state': `${BASE}resources.schema.json#/$defs/ResourceState`,
      'release-request': `${BASE}resources.schema.json#/$defs/ReleaseRequest`,
      'release-response': `${BASE}resources.schema.json#/$defs/ReleaseResponse`,
    };
    for (const [name, ref] of Object.entries(refs) as [ContractSchemaName, string][]) {
      const fn = this.ajv.getSchema(ref);
      if (!fn) throw new Error(`contract schema ${ref} not found in ${schemaDir}`);
      this.validators.set(name, fn);
    }
    // Workflow parameter schemas are authored by Track A: compile leniently
    // (unknown keywords ignored) but with formats and all errors reported.
    this.paramsAjv = new Ajv2020({ allErrors: true, strict: false, useDefaults: false });
    addFormats(this.paramsAjv);
  }

  validate(name: ContractSchemaName, payload: unknown): ValidationResult {
    const fn = this.validators.get(name)!;
    const ok = fn(payload) as boolean;
    return { ok, violations: ok ? [] : toViolations(fn.errors) };
  }

  /** Validates job parameters against a manifest's input_schema. */
  validateParameters(manifestSha256: string, inputSchema: Record<string, unknown>, parameters: unknown): ValidationResult {
    let fn = this.inputSchemaCache.get(manifestSha256);
    if (!fn) {
      fn = this.paramsAjv.compile(inputSchema);
      this.inputSchemaCache.set(manifestSha256, fn);
    }
    const ok = fn(parameters) as boolean;
    return { ok, violations: ok ? [] : toViolations(fn.errors) };
  }

  /** Throws if an input_schema cannot be compiled (checked at registration). */
  assertCompilable(inputSchema: Record<string, unknown>): void {
    this.paramsAjv.compile(inputSchema);
  }
}
