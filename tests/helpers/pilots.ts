/** Scripted test pilots used by the physics and mission tests. */
import type { Rig } from './sim';
import { DEG, clamp } from '../../src/core/math';

export interface RunwayTarget {
  x: number;
  z: number;
  /** Unit landing direction. */
  dx: number;
  dz: number;
  elevation: number;
}

/** Threshold at the origin, landing toward -Z (runway heading 360). */
export const ORIGIN_RUNWAY: RunwayTarget = { x: 0, z: 0, dx: 0, dz: -1, elevation: 0 };

/**
 * Flies a 3° approach to a runway threshold, flares, lands and brakes to a stop on the
 * centreline. Works with the "easy" assist (stick = pitch-rate command).
 */
export function landingPilot(rig: Rig, rw: RunwayTarget = ORIGIN_RUNWAY, glide = 3) {
  const spec = rig.model.spec;
  const tanG = Math.tan(glide * DEG);
  let flare = false;
  let touched = false;
  return (r: Rig) => {
    const m = r.model;
    const t = m.telemetry;
    const rx = m.position.x - rw.x;
    const rz = m.position.z - rw.z;
    const along = -(rx * rw.dx + rz * rw.dz);
    // Positive = left of the centreline (looking along the landing direction).
    const lat = rx * rw.dz - rz * rw.dx;
    const latVel = m.velocity.x * rw.dz - m.velocity.z * rw.dx;
    if (m.wheelsOnGround > 0 && m.groundTime > 0.3) touched = true;
    if (touched) {
      const vAlong = m.velocity.x * rw.dx + m.velocity.z * rw.dz;
      // Steer back toward the centreline and along the runway direction.
      const yaw = clamp(lat * 0.03 + 2 * Math.atan2(latVel, Math.max(vAlong, 1)) - m.omega.z * 0.8, -1, 1);
      return { throttle: 0, pitch: 0, brake: clamp(m.groundTime / 2, 0, 0.8), yaw, roll: clamp(-t.bank * 0.05, -1, 1) };
    }
    const flareHeight = Math.max(4, spec.speeds.approach * 0.17);
    if (t.agl < flareHeight) flare = true;
    const V = Math.max(t.airspeed, 1);
    let gammaDes: number;
    if (flare) {
      gammaDes = -(0.25 * t.agl + 0.35) / V;
    } else {
      const pathAlt = rw.elevation + Math.max(0, along) * tanG;
      gammaDes = -glide * DEG + clamp((pathAlt - t.altitude) * 0.004, -0.06, 0.06);
    }
    const pitch = clamp((2.0 * (gammaDes - m.gamma) - 0.3 * m.omega.y) / spec.fbw.pitchRate, -1, 1);
    const bankDes = clamp(lat * 0.015 + latVel * 0.08, -0.3, 0.3);
    const roll = clamp(((bankDes - t.bank * DEG) * 2.5) / spec.fbw.rollRate, -1, 1);
    const thr = flare ? 0 : clamp(0.35 + (spec.speeds.approach - t.ias) * 0.08, 0, spec.engine.afterburnerThrust ? 0.9 : 1);
    return { throttle: thr, pitch, roll };
  };
}
