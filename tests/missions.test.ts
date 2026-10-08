import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { WorldMap } from '../src/world/WorldMap';
import { buildMissions, MissionRuntime } from '../src/game/Missions';
import { makeRig } from './helpers/sim';
import { landingPilot } from './helpers/pilots';
import { AIRCRAFT } from '../src/aircraft/specs';
import { DEG } from '../src/core/math';

const world = new WorldMap();
const missions = buildMissions(world);

describe('mission definitions', () => {
  it('have unique ids, valid aircraft and at least one objective', () => {
    const ids = new Set(missions.map((m) => m.id));
    expect(ids.size).toBe(missions.length);
    expect(missions.length).toBeGreaterThanOrEqual(10);
    const known = new Set(AIRCRAFT.map((a) => a.id));
    for (const m of missions) {
      expect(known.has(m.aircraft)).toBe(true);
      for (const a of m.allowedAircraft ?? []) expect(known.has(a)).toBe(true);
      expect(m.stages.length).toBeGreaterThan(0);
      for (const s of m.stages) if (s.type === 'land') expect(() => world.getAirport(s.airport)).not.toThrow();
    }
  });

  it('place every ring safely above the terrain', () => {
    for (const m of missions) {
      for (const s of m.stages) {
        if (s.type !== 'rings') continue;
        for (const r of s.rings) {
          const ground = world.groundHeight(r.x, r.z);
          expect(r.y - r.radius, `${m.id} ring at ${Math.round(r.x)},${Math.round(r.z)}`).toBeGreaterThan(ground + 5);
          expect(world.obstacles.query(r.x, r.y, r.z, r.radius)).toBeNull();
        }
      }
    }
  });

  it('spawn in the air above the terrain', () => {
    for (const m of missions) {
      const sp = m.spawn;
      if (sp.kind === 'air') expect(sp.agl).toBeGreaterThan(80);
      if (sp.kind === 'approach') {
        const e = world.getAirport(sp.airport).runway.ends[sp.end];
        const x = e.x - e.dx * sp.distance;
        const z = e.z - e.dz * sp.distance;
        const alt = world.getAirport(sp.airport).elevation + Math.tan(3 * DEG) * (sp.distance + 300);
        expect(alt).toBeGreaterThan(world.groundHeight(x, z) + 60);
      }
    }
  });
});

describe('mission runtime', () => {
  it('detects rings only when flown through in order', () => {
    const def = missions.find((m) => m.id === 'harbor-rings')!;
    const rt = new MissionRuntime(def, world);
    const rig = makeRig('vortex');
    const st = def.stages[0];
    if (st.type !== 'rings') throw new Error('expected rings');
    const r0 = st.rings[0];
    const r1 = st.rings[1];
    const d = { x: Math.sin(r1.heading * DEG), z: -Math.cos(r1.heading * DEG) };
    // Fly through ring 1 first: must not count.
    rig.model.position.set(r1.x + d.x * 5, r1.y, r1.z + d.z * 5);
    rt.update(0.016, rig.model, new Vector3(r1.x - d.x * 5, r1.y, r1.z - d.z * 5));
    expect(rt.ringsPassed).toBe(0);
    // Ring 0 off-centre by more than its radius: no.
    const d0 = { x: Math.sin(r0.heading * DEG), z: -Math.cos(r0.heading * DEG) };
    rig.model.position.set(r0.x + d0.x * 5, r0.y + r0.radius * 1.5, r0.z + d0.z * 5);
    rt.update(0.016, rig.model, new Vector3(r0.x - d0.x * 5, r0.y + r0.radius * 1.5, r0.z - d0.z * 5));
    expect(rt.ringsPassed).toBe(0);
    // Ring 0 through the middle: yes.
    rig.model.position.set(r0.x + d0.x * 5, r0.y, r0.z + d0.z * 5);
    rt.update(0.016, rig.model, new Vector3(r0.x - d0.x * 5, r0.y, r0.z - d0.z * 5));
    expect(rt.ringsPassed).toBe(1);
    expect(rt.objective(rig.model).label).toBe('RING');
  });

  it('fails the mission on a crash', () => {
    const def = missions.find((m) => m.id === 'first-flight')!;
    const rt = new MissionRuntime(def, world);
    const rig = makeRig('kestrel');
    rt.onFlightEvent({ type: 'crash', reason: 'test' }, rig.model);
    expect(rt.state).toBe('failed');
    expect(rt.getResult()?.success).toBe(false);
    expect(rt.getResult()?.stars).toBe(0);
  });

  it.each([
    ['precision-landing', 'kestrel'],
    ['precision-landing', 'skyliner'],
    ['night-approach', 'skyliner'],
    ['short-field', 'kestrel'],
  ])('%s can be flown to completion in the %s', (id, ac) => {
    const def = missions.find((m) => m.id === id)!;
    const sp = def.spawn;
    if (sp.kind !== 'approach') throw new Error('expected approach spawn');
    const ap = world.getAirport(sp.airport);
    const end = ap.runway.ends[sp.end];
    const rig = makeRig(ac, 'easy', world);
    const m = rig.model;
    const spec = m.spec;
    m.gearDown = true;
    m.gearPos = 1;
    m.setFlaps(spec.flaps.detents.length - 1);
    m.flapsPos = 1;
    m.placeInAir(end.x - end.dx * sp.distance, ap.elevation + Math.tan(3 * DEG) * (sp.distance + 300), end.z - end.dz * sp.distance, end.heading, spec.speeds.approach, -3);
    rig.fcs.reset(true);
    const rt = new MissionRuntime(def, world);
    m.onEvent = (e) => rt.onFlightEvent(e, m);
    const prev = new Vector3();
    const pilot = landingPilot(rig, { x: end.x + end.dx * 300, z: end.z + end.dz * 300, dx: end.dx, dz: end.dz, elevation: ap.elevation });
    for (let t = 0; t < 400 && rt.state === 'running'; t += 0.1) {
      prev.copy(m.position);
      rig.run(0.1, pilot);
      rt.update(0.1, m, prev);
    }
    expect(m.crashed, m.crashReason).toBe(false);
    expect(rt.state, rt.failReason).toBe('success');
    const res = rt.getResult()!;
    expect(res.success).toBe(true);
    expect(res.stars).toBeGreaterThanOrEqual(2);
    expect(res.score).toBeGreaterThan(600);
  });
});
