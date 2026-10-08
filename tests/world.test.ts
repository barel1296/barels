import { describe, expect, it } from 'vitest';
import { CELL, CHUNK_SIZE, ObstacleGrid, WorldMap, WORLD_HALF, headingToDir, dirToHeading } from '../src/world/WorldMap';
import { TerrainGenerator, chunkIndices, generateHeightmap } from '../src/world/terrainGen';
import { Simplex2 } from '../src/world/noise';
import { Environment } from '../src/world/Environment';
import { Vector3 } from 'three';

const world = new WorldMap();

describe('noise', () => {
  it('is deterministic for a seed and bounded', () => {
    const a = new Simplex2(7);
    const b = new Simplex2(7);
    const c = new Simplex2(8);
    let diff = 0;
    for (let i = 0; i < 200; i++) {
      const x = i * 0.37;
      const y = i * -0.21;
      expect(a.noise(x, y)).toBe(b.noise(x, y));
      diff += Math.abs(a.noise(x, y) - c.noise(x, y));
      expect(Math.abs(a.fbm(x, y, 5))).toBeLessThanOrEqual(1.01);
      const r = a.ridged(x, y, 5);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(1);
    }
    expect(diff).toBeGreaterThan(1);
  });
});

describe('world map', () => {
  it('is deterministic', () => {
    const w2 = new WorldMap();
    for (const [x, z] of [[0, 0], [1234, -5678], [-9000, 3000]]) expect(w2.height(x, z)).toBe(world.height(x, z));
  });

  it('heading helpers round-trip', () => {
    for (const h of [0, 45, 90, 180, 270, 359]) {
      const d = headingToDir(h);
      expect(dirToHeading(d.x, d.z)).toBeCloseTo(h, 6);
    }
  });

  it('is an island surrounded by sea', () => {
    for (const [x, z] of [[-WORLD_HALF + 200, -WORLD_HALF + 200], [WORLD_HALF - 200, 0], [0, WORLD_HALF - 200]]) {
      expect(world.isWater(x, z)).toBe(true);
    }
    expect(world.isWater(world.city.x, world.city.z)).toBe(false);
    // Mountains exist.
    let maxH = 0;
    for (let x = -10000; x <= 15000; x += 400) for (let z = -12000; z <= 6000; z += 400) maxH = Math.max(maxH, world.height(x, z));
    expect(maxH).toBeGreaterThan(1200);
  });

  it('has four airports on flat, dry pads with valid runways', () => {
    expect(world.airports.map((a) => a.code).sort()).toEqual(['EGL', 'GUL', 'HBR', 'NFD']);
    for (const ap of world.airports) {
      const rw = ap.runway;
      expect(ap.elevation).toBeGreaterThan(5);
      for (let k = 0; k <= 20; k++) {
        const f = (k - 10) / 20.5;
        for (const v of [-rw.width / 2 + 0.5, 0, rw.width / 2 - 0.5]) {
          const x = rw.x + rw.ux * rw.length * f - rw.uz * v;
          const z = rw.z + rw.uz * rw.length * f + rw.ux * v;
          expect(world.height(x, z)).toBeCloseTo(ap.elevation, 1);
          expect(world.surfaceHeight(x, z)).toBeCloseTo(ap.elevation, 1);
          expect(world.surfaceType(x, z)).toBe('runway');
          expect(world.runwayAt(x, z)?.code).toBe(ap.code);
        }
      }
      // Runway idents are reciprocal.
      const [a, b] = rw.ends;
      expect(Math.abs(((a.heading - b.heading + 540) % 360) - 180)).toBeCloseTo(180, 6);
      expect(Number(a.ident) * 10).toBeCloseTo(a.heading === 0 ? 360 : a.heading, -1);
    }
  });

  it('keeps every approach path clear of terrain (3° glide path, 6 km)', () => {
    for (const ap of world.airports) {
      for (const e of ap.runway.ends) {
        for (let s = 300; s <= 6000; s += 100) {
          const x = e.x - e.dx * s;
          const z = e.z - e.dz * s;
          const pathAlt = ap.elevation + Math.tan((3 * Math.PI) / 180) * (s + 300);
          expect(world.groundHeight(x, z), `${ap.code} ${e.ident} at ${s} m`).toBeLessThan(pathAlt - 10);
        }
      }
    }
  });

  it('surface height matches the finest render mesh exactly at lattice points', () => {
    const gen = new TerrainGenerator();
    const d = gen.generate({ i: -2, j: 3, n: 128, trees: 0 });
    const e = d.n + 3;
    const x0 = -2 * CHUNK_SIZE;
    const z0 = 3 * CHUNK_SIZE;
    for (const [gx, gz] of [[1, 1], [10, 20], [64, 64], [129, 129], [37, 101]]) {
      const vi = gz * e + gx;
      const lx = d.positions[vi * 3];
      const ly = d.positions[vi * 3 + 1];
      const lz = d.positions[vi * 3 + 2];
      expect(world.surfaceHeight(x0 + lx, z0 + lz)).toBeCloseTo(ly, 3);
    }
    // Interpolation inside a cell lies between its corner heights.
    const h = world.surfaceHeight(x0 + CELL * 10.3, z0 + CELL * 20.6);
    const corners = [world.height(x0 + CELL * 10, z0 + CELL * 20), world.height(x0 + CELL * 11, z0 + CELL * 20), world.height(x0 + CELL * 10, z0 + CELL * 21), world.height(x0 + CELL * 11, z0 + CELL * 21)];
    expect(h).toBeGreaterThanOrEqual(Math.min(...corners) - 1e-6);
    expect(h).toBeLessThanOrEqual(Math.max(...corners) + 1e-6);
  });
});

describe('terrain generation', () => {
  const gen = new TerrainGenerator();
  it('produces consistent skirted chunk buffers', () => {
    const d = gen.generate({ i: 0, j: 2, n: 32, trees: 600 });
    const verts = (d.n + 3) ** 2;
    expect(d.positions.length).toBe(verts * 3);
    expect(d.normals.length).toBe(verts * 3);
    expect(d.colors.length).toBe(verts * 3);
    expect(d.uvs.length).toBe(verts * 2);
    for (let k = 0; k < verts; k++) {
      const n = Math.hypot(d.normals[k * 3], d.normals[k * 3 + 1], d.normals[k * 3 + 2]);
      expect(n).toBeCloseTo(1, 4);
      for (let c = 0; c < 3; c++) {
        expect(d.colors[k * 3 + c]).toBeGreaterThanOrEqual(0);
        expect(d.colors[k * 3 + c]).toBeLessThanOrEqual(1);
      }
    }
    const idx = chunkIndices(d.n);
    expect(idx.length).toBe((d.n + 2) ** 2 * 6);
    expect(Math.max(...idx)).toBe(verts - 1);
    expect(d.maxH).toBeGreaterThanOrEqual(d.minH);
  });

  it('places trees only on dry land away from airports', () => {
    const d = gen.generate({ i: -3, j: -1, n: 64, trees: 2500 });
    expect(d.trees).not.toBeNull();
    const t = d.trees!;
    expect(t.length % 6).toBe(0);
    for (let k = 0; k < t.length; k += 6) {
      expect(t[k + 1]).toBeGreaterThan(3);
      expect(world.airportMask(t[k], t[k + 2])).toBeLessThan(0.02);
    }
  });

  it('builds a coarse world heightmap', () => {
    const hm = generateHeightmap(world, 32, WORLD_HALF);
    expect(hm.length).toBe(32 * 32);
    expect(Math.min(...hm)).toBeLessThan(0);
    expect(Math.max(...hm)).toBeGreaterThan(100);
  });
});

describe('obstacles', () => {
  it('finds intersecting boxes only', () => {
    const g = new ObstacleGrid(50);
    g.add({ x: 100, z: 100, hx: 10, hz: 10, y0: 0, y1: 40, kind: 'building' });
    expect(g.query(100, 20, 100, 1)?.kind).toBe('building');
    expect(g.query(100, 60, 100, 5)).toBeNull();
    expect(g.query(115, 20, 100, 6)?.kind).toBe('building');
    expect(g.query(130, 20, 100, 6)).toBeNull();
    g.removeWhere((o) => o.kind === 'building', 0, 0, 200, 200);
    expect(g.query(100, 20, 100, 1)).toBeNull();
  });
});

describe('environment', () => {
  it('derives wind, fog and lighting from presets', () => {
    const e = new Environment({ time: 'day', weather: 'storm', windSpeed: 10, windFrom: 270 });
    // Wind from the west blows toward the east (+X).
    expect(e.wind.x).toBeCloseTo(10, 5);
    expect(Math.abs(e.wind.z)).toBeLessThan(1e-6);
    expect(e.fogDensity).toBeGreaterThan(new Environment({ time: 'day', weather: 'clear' }).fogDensity);
    const n = new Environment({ time: 'night', weather: 'clear' });
    expect(n.night).toBe(1);
    expect(n.lightDir.y).toBeGreaterThan(0);
    const rw = e.runwayWind(270);
    expect(rw.headwind).toBeCloseTo(10, 5);
    expect(rw.crosswind).toBeCloseTo(0, 5);
    const out = new Vector3();
    e.sampleWind(new Vector3(0, 500, 0), 400, 12.3, out);
    expect(Number.isFinite(out.x + out.y + out.z)).toBe(true);
  });
});
