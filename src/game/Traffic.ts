/**
 * Ambient AI air traffic: kinematic aircraft flying closed routes around the island.
 * They bank into turns, animate like the player's aircraft, show on the HUD/maps and
 * can be collided with.
 */
import { CatmullRomCurve3, Group, Matrix4, Quaternion, Vector3 } from 'three';
import type { WorldMap } from '../world/WorldMap';
import { getAircraft, type AircraftSpec } from '../aircraft/specs';
import { AircraftModel } from '../aircraft/AircraftModel';
import { FlightModel } from '../physics/FlightModel';
import { G, clamp } from '../core/math';

export interface TrafficRoute {
  id: string;
  aircraft: string;
  callsign: string;
  curve: CatmullRomCurve3;
  /** Ground speed along the route (m/s). */
  speed: number;
  smoke: boolean;
  /** Starting position along the route (0..1). */
  phase: number;
}

function ellipse(cx: number, cz: number, rx: number, rz: number, y: (x: number, z: number) => number, n = 16, wobble = 0): Vector3[] {
  const pts: Vector3[] = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const x = cx + Math.cos(a) * rx;
    const z = cz + Math.sin(a) * rz;
    pts.push(new Vector3(x, y(x, z) + Math.sin(a * 2) * wobble, z));
  }
  return pts;
}

/** Route definitions (pure geometry, testable without a renderer). */
export function trafficRoutes(world: WorldMap): TrafficRoute[] {
  const clearAbove = (min: number) => (x: number, z: number) => Math.max(min, world.groundHeight(x, z) + 250);
  // Figure-eight display over the sea south of the city.
  const fig8: Vector3[] = [];
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    const s = Math.sin(a);
    fig8.push(new Vector3(4200 + 1500 * s, 650 + 120 * Math.cos(a * 2), 12600 + 900 * s * Math.cos(a)));
  }
  return [
    {
      id: 'tour',
      aircraft: 'kestrel',
      callsign: 'Kestrel 21',
      curve: new CatmullRomCurve3(ellipse(-4500, 3000, 1800, 1300, clearAbove(480)), true, 'centripetal'),
      speed: 52,
      smoke: false,
      phase: 0.1,
    },
    {
      id: 'airshow',
      aircraft: 'vortex',
      callsign: 'Display 7',
      curve: new CatmullRomCurve3(fig8, true, 'centripetal'),
      speed: 72,
      smoke: true,
      phase: 0.35,
    },
    {
      id: 'patrol',
      aircraft: 'falcon',
      callsign: 'Viper 1',
      curve: new CatmullRomCurve3(ellipse(9500, 1500, 5500, 8500, () => 2500, 20, 120), true, 'centripetal'),
      speed: 220,
      smoke: false,
      phase: 0.6,
    },
    {
      id: 'liner',
      aircraft: 'skyliner',
      callsign: 'Island Air 302',
      curve: new CatmullRomCurve3(ellipse(1500, 500, 16000, 14000, () => 3200, 24), true, 'centripetal'),
      speed: 165,
      smoke: false,
      phase: 0.85,
    },
  ];
}

export interface TrafficInfo {
  callsign: string;
  position: Vector3;
  velocity: Vector3;
}

interface Plane {
  route: TrafficRoute;
  spec: AircraftSpec;
  model: AircraftModel;
  fm: FlightModel;
  length: number;
  u: number;
  bank: number;
  velocity: Vector3;
}

const _t = new Vector3();
const _t2 = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _m = new Matrix4();
const _qb = new Quaternion();
const _axisZ = new Vector3(0, 0, 1);
const _p = new Vector3();

export class Traffic {
  readonly group = new Group();
  private planes: Plane[] = [];
  enabled = true;

  constructor(world: WorldMap) {
    this.group.name = 'traffic';
    for (const route of trafficRoutes(world)) {
      const spec = getAircraft(route.aircraft);
      const model = new AircraftModel(spec);
      const fm = new FlightModel(spec);
      fm.engineRunning = true;
      fm.engineSpool = 0.8;
      fm.throttle = 0.7;
      fm.gearDown = !spec.gear.retractable;
      fm.gearPos = fm.gearDown ? 1 : 0;
      fm.smokeOn = route.smoke;
      this.group.add(model.root);
      this.planes.push({ route, spec, model, fm, length: route.curve.getLength(), u: route.phase, bank: 0, velocity: new Vector3() });
    }
    this.update(0, 0);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.group.visible = on;
  }

  update(dt: number, night: number): void {
    if (!this.enabled) return;
    for (const p of this.planes) {
      const r = p.route;
      p.u = (p.u + (r.speed * dt) / p.length) % 1;
      r.curve.getPointAt(p.u, _p);
      r.curve.getTangentAt(p.u, _t);
      const du = 40 / p.length;
      r.curve.getTangentAt((p.u + du) % 1, _t2);
      // Bank for a coordinated turn from the path curvature.
      _right.crossVectors(_t, _up.set(0, 1, 0)).normalize();
      const kappa = _t2.sub(_t).dot(_right) / 40;
      const bankTarget = Math.atan((r.speed * r.speed * kappa) / G);
      p.bank += (clamp(bankTarget, -1.1, 1.1) - p.bank) * Math.min(1, dt * 2);
      // Orientation: body -Z along the tangent, rolled by the bank angle.
      _up.crossVectors(_right, _t).normalize();
      _m.makeBasis(_right, _up, _t2.copy(_t).negate());
      p.fm.quaternion.setFromRotationMatrix(_m);
      _qb.setFromAxisAngle(_axisZ, -p.bank);
      p.fm.quaternion.multiply(_qb);
      p.velocity.copy(_t).multiplyScalar(r.speed);
      p.fm.position.copy(_p);
      p.fm.velocity.copy(p.velocity);
      p.fm.telemetry.airspeed = r.speed;
      p.fm.surfaces.aileron = clamp((bankTarget - p.bank) * 2, -1, 1);
      p.fm.surfaces.elevator = clamp(Math.abs(p.bank) * 0.4, 0, 0.5);
      p.fm.afterburner = r.aircraft === 'falcon' && Math.abs(p.bank) > 0.5;
      p.model.root.position.copy(_p);
      p.model.root.quaternion.copy(p.fm.quaternion);
      p.model.root.updateMatrixWorld(true);
      p.model.update(p.fm, dt, true, night);
    }
  }

  /** Smoke emitters for display aircraft (world positions). */
  smokePoints(out: Vector3[]): Vector3[] {
    out.length = 0;
    if (!this.enabled) return out;
    for (const p of this.planes) if (p.route.smoke) out.push(p.model.worldPoint(p.model.points.smoke));
    return out;
  }

  /** Returns the traffic aircraft overlapping a sphere, if any. */
  collide(pos: Vector3, radius: number): TrafficInfo | null {
    if (!this.enabled) return null;
    for (const p of this.planes) {
      const r = radius + p.spec.bodyRadius;
      if (p.fm.position.distanceToSquared(pos) < r * r * 0.6) return { callsign: p.route.callsign, position: p.fm.position, velocity: p.velocity };
    }
    return null;
  }

  info(): TrafficInfo[] {
    if (!this.enabled) return [];
    return this.planes.map((p) => ({ callsign: p.route.callsign, position: p.fm.position, velocity: p.velocity }));
  }

  dispose(): void {
    for (const p of this.planes) p.model.dispose();
  }
}
