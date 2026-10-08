/**
 * Analytic description of the game world: a procedural island archipelago with
 * flattened airports, approach corridors, a lake and a city. Everything here is
 * pure math (no Three.js scene objects) so physics and tests can use it.
 *
 * Conventions: +X = east, -Z = north, +Y = up. Heading 0° = north, 90° = east.
 */
import { clamp, lerp, smoothstep, mulberry32 } from '../core/math';
import { Simplex2 } from './noise';

export const CHUNK_SIZE = 2000;
/** Finest terrain grid resolution (segments per chunk). Physics samples the same lattice. */
export const FINEST_SEGMENTS = 128;
export const CELL = CHUNK_SIZE / FINEST_SEGMENTS;
export const WORLD_HALF = 24000;
export const SEA_LEVEL = 0;

export interface RunwayEnd {
  ident: string;
  /** Landing heading in degrees. */
  heading: number;
  /** Threshold position. */
  x: number;
  z: number;
  /** Unit landing direction. */
  dx: number;
  dz: number;
}

export interface Runway {
  name: string;
  x: number;
  z: number;
  heading: number;
  length: number;
  width: number;
  ends: [RunwayEnd, RunwayEnd];
  /** Unit vector along the runway (direction of `heading`). */
  ux: number;
  uz: number;
}

export interface Airport {
  code: string;
  name: string;
  elevation: number;
  runway: Runway;
  /** Which side of the runway (+1 / -1 along the perpendicular) the apron is on. */
  apronSide: number;
}

export interface CityDef {
  name: string;
  x: number;
  z: number;
  radius: number;
}

export type SurfaceType = 'water' | 'runway' | 'paved' | 'grass' | 'sand' | 'rock' | 'snow';

export function headingToDir(headingDeg: number): { x: number; z: number } {
  const h = (headingDeg * Math.PI) / 180;
  return { x: Math.sin(h), z: -Math.cos(h) };
}

export function dirToHeading(x: number, z: number): number {
  const h = (Math.atan2(x, -z) * 180) / Math.PI;
  return h < 0 ? h + 360 : h;
}

function runwayIdent(heading: number): string {
  let n = Math.round(heading / 10) % 36;
  if (n === 0) n = 36;
  return n.toString().padStart(2, '0');
}

function makeRunway(x: number, z: number, heading: number, length: number, width: number): Runway {
  const d = headingToDir(heading);
  const half = length / 2;
  const endA: RunwayEnd = {
    ident: runwayIdent(heading),
    heading,
    x: x - d.x * half,
    z: z - d.z * half,
    dx: d.x,
    dz: d.z,
  };
  const recip = (heading + 180) % 360;
  const endB: RunwayEnd = {
    ident: runwayIdent(recip),
    heading: recip,
    x: x + d.x * half,
    z: z + d.z * half,
    dx: -d.x,
    dz: -d.z,
  };
  return {
    name: `${endA.ident}/${endB.ident}`,
    x,
    z,
    heading,
    length,
    width,
    ends: [endA, endB],
    ux: d.x,
    uz: d.z,
  };
}

interface AirportSeed {
  code: string;
  name: string;
  x: number;
  z: number;
  heading: number;
  length: number;
  width: number;
  apronSide: number;
  minElevation: number;
}

const AIRPORT_SEEDS: AirportSeed[] = [
  { code: 'HBR', name: 'Harbor International', x: -3000, z: 8000, heading: 90, length: 2800, width: 45, apronSide: 1, minElevation: 9 },
  { code: 'NFD', name: 'North Field', x: -8000, z: -6500, heading: 0, length: 1800, width: 35, apronSide: 1, minElevation: 20 },
  { code: 'EGL', name: 'Eagle Peak Strip', x: 5200, z: -3900, heading: 50, length: 1100, width: 28, apronSide: -1, minElevation: 200 },
  { code: 'GUL', name: 'Gull Island', x: 19500, z: 3500, heading: 140, length: 1300, width: 30, apronSide: 1, minElevation: 12 },
];

/** Flattened pad margins around each runway. */
const PAD_END_MARGIN = 380;
const PAD_SIDE_MARGIN = 240;
const PAD_BLEND = 650;

export interface Obstacle {
  /** Axis-aligned box: center x/z, half sizes, base and top heights. */
  x: number;
  z: number;
  hx: number;
  hz: number;
  y0: number;
  y1: number;
  kind: 'building' | 'tree';
}

/**
 * Spatial hash of obstacles for collision queries.
 */
export class ObstacleGrid {
  private cells = new Map<number, Obstacle[]>();
  constructor(private cellSize = 100) {}

  private key(ix: number, iz: number): number {
    return (ix + 2048) * 4096 + (iz + 2048);
  }

  add(o: Obstacle): void {
    const cs = this.cellSize;
    const x0 = Math.floor((o.x - o.hx) / cs);
    const x1 = Math.floor((o.x + o.hx) / cs);
    const z0 = Math.floor((o.z - o.hz) / cs);
    const z1 = Math.floor((o.z + o.hz) / cs);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const k = this.key(ix, iz);
        let list = this.cells.get(k);
        if (!list) {
          list = [];
          this.cells.set(k, list);
        }
        list.push(o);
      }
    }
  }

  removeWhere(pred: (o: Obstacle) => boolean, x0: number, z0: number, x1: number, z1: number): void {
    const cs = this.cellSize;
    for (let ix = Math.floor(x0 / cs); ix <= Math.floor(x1 / cs); ix++) {
      for (let iz = Math.floor(z0 / cs); iz <= Math.floor(z1 / cs); iz++) {
        const k = this.key(ix, iz);
        const list = this.cells.get(k);
        if (!list) continue;
        const kept = list.filter((o) => !pred(o));
        if (kept.length) this.cells.set(k, kept);
        else this.cells.delete(k);
      }
    }
  }

  /** Returns the first obstacle intersecting a sphere at (x,y,z) with radius r, or null. */
  query(x: number, y: number, z: number, r: number): Obstacle | null {
    const cs = this.cellSize;
    const ix0 = Math.floor((x - r) / cs);
    const ix1 = Math.floor((x + r) / cs);
    const iz0 = Math.floor((z - r) / cs);
    const iz1 = Math.floor((z + r) / cs);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const list = this.cells.get(this.key(ix, iz));
        if (!list) continue;
        for (const o of list) {
          const dx = Math.max(Math.abs(x - o.x) - o.hx, 0);
          const dz = Math.max(Math.abs(z - o.z) - o.hz, 0);
          const dy = y < o.y0 ? o.y0 - y : y > o.y1 ? y - o.y1 : 0;
          if (dx * dx + dy * dy + dz * dz < r * r) return o;
        }
      }
    }
    return null;
  }

  get size(): number {
    let n = 0;
    for (const l of this.cells.values()) n += l.length;
    return n;
  }
}

export class WorldMap {
  readonly seed: number;
  readonly airports: Airport[] = [];
  readonly city: CityDef = { name: 'Port Harbor', x: 4200, z: 9300, radius: 2000 };
  readonly obstacles = new ObstacleGrid(100);
  private n: Simplex2;
  private n2: Simplex2;

  constructor(seed = 20240917) {
    this.seed = seed;
    this.n = new Simplex2(seed);
    this.n2 = new Simplex2(seed * 7 + 3);
    // Airports take the average natural elevation of their site.
    for (const s of AIRPORT_SEEDS) {
      const rw = makeRunway(s.x, s.z, s.heading, s.length, s.width);
      let sum = 0;
      let count = 0;
      for (let i = -4; i <= 4; i++) {
        for (let j = -2; j <= 2; j++) {
          const u = (i / 4) * (s.length / 2);
          const v = (j / 2) * (s.width / 2 + 100);
          sum += this.naturalHeight(s.x + rw.ux * u - rw.uz * v, s.z + rw.uz * u + rw.ux * v);
          count++;
        }
      }
      const elevation = Math.round(Math.max(s.minElevation, sum / count));
      this.airports.push({ code: s.code, name: s.name, elevation, runway: rw, apronSide: s.apronSide });
    }
  }

  /** Terrain before airports/corridors are carved in. */
  naturalHeight(x: number, z: number): number {
    const n = this.n;
    // Domain-warped elliptical island mask.
    const wx = x + 3200 * n.fbm(x / 15000 + 3.1, z / 15000 - 1.7, 3);
    const wz = z + 3200 * n.fbm(x / 15000 - 5.3, z / 15000 + 2.9, 3);
    const ex = wx / 16500;
    const ez = wz / 13500;
    const d = Math.sqrt(ex * ex + ez * ez);
    const land = 1 - smoothstep(0.72, 1.08, d);

    let h = lerp(-160, 4, land);
    // Rolling hills.
    h += land * (42 + 70 * n.fbm(x / 3800, z / 3800, 5));
    // Small-scale roughness.
    h += land * 9 * n.fbm(x / 600, z / 600, 3);

    // Mountain range across the north-east.
    const mx = (x - 4500) / 9500;
    const mz = (z + 3800) / 6500;
    const md = Math.sqrt(mx * mx + mz * mz);
    const mountainMask = (1 - smoothstep(0.3, 1.1, md)) * land;
    if (mountainMask > 0.001) {
      const r = n.ridged(x / 5200 + 7.7, z / 5200 - 3.3, 6);
      h += mountainMask * (r * r * 2600 + 180 * n.fbm(x / 1700, z / 1700, 4) + 160);
    }

    // Inland lake.
    const lx = x + 6200;
    const lz = z - 1600;
    const ld = Math.sqrt(lx * lx + lz * lz * 1.4) + 250 * this.n2.noise(x / 1500, z / 1500);
    const lake = 1 - smoothstep(600, 2000, ld);
    h -= lake * 130;

    // Gull Island to the east.
    const gx = x - 19300;
    const gz = z - 3600;
    const gd = Math.sqrt(gx * gx + gz * gz) + 500 * this.n2.noise(x / 2200 + 4, z / 2200);
    const islet = 1 - smoothstep(0, 3200, gd);
    if (islet > 0) {
      const hi = -150 + islet * 220 + islet * 30 * n.fbm(x / 900, z / 900, 3);
      h = Math.max(h, hi);
    }

    // Gentle the city area.
    const cx = x - this.city.x;
    const cz = z - this.city.z;
    const cd = Math.sqrt(cx * cx + cz * cz);
    const cityMask = 1 - smoothstep(this.city.radius * 0.6, this.city.radius * 1.3, cd);
    if (cityMask > 0 && h > 0) {
      h = lerp(h, 12 + h * 0.15, cityMask * 0.85);
    }
    return h;
  }

  /** Final terrain height (analytic, smooth). */
  height(x: number, z: number): number {
    let h = this.naturalHeight(x, z);
    for (const ap of this.airports) {
      const rw = ap.runway;
      // Approach corridors: keep terrain below a 2.2° slope off each runway end.
      for (const e of rw.ends) {
        const rx = x - e.x;
        const rz = z - e.z;
        const s = -(rx * e.dx + rz * e.dz);
        if (s > 0 && s < 9000) {
          const lat = Math.abs(rx * e.dz - rz * e.dx);
          const width = 350 + s * 0.13;
          const cm = (1 - smoothstep(width * 0.55, width, lat)) * smoothstep(9000, 6500, s);
          const limit = ap.elevation + 15 + s * 0.038;
          if (h > limit && cm > 0) h -= cm * (h - limit);
        }
      }
      // Flat pad.
      const m = this.padMask(ap, x, z);
      if (m > 0) h = lerp(h, ap.elevation, m);
    }
    return h;
  }

  /** 1 on an airport pad, blending to 0 outside. */
  padMask(ap: Airport, x: number, z: number): number {
    const rw = ap.runway;
    const rx = x - rw.x;
    const rz = z - rw.z;
    const u = rx * rw.ux + rz * rw.uz;
    const v = -rx * rw.uz + rz * rw.ux;
    const hl = rw.length / 2 + PAD_END_MARGIN;
    const hw = rw.width / 2 + PAD_SIDE_MARGIN;
    const du = Math.max(Math.abs(u) - hl, 0);
    const dv = Math.max(Math.abs(v) - hw, 0);
    const dist = Math.sqrt(du * du + dv * dv);
    return 1 - smoothstep(0, PAD_BLEND, dist);
  }

  /** Max pad mask over all airports. */
  airportMask(x: number, z: number): number {
    let m = 0;
    for (const ap of this.airports) m = Math.max(m, this.padMask(ap, x, z));
    return m;
  }

  cityMask(x: number, z: number): number {
    const dx = x - this.city.x;
    const dz = z - this.city.z;
    return 1 - smoothstep(this.city.radius * 0.5, this.city.radius, Math.sqrt(dx * dx + dz * dz));
  }

  /** Forest density in [0,1]. */
  forestDensity(x: number, z: number): number {
    const f = this.n2.fbm(x / 2600 + 13, z / 2600 - 21, 4);
    return smoothstep(-0.05, 0.35, f);
  }

  /**
   * Height on the finest render lattice using the same triangulation as the terrain mesh,
   * so the aircraft sits exactly on what is drawn.
   */
  surfaceHeight(x: number, z: number): number {
    const gx = x / CELL;
    const gz = z / CELL;
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = gx - ix;
    const fz = gz - iz;
    const x0 = ix * CELL;
    const z0 = iz * CELL;
    const hb = this.height(x0 + CELL, z0);
    const hc = this.height(x0, z0 + CELL);
    if (fx + fz <= 1) {
      const ha = this.height(x0, z0);
      return ha + (hb - ha) * fx + (hc - ha) * fz;
    }
    const hd = this.height(x0 + CELL, z0 + CELL);
    return hd + (hc - hd) * (1 - fx) + (hb - hd) * (1 - fz);
  }

  /** Height of whatever the aircraft would touch: terrain, or the sea surface. */
  groundHeight(x: number, z: number): number {
    return Math.max(this.surfaceHeight(x, z), SEA_LEVEL);
  }

  /** Terrain normal (unit) from central differences of the analytic height. */
  normal(x: number, z: number, out: { x: number; y: number; z: number }, eps = CELL): typeof out {
    const hx = this.height(x + eps, z) - this.height(x - eps, z);
    const hz = this.height(x, z + eps) - this.height(x, z - eps);
    const nx = -hx;
    const ny = 2 * eps;
    const nz = -hz;
    const len = Math.hypot(nx, ny, nz);
    out.x = nx / len;
    out.y = ny / len;
    out.z = nz / len;
    return out;
  }

  isWater(x: number, z: number): boolean {
    return this.surfaceHeight(x, z) < SEA_LEVEL;
  }

  /** Returns the runway (and airport) whose paved surface contains the point, if any. */
  runwayAt(x: number, z: number, margin = 0): Airport | null {
    for (const ap of this.airports) {
      const rw = ap.runway;
      const rx = x - rw.x;
      const rz = z - rw.z;
      const u = rx * rw.ux + rz * rw.uz;
      const v = -rx * rw.uz + rz * rw.ux;
      if (Math.abs(u) <= rw.length / 2 + margin && Math.abs(v) <= rw.width / 2 + margin) return ap;
    }
    return null;
  }

  /** True if the point lies on the taxiway / apron of an airport. */
  isPavedArea(x: number, z: number): boolean {
    for (const ap of this.airports) {
      const rw = ap.runway;
      const rx = x - rw.x;
      const rz = z - rw.z;
      const u = rx * rw.ux + rz * rw.uz;
      const v = (-rx * rw.uz + rz * rw.ux) * ap.apronSide;
      const tax = taxiwayLayout(rw);
      if (Math.abs(u) <= rw.length / 2 && v >= tax.offset - tax.width / 2 && v <= tax.offset + tax.width / 2) return true;
      if (Math.abs(u - tax.apronU) <= tax.apronLength / 2 && v >= tax.offset && v <= tax.offset + tax.apronDepth) return true;
    }
    return false;
  }

  surfaceType(x: number, z: number): SurfaceType {
    if (this.runwayAt(x, z)) return 'runway';
    if (this.isPavedArea(x, z)) return 'paved';
    const h = this.surfaceHeight(x, z);
    if (h < SEA_LEVEL) return 'water';
    if (h < 5 && this.airportMask(x, z) < 0.5) return 'sand';
    if (h > 1450) return 'snow';
    return 'grass';
  }

  /** Nearest airport to a point (horizontal distance). */
  nearestAirport(x: number, z: number): { airport: Airport; distance: number } {
    let best = this.airports[0];
    let bd = Infinity;
    for (const ap of this.airports) {
      const d = Math.hypot(ap.runway.x - x, ap.runway.z - z);
      if (d < bd) {
        bd = d;
        best = ap;
      }
    }
    return { airport: best, distance: bd };
  }

  getAirport(code: string): Airport {
    const ap = this.airports.find((a) => a.code === code);
    if (!ap) throw new Error(`Unknown airport ${code}`);
    return ap;
  }

  /** Deterministic RNG for world decoration. */
  rng(salt: number): () => number {
    return mulberry32((this.seed ^ (salt * 2654435761)) >>> 0);
  }

  /** Normalised [0..1] coordinate helpers for map rendering. */
  static toMap(x: number, z: number): { u: number; v: number } {
    return { u: clamp((x + WORLD_HALF) / (2 * WORLD_HALF), 0, 1), v: clamp((z + WORLD_HALF) / (2 * WORLD_HALF), 0, 1) };
  }
}

/** Taxiway/apron layout relative to a runway (perpendicular offset measured toward the apron side). */
export function taxiwayLayout(rw: Runway): {
  offset: number;
  width: number;
  apronU: number;
  apronLength: number;
  apronDepth: number;
} {
  const offset = rw.width / 2 + 75;
  return {
    offset,
    width: 20,
    apronU: -rw.length * 0.12,
    apronLength: Math.min(520, rw.length * 0.35),
    apronDepth: 120,
  };
}
