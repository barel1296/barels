/**
 * Pure terrain chunk generation (runs inside a Web Worker, with a main-thread fallback).
 * Produces vertex data for a skirted grid chunk plus deterministic tree placements.
 */
import { CHUNK_SIZE, CELL, WorldMap } from './WorldMap';
import { Simplex2 } from './noise';
import { clamp, lerp, mulberry32, smoothstep, hash2 } from '../core/math';

export interface ChunkRequest {
  i: number;
  j: number;
  n: number;
  /** Tree candidates to test (0 = no trees). */
  trees: number;
}

export interface ChunkData {
  i: number;
  j: number;
  n: number;
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  uvs: Float32Array;
  /** Per tree: x, y, z, scale, type (0 conifer / 1 broadleaf), tint. */
  trees: Float32Array | null;
  minH: number;
  maxH: number;
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

type RGB = [number, number, number];

function hexLin(hex: number): RGB {
  return [srgbToLinear(((hex >> 16) & 255) / 255), srgbToLinear(((hex >> 8) & 255) / 255), srgbToLinear((hex & 255) / 255)];
}

const C = {
  seabed: hexLin(0x8a8466),
  sand: hexLin(0xd8c79c),
  grassA: hexLin(0x6f9a3e),
  grassB: hexLin(0x86a24c),
  dryGrass: hexLin(0xa6a35e),
  forest: hexLin(0x355a24),
  meadow: hexLin(0x7d8a4c),
  rock: hexLin(0x847c70),
  rockDark: hexLin(0x62605a),
  snow: hexLin(0xf1f3f6),
  airport: hexLin(0x76a04a),
  urban: hexLin(0x8f8d86),
};

/** Crop colours for the farmland patchwork. */
const FIELDS: RGB[] = [
  hexLin(0x8fae4e),
  hexLin(0x6c9440),
  hexLin(0xb6b06a),
  hexLin(0x9a8a5a),
  hexLin(0x7aa64a),
  hexLin(0xc4b878),
  hexLin(0x5f8a3a),
];
const FIELD_AVG: RGB = [0, 1, 2].map((k) => FIELDS.reduce((a, c) => a + c[k], 0) / FIELDS.length) as RGB;

function mix(out: RGB, b: RGB, t: number): void {
  if (t <= 0) return;
  if (t > 1) t = 1;
  out[0] += (b[0] - out[0]) * t;
  out[1] += (b[1] - out[1]) * t;
  out[2] += (b[2] - out[2]) * t;
}

const indexCache = new Map<number, Uint32Array>();
/** Index buffer for an (n+3)^2 skirted grid; shared per resolution. */
export function chunkIndices(n: number): Uint32Array {
  let idx = indexCache.get(n);
  if (idx) return idx;
  const m = n + 3;
  idx = new Uint32Array((m - 1) * (m - 1) * 6);
  let k = 0;
  for (let jz = 0; jz < m - 1; jz++) {
    for (let ix = 0; ix < m - 1; ix++) {
      const a = jz * m + ix;
      const b = a + 1;
      const c = a + m;
      const d = c + 1;
      idx[k++] = a;
      idx[k++] = c;
      idx[k++] = b;
      idx[k++] = b;
      idx[k++] = c;
      idx[k++] = d;
    }
  }
  indexCache.set(n, idx);
  return idx;
}

export class TerrainGenerator {
  readonly world: WorldMap;
  private colorNoise = new Simplex2(77);

  constructor(seed?: number) {
    this.world = new WorldMap(seed);
  }

  generate(req: ChunkRequest): ChunkData {
    const { i, j, n } = req;
    const w = this.world;
    const step = CHUNK_SIZE / n;
    const x0 = i * CHUNK_SIZE;
    const z0 = j * CHUNK_SIZE;
    const e = n + 3; // extended sample grid: indices -1..n+1
    const hExt = new Float32Array(e * e);
    let minH = Infinity;
    let maxH = -Infinity;
    for (let gz = 0; gz < e; gz++) {
      for (let gx = 0; gx < e; gx++) {
        const h = w.height(x0 + (gx - 1) * step, z0 + (gz - 1) * step);
        hExt[gz * e + gx] = h;
        if (gx >= 1 && gx <= n + 1 && gz >= 1 && gz <= n + 1) {
          if (h < minH) minH = h;
          if (h > maxH) maxH = h;
        }
      }
    }
    const count = e * e;
    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);
    const skirt = 25 + step * 0.6;
    const col: RGB = [0, 0, 0];
    const cn = this.colorNoise;
    for (let gz = 0; gz < e; gz++) {
      for (let gx = 0; gx < e; gx++) {
        const ring = gx === 0 || gz === 0 || gx === e - 1 || gz === e - 1;
        const cx = clamp(gx, 1, n + 1);
        const cz = clamp(gz, 1, n + 1);
        const lx = (cx - 1) * step;
        const lz = (cz - 1) * step;
        const h = hExt[cz * e + cx];
        const vi = gz * e + gx;
        positions[vi * 3] = lx;
        positions[vi * 3 + 1] = ring ? h - skirt : h;
        positions[vi * 3 + 2] = lz;
        // Normal from central differences on the extended grid.
        const hl = hExt[cz * e + Math.max(cx - 1, 0)];
        const hr = hExt[cz * e + Math.min(cx + 1, e - 1)];
        const hd = hExt[Math.max(cz - 1, 0) * e + cx];
        const hu = hExt[Math.min(cz + 1, e - 1) * e + cx];
        let nx = hl - hr;
        let ny = 2 * step;
        let nz = hd - hu;
        const len = Math.hypot(nx, ny, nz);
        nx /= len;
        ny /= len;
        nz /= len;
        normals[vi * 3] = nx;
        normals[vi * 3 + 1] = ny;
        normals[vi * 3 + 2] = nz;
        const wx = x0 + lx;
        const wz = z0 + lz;
        uvs[vi * 2] = wx / 28;
        uvs[vi * 2 + 1] = wz / 28;

        // ---- colour ----
        const v = cn.noise(wx / 190, wz / 190) * 0.5 + 0.5;
        const v2 = cn.noise(wx / 900 + 40, wz / 900) * 0.5 + 0.5;
        col[0] = C.grassA[0];
        col[1] = C.grassA[1];
        col[2] = C.grassA[2];
        mix(col, C.grassB, v);
        mix(col, C.dryGrass, smoothstep(0.55, 0.9, v2) * 0.6);
        const f = w.forestDensity(wx, wz);
        // Farmland patchwork in the lowlands: rotated field grid with per-field crop colour.
        const farm = smoothstep(260, 120, h) * smoothstep(0.93, 0.98, ny) * (1 - f) * smoothstep(0.35, 0.6, v2 + 0.25);
        if (farm > 0.01) {
          // Individual fields only where the mesh can resolve them; average tone further out.
          const detail = step <= 16 ? 1 : step <= 32 ? 0.6 : 0;
          let crop = FIELD_AVG;
          if (detail > 0) {
            const fx = (wx * 0.94 + wz * 0.34) / 210;
            const fz = (-wx * 0.34 + wz * 0.94) / 140;
            crop = FIELDS[hash2(Math.floor(fx), Math.floor(fz), 17) % FIELDS.length];
          }
          mix(col, FIELD_AVG, farm * 0.8 * (1 - detail));
          mix(col, crop, farm * 0.8 * detail);
        }
        if (h > 350) mix(col, C.meadow, smoothstep(350, 900, h));
        mix(col, C.forest, f * smoothstep(1500, 1100, h) * 0.9);
        if (h < 7) mix(col, C.sand, smoothstep(7, 2.5, h));
        if (h < -1.5) mix(col, C.seabed, smoothstep(-1.5, -8, h));
        const rockAmt = smoothstep(0.88, 0.7, ny) + smoothstep(1250, 1650, h) * 0.6;
        if (rockAmt > 0) {
          mix(col, C.rock, rockAmt);
          mix(col, C.rockDark, smoothstep(0.75, 0.55, ny) * 0.6 * v);
        }
        const snow = smoothstep(1380, 1560, h + v * 120) * smoothstep(0.62, 0.8, ny);
        mix(col, C.snow, snow);
        const am = w.airportMask(wx, wz);
        if (am > 0) mix(col, C.airport, smoothstep(0.2, 0.9, am));
        const cm = w.cityMask(wx, wz);
        if (cm > 0 && h > 2) mix(col, C.urban, cm * 0.75);
        const bright = 0.92 + (v - 0.5) * 0.12;
        colors[vi * 3] = col[0] * bright;
        colors[vi * 3 + 1] = col[1] * bright;
        colors[vi * 3 + 2] = col[2] * bright;
      }
    }

    const trees = req.trees > 0 ? this.trees(i, j, req.trees) : null;
    return { i, j, n, positions, normals, colors, uvs, trees, minH, maxH };
  }

  /** Deterministic tree placement for a chunk. */
  trees(i: number, j: number, candidates: number): Float32Array {
    const w = this.world;
    const rnd = mulberry32(hash2(i, j, 991));
    const out: number[] = [];
    const x0 = i * CHUNK_SIZE;
    const z0 = j * CHUNK_SIZE;
    for (let k = 0; k < candidates; k++) {
      const x = x0 + rnd() * CHUNK_SIZE;
      const z = z0 + rnd() * CHUNK_SIZE;
      const r1 = rnd();
      const r2 = rnd();
      const r3 = rnd();
      const f = w.forestDensity(x, z);
      if (r1 > f * 0.95 + 0.012) continue;
      if (w.airportMask(x, z) > 0.01) continue;
      if (w.cityMask(x, z) > 0.15) continue;
      const h = surfaceHeightFast(w, x, z);
      if (h < 5 || h > 1450) continue;
      const hx = w.height(x + 12, z) - h;
      const hz = w.height(x, z + 12) - h;
      const slope = Math.hypot(hx, hz) / 12;
      if (slope > 0.75) continue;
      const conifer = h > 500 || r2 < 0.35 ? 0 : 1;
      const scale = lerp(0.75, 1.5, r3) * (h > 900 ? 0.8 : 1);
      out.push(x, h - 0.3, z, scale, conifer, r2);
    }
    return new Float32Array(out);
  }
}

/** Surface height matching the finest render lattice (same as WorldMap.surfaceHeight). */
export function surfaceHeightFast(w: WorldMap, x: number, z: number): number {
  const gx = x / CELL;
  const gz = z / CELL;
  const ix = Math.floor(gx);
  const iz = Math.floor(gz);
  const fx = gx - ix;
  const fz = gz - iz;
  const x0 = ix * CELL;
  const z0 = iz * CELL;
  const hb = w.height(x0 + CELL, z0);
  const hc = w.height(x0, z0 + CELL);
  if (fx + fz <= 1) {
    const ha = w.height(x0, z0);
    return ha + (hb - ha) * fx + (hc - ha) * fz;
  }
  const hd = w.height(x0 + CELL, z0 + CELL);
  return hd + (hc - hd) * (1 - fx) + (hb - hd) * (1 - fz);
}

/** Coarse world heightmap (row-major, z rows) for the minimap and water depth. */
export function generateHeightmap(world: WorldMap, size: number, half: number): Float32Array {
  const out = new Float32Array(size * size);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const x = -half + ((c + 0.5) / size) * 2 * half;
      const z = -half + ((r + 0.5) / size) * 2 * half;
      out[r * size + c] = world.height(x, z);
    }
  }
  return out;
}
