/** SemVer 2.0.0 parsing and the small range language used by workflow bindings. */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

export function parseSemver(version: string): SemVer | null {
  const m = SEMVER_RE.exec(version);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ?? null };
}

function comparePrerelease(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1; // release > prerelease
  if (b === null) return -1;
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return Math.sign(d);
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export function compareSemver(a: SemVer, b: SemVer): number {
  return (
    Math.sign(a.major - b.major) ||
    Math.sign(a.minor - b.minor) ||
    Math.sign(a.patch - b.patch) ||
    comparePrerelease(a.prerelease, b.prerelease)
  );
}

/**
 * Supported ranges:
 *   "1.2.3"   exact (the only form that can select a prerelease)
 *   "^1.2" / "^1.2.3"  same MAJOR, >= the given version (never crosses a MAJOR)
 *   "~1.2" / "~1.2.3"  same MAJOR.MINOR, >= the given version
 */
export function isValidRange(range: string): boolean {
  return parseRange(range) !== null;
}

interface ParsedRange {
  op: 'exact' | 'caret' | 'tilde';
  base: SemVer;
}

function parseRange(range: string): ParsedRange | null {
  const trimmed = range.trim();
  const op = trimmed.startsWith('^') ? 'caret' : trimmed.startsWith('~') ? 'tilde' : 'exact';
  let body = op === 'exact' ? trimmed : trimmed.slice(1);
  if (op !== 'exact' && /^\d+\.\d+$/.test(body)) body = `${body}.0`;
  const base = parseSemver(body);
  if (!base) return null;
  if (op !== 'exact' && base.prerelease !== null) return null;
  return { op, base };
}

export function satisfies(version: string, range: string): boolean {
  const v = parseSemver(version);
  const r = parseRange(range);
  if (!v || !r) return false;
  if (r.op === 'exact') return compareSemver(v, r.base) === 0;
  if (v.prerelease !== null) return false;
  if (v.major !== r.base.major) return false;
  if (r.op === 'tilde' && v.minor !== r.base.minor) return false;
  return compareSemver(v, r.base) >= 0;
}

/** Highest version satisfying the range, or null. */
export function maxSatisfying(versions: string[], range: string): string | null {
  let best: { raw: string; v: SemVer } | null = null;
  for (const raw of versions) {
    if (!satisfies(raw, range)) continue;
    const v = parseSemver(raw)!;
    if (!best || compareSemver(v, best.v) > 0) best = { raw, v };
  }
  return best?.raw ?? null;
}
