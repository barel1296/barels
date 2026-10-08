/**
 * Six-degree-of-freedom rigid-body flight model.
 *
 * Aerodynamics use stability derivatives in the aero body frame (x fwd, y right, z down),
 * with a smooth sigmoid stall model, ground effect, transonic drag rise, engine spool
 * dynamics, fuel burn, flaps, retractable gear, spring-damper wheel contacts with tyre
 * friction/brakes/nose-wheel steering, and crash detection.
 *
 * World state lives in the three.js frame (+Y up, -Z north). Body frame for geometry:
 * +X right, +Y up, -Z forward.
 */
import { Quaternion, Vector3 } from 'three';
import type { AircraftSpec, CollisionKind } from '../aircraft/specs';
import { maxMass } from '../aircraft/specs';
import { G, clamp, approach, RAD } from '../core/math';
import { density, speedOfSound } from './atmosphere';
import type { SurfaceType } from '../world/WorldMap';

export interface WorldQuery {
  /** Height of the touchable surface (terrain or sea). */
  groundHeight(x: number, z: number): number;
  isWater(x: number, z: number): boolean;
  surfaceType(x: number, z: number): SurfaceType;
  normal?(x: number, z: number, out: { x: number; y: number; z: number }): { x: number; y: number; z: number };
  /** Optional obstacle check (buildings, trees). Returns a description if hit. */
  obstacle?(x: number, y: number, z: number, r: number): string | null;
}

/** Control surface commands after the flight control system, all in [-1, 1]. */
export interface SurfaceCommand {
  elevator: number;
  aileron: number;
  rudder: number;
}

export type FlightEvent =
  | { type: 'touchdown'; sinkRate: number; groundSpeed: number; x: number; z: number; surface: SurfaceType }
  | { type: 'liftoff' }
  | { type: 'crash'; reason: string }
  | { type: 'tailstrike' }
  | { type: 'hardlanding'; sinkRate: number }
  | { type: 'gear'; down: boolean }
  | { type: 'flaps'; detent: number };

export interface Telemetry {
  /** True airspeed (m/s). */
  airspeed: number;
  /** Indicated (equivalent) airspeed (m/s). */
  ias: number;
  groundSpeed: number;
  verticalSpeed: number;
  altitude: number;
  agl: number;
  alpha: number;
  beta: number;
  mach: number;
  gLoad: number;
  heading: number;
  pitch: number;
  bank: number;
  qbar: number;
  stallFactor: number;
  thrust: number;
}

const WHEEL_LONG_EPS = 0.6;
const WHEEL_LAT_EPS = 0.35;

// Scratch objects (module-level to avoid per-step allocations).
const _v = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _rw = new Vector3();
const _pv = new Vector3();
const _n = { x: 0, y: 1, z: 0 };
const _nv = new Vector3();
const _fwd = new Vector3();
const _side = new Vector3();
const _up = new Vector3();
const _fAero = new Vector3();
const _mAero = new Vector3();
const _fWorld = new Vector3();
const _tWorld = new Vector3();
const _qInv = new Quaternion();
const _dq = new Quaternion();
const _axis = new Vector3();
const _omegaWorld = new Vector3();

export class FlightModel {
  readonly spec: AircraftSpec;

  // ---- Rigid body state ----
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  readonly quaternion = new Quaternion();
  /** Angular velocity in the aero body frame: x = roll rate p, y = pitch rate q, z = yaw rate r. */
  readonly omega = new Vector3();

  // ---- Systems ----
  throttle = 0;
  /** Engine spool 0..1 (RPM / N1 fraction). */
  engineSpool = 0;
  engineRunning = true;
  afterburner = false;
  fuel: number;
  flapsDetent = 0;
  flapsPos = 0;
  gearDown = true;
  /** 1 = fully extended. */
  gearPos = 1;
  brake = 0;
  parkingBrake = false;
  /** Pilot speedbrake command (0/1). */
  speedbrake = 0;
  /** Actual speedbrake / spoiler deployment 0..1. */
  spoilerPos = 0;
  groundSpoilersDeployed = false;
  smokeOn = false;

  /** Actual surface deflections (for visuals and telemetry). */
  readonly surfaces: SurfaceCommand = { elevator: 0, aileron: 0, rudder: 0 };
  steerAngle = 0;

  // ---- Derived (updated every step) ----
  readonly telemetry: Telemetry = {
    airspeed: 0,
    ias: 0,
    groundSpeed: 0,
    verticalSpeed: 0,
    altitude: 0,
    agl: 0,
    alpha: 0,
    beta: 0,
    mach: 0,
    gLoad: 1,
    heading: 0,
    pitch: 0,
    bank: 0,
    qbar: 0,
    stallFactor: 0,
    thrust: 0,
  };
  readonly wheelCompression: number[];
  readonly wheelContact: boolean[];
  wheelsOnGround = 0;
  onGround = false;
  airborneTime = 0;
  groundTime = 0;
  crashed = false;
  crashReason = '';
  mass: number;
  /** Specific force along body down axis, used for G. */
  private gRaw = 1;
  private overstressTime = 0;
  private overspeedTime = 0;
  private wasOnGround = false;
  private tailStrikeCooldown = 0;
  private lastSurface: SurfaceType = 'grass';

  /** Event sink. */
  onEvent: ((e: FlightEvent) => void) | null = null;

  constructor(spec: AircraftSpec) {
    this.spec = spec;
    this.fuel = spec.fuelCapacity;
    this.mass = maxMass(spec);
    this.wheelCompression = spec.gear.points.map(() => 0);
    this.wheelContact = spec.gear.points.map(() => false);
  }

  // ------------------------------------------------------------------ setup

  /** Place the aircraft at rest on the ground at (x,z) facing `headingDeg`. */
  placeOnGround(world: WorldQuery, x: number, z: number, headingDeg: number): void {
    const groundY = world.groundHeight(x, z);
    // Height of CG above the ground so that the lowest wheel just carries static load.
    let minY = Infinity;
    for (const p of this.spec.gear.points) minY = Math.min(minY, p.y);
    const staticCompression = this.staticCompression();
    this.position.set(x, groundY - minY - staticCompression, z);
    this.setHeading(headingDeg, 0);
    this.velocity.set(0, 0, 0);
    this.omega.set(0, 0, 0);
    this.gearDown = true;
    this.gearPos = 1;
    this.onGround = true;
    this.wheelsOnGround = this.spec.gear.points.length;
    this.wasOnGround = true;
    this.airborneTime = 0;
    this.groundTime = 10;
    this.throttle = 0;
    this.engineSpool = this.engineRunning ? this.idleSpool() : 0;
    this.crashed = false;
    this.crashReason = '';
  }

  /**
   * Place the aircraft in flight on a given flight-path angle, pitched to the
   * angle of attack that supports its weight (so it starts in equilibrium).
   */
  placeInAir(x: number, y: number, z: number, headingDeg: number, speed: number, gammaDeg = 0): void {
    this.position.set(x, y, z);
    const alpha = this.trimAlpha(speed, y);
    this.setHeading(headingDeg, gammaDeg + alpha * RAD);
    const h = headingDeg / RAD;
    const g = gammaDeg / RAD;
    this.velocity.set(Math.sin(h) * Math.cos(g), Math.sin(g), -Math.cos(h) * Math.cos(g)).multiplyScalar(speed);
    this.omega.set(0, 0, 0);
    this.onGround = false;
    this.wasOnGround = false;
    this.wheelsOnGround = 0;
    this.airborneTime = 10;
    this.groundTime = 0;
    this.crashed = false;
    this.crashReason = '';
    this.telemetry.airspeed = speed;
    this.telemetry.ias = speed * Math.sqrt(density(y) / 1.225);
    this.telemetry.altitude = y;
    this.telemetry.agl = y;
    this.telemetry.verticalSpeed = this.velocity.y;
    this.telemetry.groundSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    this.telemetry.alpha = alpha;
    this.telemetry.qbar = 0.5 * density(y) * speed * speed;
    this.telemetry.gLoad = 1;
    this.engineSpool = this.engineRunning ? Math.max(this.engineSpool, 0.75) : 0;
    this.updateAttitude();
  }

  /** Angle of attack (rad) for 1 g flight at `speed`. */
  trimAlpha(speed: number, altitude: number): number {
    const a = this.spec.aero;
    const qbar = 0.5 * density(altitude) * speed * speed;
    const cl = (this.mass * G) / (qbar * this.spec.wingArea);
    const alpha = (cl - a.CL0 - this.spec.flaps.CL * this.flapsRatio) / a.CLa;
    return clamp(alpha, a.alphaStallNeg * 0.8, a.alphaStall * 0.85);
  }

  setHeading(headingDeg: number, pitchDeg: number, bankDeg = 0): void {
    // Yaw about +Y: heading h (clockwise from north) = rotation of -h about Y.
    const e = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -headingDeg / RAD);
    const p = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), pitchDeg / RAD);
    const r = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -bankDeg / RAD);
    this.quaternion.copy(e).multiply(p).multiply(r);
  }

  idleSpool(): number {
    return this.spec.engine.type === 'jet' ? 0.62 : 0.25;
  }

  private springK(): number {
    // Each wheel can carry ~ the full weight at 1/4 of its travel.
    return (maxMass(this.spec) * G) / (this.spec.gear.travel * 0.9);
  }

  private staticCompression(): number {
    const n = this.spec.gear.points.length;
    return (this.mass * G) / n / this.springK();
  }

  setFlaps(detent: number): void {
    const d = clamp(Math.round(detent), 0, this.spec.flaps.detents.length - 1);
    if (d !== this.flapsDetent) {
      this.flapsDetent = d;
      this.onEvent?.({ type: 'flaps', detent: d });
    }
  }

  toggleGear(): boolean {
    if (!this.spec.gear.retractable) return false;
    // Weight-on-wheels interlock.
    if (this.gearDown && this.wheelsOnGround > 0) return false;
    this.gearDown = !this.gearDown;
    this.onEvent?.({ type: 'gear', down: this.gearDown });
    return true;
  }

  get flapsRatio(): number {
    const det = this.spec.flaps.detents;
    return det[this.flapsDetent] / det[det.length - 1];
  }

  /** Thrust as fraction of max dry (0..1) given spool. Idle produces a few percent. */
  private thrustFraction(): number {
    const idle = this.idleSpool();
    const idleFrac = this.spec.engine.type === 'jet' ? 0.045 : 0.05;
    if (this.engineSpool < idle) return (idleFrac * this.engineSpool) / idle;
    const x = clamp((this.engineSpool - idle) / (1 - idle), 0, 1);
    return idleFrac + (1 - idleFrac) * Math.pow(x, 1.15);
  }

  /** Engine RPM for gauges/audio (piston: RPM, jet: N1 percent). */
  get rpm(): number {
    const e = this.spec.engine;
    if (e.type === 'jet') return this.engineSpool * 100;
    const windmill = clamp(this.telemetry.airspeed / 60, 0, 1) * 900;
    if (!this.engineRunning || this.engineSpool < 0.05) return windmill * (this.engineRunning ? 1 : 0.6);
    return e.idleRPM + (e.maxRPM - e.idleRPM) * clamp((this.engineSpool - 0.25) / 0.75, 0, 1);
  }

  /** Elevator command that trims the aircraft at the given airspeed in level flight. */
  computeTrimElevator(speed: number, altitude: number): number {
    const a = this.spec.aero;
    const rho = density(altitude);
    const qbar = 0.5 * rho * speed * speed;
    const flap = this.flapsRatio;
    const clNeeded = (this.mass * G) / (qbar * this.spec.wingArea);
    // Solve CL0 + CLa*alpha + CLde*de + dCLflap = CLneeded, Cm0 + Cma*alpha + Cmde*de + dCmflap = 0
    const A = [
      [a.CLa, a.CLde],
      [a.Cma, a.Cmde],
    ];
    const bvec = [clNeeded - a.CL0 - this.spec.flaps.CL * flap, -a.Cm0 - this.spec.flaps.Cm * flap];
    const det = A[0][0] * A[1][1] - A[0][1] * A[1][0];
    const de = (A[0][0] * bvec[1] - A[1][0] * bvec[0]) / det;
    return clamp(de, -1, 1);
  }

  // ------------------------------------------------------------------ simulation

  /**
   * Advance by `dt` seconds (call with a small fixed dt, e.g. 1/240 s).
   * `cmd` are the control surface commands produced by the flight control system.
   */
  step(dt: number, cmd: SurfaceCommand, world: WorldQuery, wind: Vector3, steerInput = 0): void {
    if (this.crashed) return;
    const spec = this.spec;

    // ---- surface actuators (finite rate) ----
    const actRate = 6 * dt;
    this.surfaces.elevator = approach(this.surfaces.elevator, clamp(cmd.elevator, -1, 1), actRate);
    this.surfaces.aileron = approach(this.surfaces.aileron, clamp(cmd.aileron, -1, 1), actRate);
    this.surfaces.rudder = approach(this.surfaces.rudder, clamp(cmd.rudder, -1, 1), actRate);

    // ---- engine ----
    const e = spec.engine;
    const hasFuel = this.fuel > 0;
    if (!hasFuel) this.engineRunning = false;
    const idle = this.idleSpool();
    const target = this.engineRunning ? idle + (1 - idle) * clamp(this.throttle, 0, 1) : 0;
    const tau = target > this.engineSpool ? e.spoolUp : e.spoolDown;
    this.engineSpool += (target - this.engineSpool) * (1 - Math.exp(-dt / tau));
    this.afterburner = !!e.afterburnerThrust && this.engineRunning && this.throttle > 0.97 && this.engineSpool > 0.93;
    const tf = this.engineRunning ? this.thrustFraction() : 0;
    if (this.engineRunning) {
      const burn = spec.fuelBurn * (0.06 + 0.94 * tf) * (this.afterburner ? 4.5 : 1);
      this.fuel = Math.max(0, this.fuel - burn * dt);
    }
    this.mass = spec.emptyMass + this.fuel;

    // ---- flaps & gear actuators ----
    const flapTarget = this.flapsRatio;
    this.flapsPos = approach(this.flapsPos, flapTarget, spec.flaps.rate * dt);
    this.gearPos = approach(this.gearPos, this.gearDown ? 1 : 0, dt / spec.gear.retractTime);
    const sb = spec.speedbrake;
    if (sb) {
      const gsNow = Math.hypot(this.velocity.x, this.velocity.z);
      this.groundSpoilersDeployed =
        sb.groundSpoilers && this.wheelsOnGround > 0 && this.groundTime > 0.15 && this.throttle < 0.12 && gsNow > 8;
      const sbTarget = this.groundSpoilersDeployed ? 1 : this.speedbrake > 0 ? (sb.groundSpoilers ? 0.6 : 1) : 0;
      this.spoilerPos = approach(this.spoilerPos, sbTarget, dt * 1.5);
    }

    // ---- aerodynamics ----
    const alt = this.position.y;
    const rho = density(alt);
    _qInv.copy(this.quaternion).invert();
    // Air-relative velocity in three body frame.
    _v.copy(this.velocity).sub(wind).applyQuaternion(_qInv);
    const u = -_v.z;
    const vv = _v.x;
    const w = -_v.y;
    const V = Math.sqrt(u * u + vv * vv + w * w);
    const Vd = Math.max(V, 1);
    const alpha = V > 0.5 ? Math.atan2(w, u) : 0;
    const beta = V > 0.5 ? Math.asin(clamp(vv / V, -1, 1)) : 0;
    const qbar = 0.5 * rho * V * V;
    const a = spec.aero;
    const S = spec.wingArea;
    const b = spec.wingSpan;
    const c = spec.chord;
    const p = this.omega.x;
    const q = this.omega.y;
    const r = this.omega.z;
    const ph = (p * b) / (2 * Vd);
    const qh = (q * c) / (2 * Vd);
    const rh = (r * b) / (2 * Vd);
    const flap = this.flapsPos;
    const de = this.surfaces.elevator;
    const da = this.surfaces.aileron;
    const dr = this.surfaces.rudder;

    const aStallPos = a.alphaStall + spec.flaps.alphaStall * flap;
    const aStallNeg = a.alphaStallNeg;
    const M = 38;
    const sigPos = 1 / (1 + Math.exp(-M * (alpha - aStallPos)));
    const sigNeg = 1 / (1 + Math.exp(M * (alpha - aStallNeg)));
    const sigma = Math.min(1, sigPos + sigNeg);

    // Ground effect.
    const agl = Math.max(0.1, alt - world.groundHeight(this.position.x, this.position.z));
    const hb = agl / b;
    const ge = (16 * hb * hb) / (1 + 16 * hb * hb);

    const CLlin = a.CL0 + a.CLa * alpha + a.CLq * qh + a.CLde * de + spec.flaps.CL * flap;
    const CLpost = 1.15 * Math.sin(2 * alpha);
    const sbk = spec.speedbrake;
    const CL = ((1 - sigma) * CLlin + sigma * CLpost) * (1 + 0.08 * (1 - ge)) + (sbk ? sbk.CL * this.spoilerPos * (1 - sigma) : 0);
    const mach = V / speedOfSound(alt);
    let CD =
      a.CD0 +
      spec.gear.CD * this.gearPos +
      spec.flaps.CD * flap +
      (sbk ? sbk.CD * this.spoilerPos : 0) +
      (1 - sigma) * a.k * ge * CLlin * CLlin +
      sigma * (1.3 * Math.sin(alpha) * Math.sin(alpha) + 0.05);
    if (a.waveDrag) {
      const s1 = clamp((mach - 0.82) / 0.25, 0, 1);
      CD += a.waveDrag * s1 * s1 * (3 - 2 * s1) * (mach > 1.3 ? clamp(1 - (mach - 1.3) * 0.5, 0.6, 1) : 1);
    }
    const CY = a.CYb * beta + a.CYdr * dr;
    // Stall reduces aileron effectiveness and roll damping (wing drop tendency).
    const Clp = a.Clp * (1 - 0.7 * sigma);
    const Cl = a.Clb * beta + Clp * ph + a.Clr * rh + a.Clda * da * (1 - 0.5 * sigma) + a.Cldr * dr;
    // Post-stall pitch break: stronger nose-down restoring moment once the wing stalls.
    const Cm = a.Cm0 + a.Cma * Math.sin(alpha) * (1 + 0.6 * sigma) + a.Cmq * qh + a.Cmde * de + spec.flaps.Cm * flap;
    const Cn = a.Cnb * Math.sin(beta) + a.Cnp * ph + a.Cnr * rh + a.Cnda * da + a.Cndr * dr;

    // Forces in aero frame.
    _fAero.set(0, 0, 0);
    if (V > 0.1) {
      const invV = 1 / V;
      const qS = qbar * S;
      // Drag along -velocity.
      _fAero.x -= qS * CD * u * invV;
      _fAero.y -= qS * CD * vv * invV;
      _fAero.z -= qS * CD * w * invV;
      // Lift perpendicular to velocity in the symmetry plane: (w, 0, -u)/|.|
      const nxz = Math.sqrt(u * u + w * w);
      if (nxz > 1e-4) {
        _fAero.x += (qS * CL * w) / nxz;
        _fAero.z += (-qS * CL * u) / nxz;
      }
      _fAero.y += qS * CY;
    }

    // Thrust.
    let thrust = 0;
    const dr0 = rho / 1.225;
    if (e.type === 'piston') {
      const P = e.maxPower * tf * dr0;
      thrust = Math.min(e.staticThrust * tf * dr0, (0.8 * P) / Math.max(V, 1));
      if (!this.engineRunning) thrust = -0.5 * rho * V * V * 0.004 * S; // windmilling prop drag
    } else {
      const ram = e.highBypass ? 1 - 0.45 * Math.min(mach, 1) : 1 + 0.12 * Math.min(mach, 1.5);
      const lapse = Math.pow(dr0, 0.75) * ram;
      thrust = this.afterburner ? (e.afterburnerThrust ?? e.staticThrust) * lapse : e.staticThrust * tf * lapse;
    }
    _fAero.x += thrust;

    // Moments in aero frame.
    _mAero.set(qbar * S * b * Cl, qbar * S * c * Cm, qbar * S * b * Cn);

    // Specific force (for g-load) — aero + thrust only, along body down axis (aero z).
    const aeroGz = -_fAero.z / (this.mass * G);

    // Convert aero forces to world.
    _fWorld.set(_fAero.y, -_fAero.z, -_fAero.x).applyQuaternion(this.quaternion);
    _fWorld.y -= this.mass * G;
    _tWorld.set(0, 0, 0);

    // ---- ground contacts ----
    this.contacts(dt, world, steerInput);
    // contacts() accumulates into _fWorld / _tWorld and may flag a crash.
    if (this.crashed) return;

    // Specific force including gear for G display.
    const groundGz = this.lastGroundForce.length() > 0 ? this.lastGroundForceBodyUp / (this.mass * G) : 0;
    this.gRaw = aeroGz + groundGz;

    // ---- integrate translation ----
    this.velocity.addScaledVector(_fWorld, dt / this.mass);
    this.position.addScaledVector(this.velocity, dt);

    // ---- integrate rotation (Euler's equations, aero frame, diagonal inertia) ----
    // Ground torque (world) -> three body -> aero.
    _v2.copy(_tWorld).applyQuaternion(_qInv);
    _mAero.x += -_v2.z;
    _mAero.y += _v2.x;
    _mAero.z += -_v2.y;
    const Ixx = spec.inertia.roll;
    const Iyy = spec.inertia.pitch;
    const Izz = spec.inertia.yaw;
    const pd = (_mAero.x - (Izz - Iyy) * q * r) / Ixx;
    const qd = (_mAero.y - (Ixx - Izz) * p * r) / Iyy;
    const rd = (_mAero.z - (Iyy - Ixx) * p * q) / Izz;
    this.omega.x += pd * dt;
    this.omega.y += qd * dt;
    this.omega.z += rd * dt;
    // Light rotational friction on the ground to settle oscillations.
    if (this.wheelsOnGround > 0 && V < 3) this.omega.multiplyScalar(1 - Math.min(1, 4 * dt));
    // Convert to three-body angular velocity and integrate orientation.
    _axis.set(this.omega.y, -this.omega.z, -this.omega.x);
    const angle = _axis.length() * dt;
    if (angle > 1e-9) {
      _axis.normalize();
      _dq.setFromAxisAngle(_axis, angle);
      this.quaternion.multiply(_dq).normalize();
    }

    // ---- telemetry ----
    const t = this.telemetry;
    t.airspeed = V;
    t.ias = V * Math.sqrt(rho / 1.225);
    t.groundSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    t.verticalSpeed = this.velocity.y;
    t.altitude = this.position.y;
    t.agl = this.position.y - world.groundHeight(this.position.x, this.position.z);
    t.alpha = alpha;
    t.beta = beta;
    t.mach = mach;
    t.gLoad += (this.gRaw - t.gLoad) * Math.min(1, dt * 12);
    t.qbar = qbar;
    t.stallFactor = sigma;
    t.thrust = thrust;
    this.updateAttitude();

    // ---- structural limits ----
    const lim = spec.limits;
    if (t.gLoad > lim.gMax * 1.5 || t.gLoad < lim.gMin * 1.5) this.overstressTime += dt;
    else this.overstressTime = Math.max(0, this.overstressTime - dt);
    if (this.overstressTime > 0.25) return this.crash('Structural failure — airframe overstressed');
    if (V > lim.vne * 1.3) this.overspeedTime += dt;
    else this.overspeedTime = Math.max(0, this.overspeedTime - dt * 0.5);
    if (this.overspeedTime > 4) return this.crash('Structural failure — exceeded never-exceed speed');

    // ---- obstacles ----
    if (world.obstacle) {
      const hit = world.obstacle(this.position.x, this.position.y, this.position.z, spec.bodyRadius * 0.6);
      if (hit) return this.crash(`Collided with ${hit}`);
      for (const cp of spec.collision) {
        if (cp.kind !== 'wing' && cp.kind !== 'nose') continue;
        _v3.set(cp.x, cp.y, cp.z).applyQuaternion(this.quaternion).add(this.position);
        const h2 = world.obstacle(_v3.x, _v3.y, _v3.z, 0.6);
        if (h2) return this.crash(`Collided with ${h2}`);
      }
    }
  }

  private lastGroundForce = new Vector3();
  private lastGroundForceBodyUp = 0;

  /** Wheel and airframe contact handling. Adds to _fWorld/_tWorld. */
  private contacts(dt: number, world: WorldQuery, steerInput: number): void {
    const spec = this.spec;
    const k = this.springK();
    const nWheels = spec.gear.points.length;
    const cDamp = 2 * 0.55 * Math.sqrt((k * this.mass) / nWheels);
    this.lastGroundForce.set(0, 0, 0);
    _omegaWorld.set(this.omega.y, -this.omega.z, -this.omega.x).applyQuaternion(this.quaternion);
    _up.set(0, 1, 0).applyQuaternion(this.quaternion);
    const gearActive = this.gearPos > 0.98;
    const gs = Math.hypot(this.velocity.x, this.velocity.z);
    // Nose-wheel steering: full (tiller) authority at taxi speed, rudder-pedal authority at speed.
    const sf = clamp((gs - 3) / 22, 0, 1);
    const maxSteer = ((50 - 46 * sf * sf * (3 - 2 * sf)) * Math.PI) / 180;
    this.steerAngle = steerInput * maxSteer;

    let wheelsDown = 0;
    for (let i = 0; i < nWheels; i++) {
      const gp = spec.gear.points[i];
      this.wheelContact[i] = false;
      if (!gearActive) {
        this.wheelCompression[i] = 0;
        continue;
      }
      _rw.set(gp.x, gp.y, gp.z).applyQuaternion(this.quaternion);
      _pv.copy(this.position).add(_rw);
      const gy = world.groundHeight(_pv.x, _pv.z);
      const pen = gy - _pv.y;
      if (pen <= 0) {
        this.wheelCompression[i] = Math.max(0, this.wheelCompression[i] - dt * 2);
        continue;
      }
      if (world.isWater(_pv.x, _pv.z)) {
        this.crash('Ditched in the water');
        return;
      }
      this.wheelContact[i] = true;
      wheelsDown++;
      this.wheelCompression[i] = Math.min(pen, spec.gear.travel);
      if (world.normal) world.normal(_pv.x, _pv.z, _n);
      else {
        _n.x = 0;
        _n.y = 1;
        _n.z = 0;
      }
      _nv.set(_n.x, _n.y, _n.z);
      // Point velocity.
      _v.copy(_omegaWorld).cross(_rw).add(this.velocity);
      const vn = _v.dot(_nv);
      let Fn = k * Math.min(pen, spec.gear.travel) - cDamp * vn;
      if (pen > spec.gear.travel) Fn += k * 25 * (pen - spec.gear.travel) - cDamp * 4 * Math.min(vn, 0);
      if (Fn < 0) Fn = 0;
      // Wheel direction.
      _fwd.set(0, 0, -1);
      if (gp.steer && this.steerAngle !== 0) _fwd.applyAxisAngle(_v2.set(0, 1, 0), -this.steerAngle);
      _fwd.applyQuaternion(this.quaternion);
      _fwd.addScaledVector(_nv, -_fwd.dot(_nv)).normalize();
      _side.crossVectors(_nv, _fwd).normalize();
      const vl = _v.dot(_fwd);
      const vs = _v.dot(_side);
      const surface = world.surfaceType(_pv.x, _pv.z);
      this.lastSurface = surface;
      const roll = surface === 'runway' || surface === 'paved' ? 0.018 : surface === 'sand' ? 0.12 : 0.05;
      const brakeLevel = gp.brake ? Math.max(this.brake, this.parkingBrake ? 1 : 0) : 0;
      const muLong = roll + brakeLevel * (surface === 'runway' || surface === 'paved' ? 0.55 : 0.35);
      const muLat = surface === 'runway' || surface === 'paved' ? 0.85 : 0.6;
      const Fl = -clamp(vl / WHEEL_LONG_EPS, -1, 1) * muLong * Fn;
      // Slip-angle tyre model, saturating around 7°.
      const slip = Math.atan2(vs, Math.abs(vl) + WHEEL_LAT_EPS);
      const Fs = -clamp(slip / 0.12, -1, 1) * muLat * Fn;
      _v3.copy(_nv).multiplyScalar(Fn).addScaledVector(_fwd, Fl).addScaledVector(_side, Fs);
      _fWorld.add(_v3);
      this.lastGroundForce.add(_v3);
      _v2.copy(_rw).cross(_v3);
      _tWorld.add(_v2);
    }

    // Airframe contacts.
    let skid = 0;
    for (const cp of spec.collision) {
      _rw.set(cp.x, cp.y, cp.z).applyQuaternion(this.quaternion);
      _pv.copy(this.position).add(_rw);
      const gy = world.groundHeight(_pv.x, _pv.z);
      const pen = gy - _pv.y;
      if (pen <= 0) continue;
      _v.copy(_omegaWorld).cross(_rw).add(this.velocity);
      const speed = _v.length();
      if (world.isWater(_pv.x, _pv.z)) {
        this.crash(speed > 25 ? 'Crashed into the sea' : 'Ditched in the water');
        return;
      }
      const sinkRate = -_v.y;
      const kind: CollisionKind = cp.kind;
      const survivable =
        (kind === 'belly' && sinkRate < 3 && speed < spec.speeds.stall * 1.6) ||
        (kind === 'tail' && sinkRate < 2.5 && speed < spec.speeds.rotate * 1.6);
      if (!survivable || pen > 1.5) {
        const reasons: Record<CollisionKind, string> = {
          nose: spec.engine.type === 'piston' ? 'Propeller strike — nosed into the ground' : 'Nosed into the ground',
          tail: 'Tail strike — airframe destroyed',
          wing: 'Wing tip struck the ground',
          fin: 'Flipped over',
          belly: 'Belly impact — crashed into terrain',
          engine: 'Engine pod struck the ground',
        };
        this.crash(reasons[kind]);
        return;
      }
      if (kind === 'tail' && this.tailStrikeCooldown <= 0) {
        this.tailStrikeCooldown = 2;
        this.onEvent?.({ type: 'tailstrike' });
      }
      skid++;
      // Skid contact: spring + heavy friction.
      _nv.set(0, 1, 0);
      const vn = _v.y;
      let Fn = k * 2 * pen - cDamp * 2 * vn;
      if (Fn < 0) Fn = 0;
      _v2.copy(_v);
      _v2.y = 0;
      const vh = _v2.length();
      _v3.set(0, Fn, 0);
      if (vh > 1e-3) _v3.addScaledVector(_v2, (-0.45 * Fn * clamp(vh / 0.5, 0, 1)) / vh);
      _fWorld.add(_v3);
      this.lastGroundForce.add(_v3);
      _v2.copy(_rw).cross(_v3);
      _tWorld.add(_v2);
    }
    this.tailStrikeCooldown -= dt;

    // Ground-force component along body up (for G meter).
    this.lastGroundForceBodyUp = this.lastGroundForce.dot(_up);

    // Terrain tunnelling safeguard.
    if (this.position.y < world.groundHeight(this.position.x, this.position.z) - 2) {
      this.crash('Crashed into terrain');
      return;
    }

    this.wheelsOnGround = wheelsDown;
    const nowOnGround = wheelsDown > 0 || skid > 0;
    if (nowOnGround) {
      if (!this.wasOnGround && this.airborneTime > 0.5) {
        const sink = -this.velocity.y;
        this.onEvent?.({
          type: 'touchdown',
          sinkRate: sink,
          groundSpeed: gs,
          x: this.position.x,
          z: this.position.z,
          surface: this.lastSurface,
        });
        if (wheelsDown > 0 && sink > spec.gear.maxSinkRate) {
          this.crash(`Landing gear collapsed — touchdown at ${(sink * 196.85).toFixed(0)} ft/min`);
          return;
        }
        if (sink > spec.gear.maxSinkRate * 0.6) this.onEvent?.({ type: 'hardlanding', sinkRate: sink });
      }
      this.wasOnGround = true;
      this.airborneTime = 0;
      this.groundTime += dt;
    } else {
      this.airborneTime += dt;
      if (this.wasOnGround && this.airborneTime > 0.4) {
        if (this.groundTime > 0.3 && gs > 10) this.onEvent?.({ type: 'liftoff' });
        this.wasOnGround = false;
        this.groundTime = 0;
      }
    }
    this.onGround = nowOnGround;
  }

  crash(reason: string): void {
    if (this.crashed) return;
    this.crashed = true;
    this.crashReason = reason;
    this.onEvent?.({ type: 'crash', reason });
  }

  /** Heading/pitch/bank in degrees from the orientation quaternion. */
  updateAttitude(): void {
    const fwd = _v.set(0, 0, -1).applyQuaternion(this.quaternion);
    const up = _v2.set(0, 1, 0).applyQuaternion(this.quaternion);
    const right = _v3.set(1, 0, 0).applyQuaternion(this.quaternion);
    const t = this.telemetry;
    t.pitch = Math.asin(clamp(fwd.y, -1, 1)) * RAD;
    let hdg = Math.atan2(fwd.x, -fwd.z) * RAD;
    if (hdg < 0) hdg += 360;
    t.heading = hdg;
    // Bank: angle of right wing below horizon, positive = right wing down.
    t.bank = Math.atan2(-right.y, up.y) * RAD;
  }

  get forward(): Vector3 {
    return new Vector3(0, 0, -1).applyQuaternion(this.quaternion);
  }

  /** Flight path angle (rad). */
  get gamma(): number {
    const sp = this.velocity.length();
    return sp > 1 ? Math.asin(clamp(this.velocity.y / sp, -1, 1)) : 0;
  }

  /** Copies the full dynamic state (for resets / tests). */
  snapshot(): { pos: number[]; vel: number[]; quat: number[]; omega: number[] } {
    return {
      pos: this.position.toArray(),
      vel: this.velocity.toArray(),
      quat: this.quaternion.toArray() as number[],
      omega: this.omega.toArray(),
    };
  }
}
