/**
 * Evidence-bound number rendering (docs/02 P2, docs/06 §6.2).
 *
 * Agent claims never contain free-typed numbers for display. They contain
 * binding tokens of the form:
 *
 *    {ev:<evidenceId>:<digestPath>}
 *
 * The renderer substitutes the value from the evidence artifact's digest.
 * An unresolvable token renders as an explicit error — a hallucinated or
 * drifted number is structurally unrenderable.
 */

export interface BindingSegment {
  kind: 'text' | 'value' | 'error';
  text: string;
  evidenceId?: string;
  path?: string;
}

const TOKEN_RE = /\{ev:([0-9a-fA-F-]{36}):([a-zA-Z0-9_.[\]]+)\}/g;

export function resolveDigestPath(
  digest: Record<string, unknown>,
  path: string,
): unknown {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let cur: unknown = digest;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function bindClaim(
  claim: string,
  evidenceDigests: Map<string, Record<string, unknown>>,
): BindingSegment[] {
  const segments: BindingSegment[] = [];
  let lastIndex = 0;
  for (const match of claim.matchAll(TOKEN_RE)) {
    const [token, evidenceId, path] = match;
    const idx = match.index ?? 0;
    if (idx > lastIndex) {
      segments.push({ kind: 'text', text: claim.slice(lastIndex, idx) });
    }
    const digest = evidenceId ? evidenceDigests.get(evidenceId) : undefined;
    const value =
      digest && path !== undefined ? resolveDigestPath(digest, path) : undefined;
    if (value === undefined || value === null) {
      segments.push({
        kind: 'error',
        text: '[unverified value]',
        evidenceId,
        path,
      });
    } else {
      segments.push({
        kind: 'value',
        text: formatBoundValue(value),
        evidenceId,
        path,
      });
    }
    lastIndex = idx + token.length;
  }
  if (lastIndex < claim.length) {
    segments.push({ kind: 'text', text: claim.slice(lastIndex) });
  }
  return segments;
}

export function formatBoundValue(value: unknown): string {
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return value.toLocaleString('en-US');
    return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  return String(value);
}

/** True when a claim contains at least one unresolvable binding token. */
export function hasUnboundTokens(
  claim: string,
  evidenceDigests: Map<string, Record<string, unknown>>,
): boolean {
  return bindClaim(claim, evidenceDigests).some((s) => s.kind === 'error');
}
