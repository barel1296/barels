import { describe, expect, it } from 'vitest';
import { makeRig } from './helpers/sim';
import { landingPilot } from './helpers/pilots';
import { AIRCRAFT } from '../src/aircraft/specs';
import { DEG, KTS_PER_MS } from '../src/core/math';
import { density, speedOfSound } from '../src/physics/atmosphere';

describe('atmosphere', () => {
  it('matches ISA reference values', () => {
    expect(density(0)).toBeCloseTo(1.225, 3);
    expect(density(5000)).toBeCloseTo(0.736, 2);
    expect(density(11000)).toBeCloseTo(0.364, 2);
    expect(speedOfSound(0)).toBeCloseTo(340.3, 0);
  });
});

describe.each(AIRCRAFT.map((a) => [a.id, a] as const))('%s flight model', (id, spec) => {
  it('rests on its landing gear without drifting', () => {
    const r = makeRig(id);
    r.model.placeOnGround(r.world, 0, 0, 90);
    r.run(5, () => ({ throttle: 0, brake: 1 }));
    expect(r.model.crashed).toBe(false);
    expect(r.model.wheelsOnGround).toBe(spec.gear.points.length);
    expect(r.model.velocity.length()).toBeLessThan(0.05);
    expect(Math.abs(r.model.telemetry.pitch)).toBeLessThan(3);
    expect(r.model.telemetry.gLoad).toBeCloseTo(1, 1);
  });

  it('takes off within a reasonable distance and climbs', () => {
    const r = makeRig(id, 'realistic');
    const m = r.model;
    m.placeOnGround(r.world, 0, 0, 0);
    m.setFlaps(1);
    let liftoffDist = -1;
    m.onEvent = (e) => {
      if (e.type === 'liftoff' && liftoffDist < 0) liftoffDist = -m.position.z;
    };
    r.run(60, (rr) => {
      const t = rr.model.telemetry;
      let pitch = 0;
      if (t.ias > spec.speeds.rotate) pitch = Math.max(-1, Math.min(1, (10 - t.pitch) * 0.08 - rr.model.omega.y * 0.5));
      return { throttle: 1, pitch, roll: -t.bank * 0.03 };
    });
    expect(m.crashed).toBe(false);
    expect(liftoffDist).toBeGreaterThan(50);
    expect(liftoffDist).toBeLessThan(2000);
    expect(m.position.y).toBeGreaterThan(150);
  });

  it('holds altitude hands-off in the easy (fly-by-wire) model', () => {
    const r = makeRig(id, 'easy');
    const m = r.model;
    m.gearDown = !spec.gear.retractable;
    m.gearPos = m.gearDown ? 1 : 0;
    m.placeInAir(0, 1500, 0, 90, spec.speeds.cruise, 0);
    r.fcs.reset(true);
    r.run(30, () => ({ throttle: 0.6 }));
    expect(m.crashed).toBe(false);
    expect(Math.abs(m.position.y - 1500)).toBeLessThan(40);
    expect(Math.abs(m.telemetry.bank)).toBeLessThan(2);
  });

  it('holds a bank angle and stays coordinated after the stick is released', () => {
    const r = makeRig(id, 'easy');
    const m = r.model;
    m.gearDown = !spec.gear.retractable;
    m.gearPos = m.gearDown ? 1 : 0;
    m.placeInAir(0, 2000, 0, 90, spec.speeds.cruise, 0);
    r.fcs.reset(true);
    // Roll right until ~30° bank, then release.
    r.run(20, (rr) => ({ throttle: 0.65, roll: rr.model.telemetry.bank < 30 && !rr.events.includes('released') ? 0.5 : (rr.events.push('released'), 0) }));
    expect(m.crashed).toBe(false);
    expect(m.telemetry.bank).toBeGreaterThan(20);
    expect(m.telemetry.bank).toBeLessThan(45);
    expect(Math.abs(m.telemetry.beta / DEG)).toBeLessThan(2);
    expect(Math.abs(m.position.y - 2000)).toBeLessThan(120);
  });

  it('autopilot captures heading, altitude and speed', () => {
    const r = makeRig(id, 'easy');
    const m = r.model;
    m.gearDown = !spec.gear.retractable;
    m.gearPos = m.gearDown ? 1 : 0;
    m.placeInAir(0, 1000, 0, 0, spec.speeds.cruise, 0);
    r.fcs.reset(true);
    r.run(1, () => ({ throttle: 0.6 }));
    expect(r.fcs.engageAutopilot(m)).toBe(true);
    r.fcs.autopilot.heading = 60;
    r.fcs.autopilot.altitude = 1200;
    r.fcs.autopilot.speed = spec.speeds.cruise;
    r.run(120);
    expect(r.fcs.autopilot.engaged).toBe(true);
    expect(Math.abs(m.telemetry.heading - 60)).toBeLessThan(3);
    expect(Math.abs(m.position.y - 1200)).toBeLessThan(25);
    expect(Math.abs(m.telemetry.airspeed - spec.speeds.cruise)).toBeLessThan(spec.speeds.cruise * 0.08);
  });

  it('stalls near its published stall speed and recovers', () => {
    const r = makeRig(id, 'realistic');
    const m = r.model;
    m.gearDown = !spec.gear.retractable;
    m.gearPos = m.gearDown ? 1 : 0;
    m.placeInAir(0, 2500, 0, 0, spec.speeds.stall * 1.6, 0);
    r.fcs.reset(true, m.computeTrimElevator(spec.speeds.stall * 1.6, 2500));
    let stallIas = 0;
    r.run(120, (rr) => {
      const t = rr.model.telemetry;
      if (!stallIas && t.alpha > spec.aero.alphaStall) stallIas = t.ias;
      if (stallIas) return { throttle: 1, pitch: t.stallFactor > 0.2 ? -0.5 : Math.max(-0.5, Math.min(0.5, -rr.model.velocity.y * 0.05 - rr.model.omega.y)), roll: -t.bank * 0.02 };
      // Classic stall entry: idle, progressively increasing back pressure.
      return { throttle: 0, pitch: Math.min(1 - rr.fcs.trim, rr.time / 30) };
    });
    expect(stallIas).toBeGreaterThan(0);
    // Dynamic entries (zoom climbs) can stall below 1 g, hence the generous lower bound.
    expect(stallIas).toBeGreaterThan(spec.speeds.stall * 0.7);
    expect(stallIas).toBeLessThan(spec.speeds.stall * 1.35);
    expect(m.crashed).toBe(false);
    expect(Number.isFinite(m.position.y)).toBe(true);
    expect(m.telemetry.stallFactor).toBeLessThan(0.1);
  });

  it('flies a stabilised approach, lands softly and stops on the centreline', () => {
    const r = makeRig(id, 'easy');
    const m = r.model;
    m.gearDown = true;
    m.gearPos = 1;
    m.setFlaps(spec.flaps.detents.length - 1);
    m.flapsPos = 1;
    m.placeInAir(30, 4000 * Math.tan(3 * DEG), 4000, 0, spec.speeds.approach, -3);
    r.fcs.reset(true);
    let sink = -1;
    m.onEvent = (e) => {
      if (e.type === 'touchdown' && sink < 0) sink = e.sinkRate;
    };
    r.run(150, landingPilot(r));
    expect(m.crashed).toBe(false);
    expect(sink).toBeGreaterThan(0);
    expect(sink).toBeLessThan(spec.gear.maxSinkRate * 0.7);
    expect(m.telemetry.groundSpeed).toBeLessThan(0.5);
    expect(Math.abs(m.position.x)).toBeLessThan(5);
  });

  it('never produces NaN under abusive control inputs', () => {
    const r = makeRig(id, 'realistic');
    const m = r.model;
    m.placeInAir(0, 4000, 0, 0, spec.speeds.cruise, 0);
    r.run(20, (rr) => ({ throttle: rr.time % 4 < 2 ? 1 : 0, pitch: Math.sin(rr.time * 3), roll: Math.cos(rr.time * 2), yaw: Math.sin(rr.time) }));
    expect(Number.isFinite(m.position.x + m.position.y + m.position.z)).toBe(true);
    expect(Number.isFinite(m.quaternion.x + m.quaternion.w)).toBe(true);
  });
});

describe('crash detection', () => {
  it('collapses the gear on a very hard landing', () => {
    const r = makeRig('kestrel', 'realistic');
    const m = r.model;
    m.placeInAir(0, 12, 0, 0, 35, -12);
    r.run(5);
    expect(m.crashed).toBe(true);
  });

  it('detects ditching in water', () => {
    const r = makeRig('kestrel', 'realistic', {
      groundHeight: () => 0,
      isWater: () => true,
      surfaceType: () => 'water',
    });
    const m = r.model;
    m.placeInAir(0, 5, 0, 0, 30, -5);
    r.run(5);
    expect(m.crashed).toBe(true);
    expect(m.crashReason.toLowerCase()).toMatch(/water|sea/);
  });

  it('detects collisions with obstacles', () => {
    const r = makeRig('kestrel', 'realistic', {
      groundHeight: () => 0,
      isWater: () => false,
      surfaceType: () => 'grass',
      obstacle: (_x, y, z) => (z < -200 && y < 150 ? 'a building' : null),
    });
    const m = r.model;
    m.placeInAir(0, 100, 0, 0, 50, 0);
    r.fcs.reset(true, m.computeTrimElevator(50, 100));
    r.run(10, () => ({ throttle: 0.6 }));
    expect(m.crashed).toBe(true);
    expect(m.crashReason).toContain('building');
  });

  it('breaks up when the airframe is overstressed', () => {
    const r = makeRig('falcon', 'realistic');
    const m = r.model;
    m.gearDown = false;
    m.gearPos = 0;
    m.placeInAir(0, 800, 0, 0, 390, 0);
    r.run(6, () => ({ throttle: 0.9, pitch: 1 }));
    expect(m.crashed).toBe(true);
    expect(m.crashReason).toMatch(/overstress/i);
  });

  it('easy mode limits G so the same pull does not break the jet', () => {
    const r = makeRig('falcon', 'easy');
    const m = r.model;
    m.gearDown = false;
    m.gearPos = 0;
    m.placeInAir(0, 800, 0, 0, 390, 0);
    r.fcs.reset(true);
    let maxG = 0;
    r.run(6, (rr) => {
      maxG = Math.max(maxG, rr.model.telemetry.gLoad);
      return { throttle: 0.9, pitch: 1 };
    });
    expect(m.crashed).toBe(false);
    expect(maxG).toBeLessThan(m.spec.fbw.gMax + 1.2);
  });
});

describe('systems', () => {
  it('retracts gear only when airborne and burns fuel', () => {
    const r = makeRig('falcon', 'easy');
    const m = r.model;
    m.placeOnGround(r.world, 0, 0, 0);
    expect(m.toggleGear()).toBe(false);
    m.placeInAir(0, 1000, 0, 0, 200, 0);
    r.fcs.reset(true);
    expect(m.toggleGear()).toBe(true);
    const fuel0 = m.fuel;
    r.run(8, () => ({ throttle: 1 }));
    expect(m.gearPos).toBeLessThan(0.01);
    expect(m.afterburner).toBe(true);
    expect(m.fuel).toBeLessThan(fuel0);
  });

  it('engine stops when fuel runs out', () => {
    const r = makeRig('kestrel', 'easy');
    const m = r.model;
    m.placeInAir(0, 1000, 0, 0, 50, 0);
    m.fuel = 0.01;
    r.run(10, () => ({ throttle: 1 }));
    expect(m.engineRunning).toBe(false);
    expect(m.telemetry.thrust).toBeLessThanOrEqual(0);
  });

  it('reports indicated airspeed below true airspeed at altitude', () => {
    const r = makeRig('kestrel', 'easy');
    r.model.placeInAir(0, 3000, 0, 0, 55, 0);
    r.run(0.5, () => ({ throttle: 0.6 }));
    const t = r.model.telemetry;
    expect(t.ias).toBeLessThan(t.airspeed);
    expect(t.ias * KTS_PER_MS).toBeGreaterThan(80);
  });
});
