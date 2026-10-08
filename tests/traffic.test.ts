import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { WorldMap } from '../src/world/WorldMap';
import { trafficRoutes } from '../src/game/Traffic';
import { buildMissions } from '../src/game/Missions';
import { getAircraft } from '../src/aircraft/specs';

const world = new WorldMap();
const routes = trafficRoutes(world);
const missions = buildMissions(world);

describe('air traffic routes', () => {
  it('use known aircraft at sensible speeds', () => {
    expect(routes.length).toBeGreaterThanOrEqual(3);
    for (const r of routes) {
      const spec = getAircraft(r.aircraft);
      expect(spec.id).toBe(r.aircraft);
      expect(r.speed).toBeGreaterThan(spec.speeds.stall * 1.3);
      expect(r.speed).toBeLessThan(spec.limits.vne);
    }
  });

  it('stay well above the terrain everywhere', () => {
    const p = new Vector3();
    for (const r of routes) {
      for (let k = 0; k < 600; k++) {
        r.curve.getPointAt(k / 600, p);
        expect(p.y - world.groundHeight(p.x, p.z), `${r.id} at ${Math.round(p.x)},${Math.round(p.z)}`).toBeGreaterThan(150);
      }
    }
  });

  it('keep clear of every mission ring', () => {
    const p = new Vector3();
    for (const m of missions) {
      for (const s of m.stages) {
        if (s.type !== 'rings') continue;
        for (const ring of s.rings) {
          for (const r of routes) {
            let min = Infinity;
            for (let k = 0; k < 800; k++) {
              r.curve.getPointAt(k / 800, p);
              min = Math.min(min, p.distanceTo(new Vector3(ring.x, ring.y, ring.z)));
            }
            expect(min, `${r.id} vs ${m.id}`).toBeGreaterThan(ring.radius + 100);
          }
        }
      }
    }
  });

  it('turn gently enough for a coordinated bank', () => {
    const t = new Vector3();
    const t2 = new Vector3();
    for (const r of routes) {
      const len = r.curve.getLength();
      let maxBank = 0;
      for (let k = 0; k < 400; k++) {
        r.curve.getTangentAt(k / 400, t);
        r.curve.getTangentAt((k / 400 + 40 / len) % 1, t2);
        const kappa = t2.sub(t).length() / 40;
        maxBank = Math.max(maxBank, Math.atan((r.speed * r.speed * kappa) / 9.81));
      }
      expect(maxBank * 57.3, r.id).toBeLessThan(70);
    }
  });
});
