/**
 * Flight control system: maps pilot inputs to control-surface commands.
 *
 *  - "realistic": direct surface control with elevator trim.
 *  - "easy": fly-by-wire. Stick commands body rates; releasing the stick holds the
 *    current flight-path angle and bank (small banks auto-level). Includes AoA and
 *    G protection and automatic turn coordination. The inner loops invert the
 *    aerodynamic moment model so the response is consistent at every speed.
 *  - Autopilot (either mode): altitude, heading and speed hold.
 */
import type { FlightModel, SurfaceCommand } from './FlightModel';
import { G, DEG, RAD, clamp, angleDiffDeg } from '../core/math';

export type FlightAssist = 'easy' | 'realistic';

export interface PilotInput {
  pitch: number;
  roll: number;
  yaw: number;
}

export interface AutopilotState {
  engaged: boolean;
  altitude: number;
  heading: number;
  speed: number;
  autothrottle: boolean;
}

export class FlightControlSystem {
  assist: FlightAssist = 'easy';
  /** Elevator trim for the realistic model, in [-1, 1]. */
  trim = 0;
  readonly autopilot: AutopilotState = { engaged: false, altitude: 0, heading: 0, speed: 0, autothrottle: true };
  /** Throttle commanded by the autothrottle (valid while AP engaged). */
  apThrottle = 0;
  /** Set when the AP disconnects itself (pilot override). */
  onAutopilotChange: ((engaged: boolean, reason?: string) => void) | null = null;

  private gammaHold: number | null = null;
  private bankHold: number | null = null;
  private atI = 0;
  private airborneFor = 0;
  readonly out: SurfaceCommand = { elevator: 0, aileron: 0, rudder: 0 };

  /** Reset for a new flight. `airborne` skips the post-takeoff direct-control phase. */
  reset(airborne = false, trim = 0): void {
    this.gammaHold = null;
    this.bankHold = null;
    this.trim = trim;
    this.atI = 0;
    this.airborneFor = airborne ? 10 : 0;
    this.autopilot.engaged = false;
  }

  engageAutopilot(m: FlightModel): boolean {
    if (m.onGround || m.crashed) return false;
    const t = m.telemetry;
    this.autopilot.engaged = true;
    this.autopilot.altitude = Math.round(t.altitude / 10) * 10;
    this.autopilot.heading = Math.round(t.heading);
    this.autopilot.speed = Math.max(t.airspeed, m.spec.speeds.stall * 1.35);
    this.atI = m.throttle;
    this.apThrottle = m.throttle;
    this.onAutopilotChange?.(true);
    return true;
  }

  disengageAutopilot(reason?: string): void {
    if (!this.autopilot.engaged) return;
    this.autopilot.engaged = false;
    this.gammaHold = null;
    this.bankHold = null;
    this.onAutopilotChange?.(false, reason);
  }

  /** Called every physics sub-step. */
  update(m: FlightModel, input: PilotInput, dt: number): SurfaceCommand {
    const out = this.out;
    const t = m.telemetry;
    const spec = m.spec;
    const onGround = m.wheelsOnGround > 0;
    this.airborneFor = onGround ? 0 : this.airborneFor + dt;

    const ap = this.autopilot;
    if (ap.engaged) {
      if (Math.abs(input.pitch) > 0.35 || Math.abs(input.roll) > 0.35) this.disengageAutopilot('Pilot override');
      else if (onGround) this.disengageAutopilot('Weight on wheels');
    }

    // Ground / just-rotated: direct control.
    if (!ap.engaged && (this.assist === 'realistic' || onGround || this.airborneFor < 0.4)) {
      const trim = this.assist === 'realistic' ? this.trim : 0;
      out.elevator = clamp(input.pitch + trim, -1, 1);
      out.aileron = clamp(input.roll, -1, 1);
      out.rudder = clamp(input.yaw, -1, 1);
      if (this.assist === 'easy' && !onGround) {
        // Gentle coordination even during the transition.
        out.rudder = clamp(input.yaw + t.beta * 3, -1, 1);
      }
      this.gammaHold = null;
      this.bankHold = null;
      return out;
    }

    const V = Math.max(t.airspeed, 1);
    const bank = t.bank * DEG;
    const gamma = m.gamma;
    const alpha = t.alpha;
    const pitchRateMax = spec.fbw.pitchRate;
    const rollRateMax = spec.fbw.rollRate;

    // Turn compensation: pitch rate required to hold the flight path in a banked turn.
    const cb = Math.cos(clamp(bank, -75 * DEG, 75 * DEG));
    const turnComp = (G / V) * Math.cos(gamma) * (1 / cb - cb);

    let qCmd: number;
    let pCmd: number;
    let yawRateCmd = 0;

    if (ap.engaged) {
      // ---- Autopilot outer loops ----
      const hdgErr = angleDiffDeg(t.heading, ap.heading);
      const maxBank = spec.engine.type === 'jet' && spec.id === 'skyliner' ? 25 : 28;
      const bankCmd = clamp(hdgErr * 1.1, -maxBank, maxBank) * DEG;
      pCmd = clamp(1.0 * (bankCmd - bank), -0.25, 0.25);
      const vsMax = spec.engine.type === 'jet' ? (spec.id === 'skyliner' ? 9 : 25) : 4;
      const vsCmd = clamp(0.12 * (ap.altitude - t.altitude), -vsMax, vsMax);
      const gammaCmd = Math.asin(clamp(vsCmd / V, -0.35, 0.35));
      qCmd = turnComp + clamp(1.2 * (gammaCmd - gamma), -pitchRateMax * 0.5, pitchRateMax * 0.5);
      if (ap.autothrottle) {
        const err = ap.speed - t.airspeed;
        this.atI = clamp(this.atI + err * 0.015 * dt, 0, 1);
        const maxT = spec.engine.afterburnerThrust ? 0.96 : 1;
        this.apThrottle = clamp(this.atI + err * 0.06, 0, maxT);
      }
    } else {
      // ---- Easy fly-by-wire ----
      if (Math.abs(input.pitch) > 0.04) {
        qCmd = input.pitch * pitchRateMax + (input.pitch > 0 ? turnComp : turnComp * 0.5);
        this.gammaHold = null;
      } else {
        if (this.gammaHold === null) this.gammaHold = gamma;
        if (Math.abs(bank) > 70 * DEG) {
          qCmd = 0;
          this.gammaHold = null;
        } else {
          qCmd = turnComp + clamp(1.1 * (this.gammaHold - gamma), -pitchRateMax * 0.6, pitchRateMax * 0.6);
        }
      }
      if (Math.abs(input.roll) > 0.04) {
        pCmd = input.roll * rollRateMax;
        this.bankHold = null;
      } else {
        if (this.bankHold === null) this.bankHold = Math.abs(bank) < 8 * DEG ? 0 : bank;
        const err = angleDiffDeg(bank * RAD, this.bankHold * RAD) * DEG;
        pCmd = clamp(1.6 * err, -rollRateMax * 0.4, rollRateMax * 0.4);
      }
      yawRateCmd = input.yaw * spec.fbw.yawRate;
    }

    // ---- Protections ----
    const aMax = (spec.aero.alphaStall + spec.flaps.alphaStall * m.flapsPos) * 0.86;
    const aMin = spec.aero.alphaStallNeg * 0.86;
    if (alpha > aMax - 3 * DEG) qCmd = Math.min(qCmd, 3 * (aMax - alpha));
    if (alpha < aMin + 3 * DEG) qCmd = Math.max(qCmd, 3 * (aMin - alpha));
    const nMax = spec.fbw.gMax;
    const qMaxG = ((nMax - Math.cos(gamma) * Math.cos(bank)) * G) / V;
    const qMinG = ((-Math.min(2, Math.abs(spec.limits.gMin)) - 1) * G) / V;
    qCmd = clamp(qCmd, qMinG, qMaxG);

    // Coordinated-turn yaw rate.
    const rCoord = (G / V) * Math.sin(clamp(bank, -80 * DEG, 80 * DEG)) * Math.cos(gamma);
    const rCmd = rCoord + yawRateCmd;

    // ---- Inner loops: desired angular accelerations ----
    const pDotDes = 5 * (pCmd - m.omega.x);
    const qDotDes = 5 * (qCmd - m.omega.y);
    const rDotDes = 3 * (rCmd - m.omega.z) + 4 * t.beta;

    this.invert(m, pDotDes, qDotDes, rDotDes, out);
    return out;
  }

  /** Solve the moment model for surface deflections that achieve the desired accelerations. */
  private invert(m: FlightModel, pd: number, qd: number, rd: number, out: SurfaceCommand): void {
    const spec = m.spec;
    const a = spec.aero;
    const t = m.telemetry;
    const qS = Math.max(t.qbar, 5) * spec.wingArea;
    const b = spec.wingSpan;
    const c = spec.chord;
    const V = Math.max(t.airspeed, 1);
    const p = m.omega.x;
    const q = m.omega.y;
    const r = m.omega.z;
    const Ixx = spec.inertia.roll;
    const Iyy = spec.inertia.pitch;
    const Izz = spec.inertia.yaw;
    const ph = (p * b) / (2 * V);
    const qh = (q * c) / (2 * V);
    const rh = (r * b) / (2 * V);
    const sigma = t.stallFactor;
    const flap = m.flapsPos;

    // Pitch.
    const Mreq = Iyy * qd + (Ixx - Izz) * p * r;
    const cmRest = a.Cm0 + a.Cma * Math.sin(t.alpha) * (1 + 0.6 * sigma) + a.Cmq * qh + spec.flaps.Cm * flap;
    out.elevator = clamp((Mreq / (qS * c) - cmRest) / a.Cmde, -1, 1);

    // Roll / yaw (2x2 solve).
    const Lreq = Ixx * pd + (Izz - Iyy) * q * r;
    const Nreq = Izz * rd + (Iyy - Ixx) * p * q;
    const Clp = a.Clp * (1 - 0.7 * sigma);
    const clRest = a.Clb * t.beta + Clp * ph + a.Clr * rh;
    const cnRest = a.Cnb * Math.sin(t.beta) + a.Cnp * ph + a.Cnr * rh;
    const A11 = a.Clda * (1 - 0.5 * sigma);
    const A12 = a.Cldr;
    const A21 = a.Cnda;
    const A22 = a.Cndr;
    const b1 = Lreq / (qS * b) - clRest;
    const b2 = Nreq / (qS * b) - cnRest;
    const det = A11 * A22 - A12 * A21;
    let da = (b1 * A22 - A12 * b2) / det;
    let dr = (A11 * b2 - A21 * b1) / det;
    da = clamp(da, -1, 1);
    dr = clamp(dr, -1, 1);
    out.aileron = da;
    out.rudder = dr;
  }
}
