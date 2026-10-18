import type { ContractValidator } from '../contract/validator.js';
import { ComfyClient } from './comfy-client.js';
import { loadPackages } from './packages.js';

/**
 * Read-only discovery of an existing ComfyUI installation for deployment:
 * which URL answers, ComfyUI/Python versions, GPU and VRAM, how many node
 * types are installed, and whether Track A's workflow packages can run there
 * (missing node types, values a loader does not list). It never writes to
 * ComfyUI and never changes models, custom nodes, workflows or settings.
 */
export interface DiscoveryResult {
  url: string;
  reachable: boolean;
  error?: string;
  comfyui_version?: string | null;
  python_version?: string | null;
  pytorch_version?: string | null;
  embedded_python?: boolean | null;
  os?: string | null;
  devices?: { name: string; type: string; vram_total_mb: number; vram_free_mb: number }[];
  node_types?: number;
}

const MB = 1024 * 1024;

export async function discoverComfy(urls: string[]): Promise<DiscoveryResult[]> {
  const out: DiscoveryResult[] = [];
  for (const raw of urls) {
    const url = raw.replace(/\/+$/, '');
    const c = new ComfyClient(url, 3000);
    try {
      const s = await c.systemStats();
      let nodeTypes: number | undefined;
      try {
        nodeTypes = Object.keys(await new ComfyClient(url, 30_000).objectInfo()).length;
      } catch {
        nodeTypes = undefined;
      }
      out.push({
        url,
        reachable: true,
        comfyui_version: s.system?.comfyui_version ?? null,
        python_version: s.system?.python_version ?? null,
        pytorch_version: s.system?.pytorch_version ?? null,
        embedded_python: s.system?.embedded_python ?? null,
        os: s.system?.os ?? null,
        devices: (s.devices ?? []).map((d) => ({ name: d.name, type: d.type, vram_total_mb: Math.round(d.vram_total / MB), vram_free_mb: Math.round(d.vram_free / MB) })),
        ...(nodeTypes !== undefined ? { node_types: nodeTypes } : {}),
      });
    } catch (err) {
      out.push({ url, reachable: false, error: (err as Error).message });
    }
  }
  return out;
}

export interface PackageCheck {
  workflow: string;
  ok: boolean;
  missing_node_types: string[];
  values_not_available: { node: string; input: string; value: string }[];
  warnings: string[];
}

/** Checks Track A's packages against the node catalogue of a running ComfyUI (read-only /object_info). */
export async function checkPackagesAgainstComfy(url: string, packagesDir: string, validator: ContractValidator): Promise<{ packages: PackageCheck[]; rejected: { dir: string; error: string }[] }> {
  const info = (await new ComfyClient(url.replace(/\/+$/, ''), 60_000).objectInfo()) as Record<string, { input?: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> } }>;
  const { packages, errors } = loadPackages(packagesDir, validator);
  const results: PackageCheck[] = [];
  for (const [id, pkg] of packages) {
    const missing = new Set<string>();
    const unavailable: PackageCheck['values_not_available'] = [];
    for (const [nodeId, node] of Object.entries(pkg.graph)) {
      const spec = info[node.class_type];
      if (!spec) {
        missing.add(node.class_type);
        continue;
      }
      const inputs = { ...(spec.input?.required ?? {}), ...(spec.input?.optional ?? {}) };
      for (const [name, value] of Object.entries(node.inputs)) {
        const allowed = inputs[name]?.[0];
        if (Array.isArray(allowed) && typeof value === 'string' && !allowed.includes(value)) {
          // Bound inputs are replaced per job, so only unbound fixed values must already exist.
          const bound =
            Object.values(pkg.bindings.parameters ?? {}).some((ts) => ts.some((t) => t.node === nodeId && t.input === name)) ||
            Object.values(pkg.bindings.references ?? {}).some((ts) => ts.some((t) => t.node === nodeId && t.input === name)) ||
            (pkg.bindings.adapters ?? []).some((t) => t.node === nodeId && t.input === name);
          if (!bound) unavailable.push({ node: nodeId, input: name, value });
        }
      }
    }
    results.push({ workflow: id, ok: missing.size === 0 && unavailable.length === 0, missing_node_types: [...missing], values_not_available: unavailable, warnings: pkg.warnings });
  }
  return { packages: results, rejected: errors };
}
