/**
 * Mission definitions and runtime: staged objectives (take-off, climb, rings, waypoints,
 * landing), failure conditions and scoring.
 */
import { Vector3 } from 'three';
import type { WorldMap, Airport, RunwayEnd } from '../world/WorldMap';
import { headingToDir } from '../world/WorldMap';
import type { FlightEvent, FlightModel } from '../physics/FlightModel';
import type { TimeOfDay, WeatherKind } from '../world/Environment';
import { DEG, angleDiffDeg, clamp } from '../core/math';

export type SpawnDef =
  | { kind: 'runway'; airport: string; end: 0 | 1 }
  | { kind: 'approach'; airport: string; end: 0 | 1; distance: number; config?: 'landing' | 'clean' }
  | { kind: 'air'; x: number; z: number; agl: number; heading: number; speed?: number };

export interface Ring {
  x: number;
  y: number;
  z: number;
  heading: number;
  radius: number;
}

export type Stage =
  | { type: 'takeoff'; text?: string }
  | { type: 'altitude'; agl: number; text?: string }
  | { type: 'rings'; rings: Ring[]; text?: string }
  | { type: 'waypoint'; x: number; z: number; radius: number; label: string; text?: string }
  | { type: 'land'; airport: string; end?: 0 | 1; text?: string };

export interface MissionDef {
  id: string;
  title: string;
  category: 'Training' | 'Racing' | 'Landing' | 'Challenge' | 'Travel';
  difficulty: 1 | 2 | 3;
  description: string;
  aircraft: string;
  allowedAircraft?: string[];
  time: TimeOfDay;
  weather: WeatherKind;
  wind?: { speed: number; from: number };
  spawn: SpawnDef;
  stages: Stage[];
  /** Par time (s) for the time bonus. */
  parTime?: number;
  timeLimit?: number;
  engineFailureAt?: number;
  tips: string[];
}

/** Rings along a path; altitude is AGL at each point but never below the terrain along the leg. */
function course(world: WorldMap, pts: [number, number, number][], radius: number): Ring[] {
  const rings: Ring[] = [];
  for (let i = 0; i < pts.length; i++) {
    const [x, z, agl] = pts[i];
    const next = pts[Math.min(i + 1, pts.length - 1)];
    const prev = pts[Math.max(i - 1, 0)];
    const dx = i < pts.length - 1 ? next[0] - x : x - prev[0];
    const dz = i < pts.length - 1 ? next[1] - z : z - prev[1];
    // Face the average of the incoming and outgoing legs.
    const inX = x - prev[0];
    const inZ = z - prev[1];
    const hx = i > 0 && i < pts.length - 1 ? dx / Math.hypot(dx, dz) + inX / Math.hypot(inX, inZ) : dx;
    const hz = i > 0 && i < pts.length - 1 ? dz / Math.hypot(dx, dz) + inZ / Math.hypot(inX, inZ) : dz;
    let heading = (Math.atan2(hx, -hz) / DEG + 360) % 360;
    if (!Number.isFinite(heading)) heading = 0;
    let ground = Math.max(world.groundHeight(x, z), 0);
    // Make sure the leg toward this ring clears terrain.
    if (i > 0) {
      for (let s = 0; s <= 1; s += 0.05) {
        const px = prev[0] + (x - prev[0]) * s;
        const pz = prev[1] + (z - prev[1]) * s;
        ground = Math.max(ground, world.groundHeight(px, pz) - agl * 0.5);
      }
    }
    rings.push({ x, y: ground + agl, z, heading, radius });
  }
  return rings;
}

function runwayEnd(world: WorldMap, code: string, end: 0 | 1): { ap: Airport; e: RunwayEnd } {
  const ap = world.getAirport(code);
  return { ap, e: ap.runway.ends[end] };
}

/** Point `dist` metres before a runway threshold on the extended centreline. */
function onFinal(world: WorldMap, code: string, end: 0 | 1, dist: number, aglAtThreshold = 0): [number, number, number] {
  const { e } = runwayEnd(world, code, end);
  return [e.x - e.dx * dist, e.z - e.dz * dist, aglAtThreshold + Math.tan(3 * DEG) * dist];
}

export function buildMissions(world: WorldMap): MissionDef[] {
  const final09 = onFinal(world, 'HBR', 0, 3800);
  /** Ring position on an extended centreline at a fixed height above ground. */
  const valley = (dist: number, agl: number): [number, number, number] => {
    const [x, z] = onFinal(world, 'EGL', 0, dist);
    return [x, z, agl];
  };
  const missions: MissionDef[] = [
    {
      id: 'first-flight',
      title: 'First Flight',
      category: 'Training',
      difficulty: 1,
      description: 'Learn the basics: take off from Harbor International, climb out, fly a circuit through four rings and land back on runway 09.',
      aircraft: 'kestrel',
      time: 'day',
      weather: 'clear',
      wind: { speed: 3, from: 90 },
      spawn: { kind: 'runway', airport: 'HBR', end: 0 },
      stages: [
        { type: 'takeoff', text: 'Hold R/Shift for full power. At 55 kt gently pull back (S / ↓) to lift off.' },
        { type: 'altitude', agl: 250, text: 'Climb to 800 ft above the ground. Keep the wings level.' },
        {
          type: 'rings',
          rings: course(world, [
            [1200, 7200, 300],
            [1800, 3600, 320],
            [-3600, 2600, 320],
            [final09[0] - 1200, final09[1] - 900, 280],
          ], 38),
          text: 'Fly through the rings. Bank with A/D and pull gently to turn.',
        },
        { type: 'land', airport: 'HBR', end: 0, text: 'Line up with runway 09, reduce power (F), add flaps (V) and land. Brake with Space.' },
      ],
      tips: ['Use the flight-path marker (circle) to see where you are going.', 'Press Z to engage the autopilot if you need a break.'],
    },
    {
      id: 'harbor-rings',
      title: 'Harbor Ring Run',
      category: 'Racing',
      difficulty: 2,
      description: 'A low-level race around the Port Harbor skyline and coastline in the Vortex aerobatic plane. Beat the clock!',
      aircraft: 'vortex',
      allowedAircraft: ['vortex', 'kestrel', 'falcon'],
      time: 'day',
      weather: 'clear',
      spawn: { kind: 'air', x: -600, z: 11600, agl: 140, heading: 75, speed: 1.1 },
      stages: [
        {
          type: 'rings',
          rings: course(world, [
            [1400, 11500, 110],
            [3400, 11950, 80],
            [5600, 11700, 80],
            [7300, 10300, 140],
            [7500, 8200, 220],
            [6200, 6700, 180],
            [4100, 6300, 160],
            [2300, 7200, 160],
            [2000, 9100, 200],
            [4200, 9300, 330],
            [6000, 9600, 220],
            [7800, 11200, 90],
          ], 32),
          text: 'Fly through every ring in order. Smoke on with K!',
        },
      ],
      parTime: 95,
      tips: ['The Vortex rolls very fast — use small inputs.', 'Watch the ring arrow on the HUD.'],
    },
    {
      id: 'mountain-pass',
      title: 'Mountain Pass',
      category: 'Racing',
      difficulty: 2,
      description: 'Thread the valley into the mountains and land on the Eagle Peak strip. Clouds are building over the ridges.',
      aircraft: 'kestrel',
      allowedAircraft: ['kestrel', 'vortex'],
      time: 'day',
      weather: 'cloudy',
      wind: { speed: 4, from: 50 },
      spawn: { kind: 'air', x: -3200, z: 3200, agl: 250, heading: 40, speed: 1 },
      stages: [
        {
          type: 'rings',
          rings: course(world, [valley(8000, 150), valley(6200, 130), valley(4400, 120), valley(2600, 110)], 40),
          text: 'Follow the valley through the rings.',
        },
        { type: 'land', airport: 'EGL', end: 0, text: 'Land on runway 05 at Eagle Peak — it is short, so touch down early!' },
      ],
      tips: ['Fly the approach slowly with full flaps.', 'Terrain rises fast — keep an eye on the PULL UP warning.'],
    },
    {
      id: 'precision-landing',
      title: 'Precision Landing',
      category: 'Landing',
      difficulty: 1,
      description: 'You are on a 6 km final for runway 27 at Harbor International. Touch down gently, on the centreline, in the touchdown zone.',
      aircraft: 'kestrel',
      allowedAircraft: ['kestrel', 'vortex', 'falcon', 'skyliner'],
      time: 'day',
      weather: 'clear',
      wind: { speed: 5, from: 250 },
      spawn: { kind: 'approach', airport: 'HBR', end: 1, distance: 6000 },
      stages: [{ type: 'land', airport: 'HBR', end: 1, text: 'Follow the glide slope (PAPI: two white, two red) and land on runway 27.' }],
      tips: ['Aim for the large white aiming-point markers.', 'Flare a few metres above the runway: pull back gently and reduce power to idle.'],
    },
    {
      id: 'short-field',
      title: 'Short Field at Sunset',
      category: 'Landing',
      difficulty: 3,
      description: 'Land on the 1100 m Eagle Peak strip from the north-east as the sun sets behind the ridges. Gusty mountain winds.',
      aircraft: 'kestrel',
      allowedAircraft: ['kestrel', 'vortex'],
      time: 'sunset',
      weather: 'cloudy',
      wind: { speed: 7, from: 220 },
      spawn: { kind: 'approach', airport: 'EGL', end: 1, distance: 5000 },
      stages: [{ type: 'land', airport: 'EGL', end: 1, text: 'Land on runway 23 and stop before the end.' }],
      tips: ['Fly the approach slow: about 60 kt with full flaps.', 'Brake firmly once all wheels are down.'],
    },
    {
      id: 'supersonic-sprint',
      title: 'Supersonic Sprint',
      category: 'Racing',
      difficulty: 2,
      description: 'Light the afterburner and blast through a 30 km ring course at wave-top height. Can you break the sound barrier?',
      aircraft: 'falcon',
      allowedAircraft: ['falcon'],
      time: 'day',
      weather: 'clear',
      spawn: { kind: 'air', x: -17000, z: 16500, agl: 140, heading: 90, speed: 1.3 },
      stages: [
        {
          type: 'rings',
          rings: course(world, Array.from({ length: 12 }, (_, i) => [-13000 + i * 2600, 16500 + Math.sin(i * 0.9) * 500, 120 + (i % 3) * 30] as [number, number, number]), 55),
          text: 'Full throttle (afterburner) and fly through the rings!',
        },
      ],
      parTime: 95,
      tips: ['Afterburner engages above 97 % throttle.', 'Do not pull too hard at high speed — G limits!'],
    },
    {
      id: 'commuter-run',
      title: 'Commuter Run',
      category: 'Travel',
      difficulty: 2,
      description: 'Fly the SkyLiner from Harbor International to North Field. Take off from runway 27, follow the waypoints and land on runway 36.',
      aircraft: 'skyliner',
      allowedAircraft: ['skyliner', 'kestrel', 'falcon'],
      time: 'day',
      weather: 'cloudy',
      wind: { speed: 5, from: 10 },
      spawn: { kind: 'runway', airport: 'HBR', end: 1 },
      stages: [
        { type: 'takeoff', text: 'Flaps 1 (]), full power, rotate at 150 kt. Raise the gear (G) after lift-off.' },
        {
          type: 'rings',
          rings: course(world, [
            [-7500, 7400, 500],
            [-10500, 3000, 600],
            [onFinal(world, 'NFD', 0, 7000)[0], onFinal(world, 'NFD', 0, 7000)[1], 420],
          ], 70),
          text: 'Follow the rings toward North Field.',
        },
        { type: 'land', airport: 'NFD', end: 0, text: 'Gear down, full flaps and land on runway 36. Ground spoilers deploy at idle.' },
      ],
      parTime: 330,
      tips: ['Heavy jets react slowly — plan ahead.', 'Use the autopilot (Z) for the cruise segment.'],
    },
    {
      id: 'night-approach',
      title: 'Night Approach',
      category: 'Landing',
      difficulty: 2,
      description: 'Bring the SkyLiner into Harbor International at night. Follow the approach lights and the PAPI to runway 09.',
      aircraft: 'skyliner',
      allowedAircraft: ['skyliner', 'kestrel', 'falcon', 'vortex'],
      time: 'night',
      weather: 'clear',
      wind: { speed: 3, from: 100 },
      spawn: { kind: 'approach', airport: 'HBR', end: 0, distance: 8000 },
      stages: [{ type: 'land', airport: 'HBR', end: 0, text: 'Follow the flashing approach lights to runway 09 and land.' }],
      tips: ['Turn the landing lights on with L.', 'Keep the PAPI at two white, two red.'],
    },
    {
      id: 'dead-stick',
      title: 'Dead Stick',
      category: 'Challenge',
      difficulty: 3,
      description: 'Your engine is about to fail. Glide the Kestrel to North Field and land without power.',
      aircraft: 'kestrel',
      allowedAircraft: ['kestrel'],
      time: 'day',
      weather: 'clear',
      wind: { speed: 2, from: 0 },
      spawn: { kind: 'air', x: -4200, z: -900, agl: 950, heading: 300, speed: 1 },
      engineFailureAt: 6,
      stages: [{ type: 'land', airport: 'NFD', text: 'Engine failure! Best glide is about 65 kt. Land on either runway at North Field.' }],
      tips: ['Trade speed for distance: do not stretch the glide too slow.', 'Lower flaps only when the runway is made.'],
    },
    {
      id: 'storm-landing',
      title: 'Storm Landing',
      category: 'Challenge',
      difficulty: 3,
      description: 'A storm is sweeping the island. Land on runway 27 at Harbor International in a gusty crosswind and low visibility.',
      aircraft: 'kestrel',
      allowedAircraft: ['kestrel', 'skyliner', 'falcon'],
      time: 'day',
      weather: 'storm',
      wind: { speed: 11, from: 215 },
      spawn: { kind: 'approach', airport: 'HBR', end: 1, distance: 5000 },
      stages: [{ type: 'land', airport: 'HBR', end: 1, text: 'Crab into the wind, then straighten with rudder just before touchdown.' }],
      tips: ['Expect turbulence below the clouds.', 'Add a few knots to your approach speed in gusts.'],
    },
    {
      id: 'island-hopper',
      title: 'Island Hopper',
      category: 'Travel',
      difficulty: 2,
      description: 'Cross the channel to Gull Island and land on its little runway. Watch the crosswind off the sea.',
      aircraft: 'kestrel',
      allowedAircraft: ['kestrel', 'vortex', 'falcon'],
      time: 'dawn',
      weather: 'clear',
      wind: { speed: 5, from: 160 },
      spawn: { kind: 'air', x: 11500, z: 6200, agl: 450, heading: 100, speed: 1 },
      stages: [
        { type: 'waypoint', x: 15500, z: 4600, radius: 600, label: 'Channel', text: 'Head east across the channel.' },
        { type: 'land', airport: 'GUL', text: 'Land on Gull Island — either runway direction.' },
      ],
      parTime: 200,
      tips: ['Runway 14 faces the wind best today.'],
    },
  ];
  return missions;
}

// ------------------------------------------------------------------ runtime

export interface TouchdownInfo {
  sinkRate: number;
  onRunway: boolean;
  airport: string | null;
  endIndex: number;
  distFromThreshold: number;
  centreline: number;
  groundSpeed: number;
}

export interface MissionResult {
  success: boolean;
  reason: string;
  score: number;
  maxScore: number;
  stars: number;
  time: number;
  breakdown: { label: string; value: string; points: number }[];
}

export interface Objective {
  text: string;
  label: string;
  target: Vector3 | null;
  progress: string;
}

export class MissionRuntime {
  stageIndex = 0;
  ringIndex = 0;
  time = 0;
  state: 'running' | 'success' | 'failed' = 'running';
  failReason = '';
  ringsPassed = 0;
  touchdown: TouchdownInfo | null = null;
  private stoppedFor = 0;
  private landScore = 0;
  private breakdown: MissionResult['breakdown'] = [];
  engineFailed = false;
  onEvent: ((kind: 'ring' | 'stage' | 'success' | 'fail' | 'engine', msg: string) => void) | null = null;
  private result: MissionResult | null = null;
  readonly totalRings: number;

  constructor(
    readonly def: MissionDef,
    private world: WorldMap,
  ) {
    this.totalRings = def.stages.reduce((n, s) => n + (s.type === 'rings' ? s.rings.length : 0), 0);
  }

  get stage(): Stage | null {
    return this.def.stages[this.stageIndex] ?? null;
  }

  /** All rings with their status for rendering. */
  ringStates(): { ring: Ring; state: 'next' | 'future' | 'done' }[] {
    const out: { ring: Ring; state: 'next' | 'future' | 'done' }[] = [];
    this.def.stages.forEach((s, si) => {
      if (s.type !== 'rings') return;
      s.rings.forEach((r, ri) => {
        let st: 'next' | 'future' | 'done';
        if (si < this.stageIndex) st = 'done';
        else if (si > this.stageIndex) st = 'future';
        else st = ri < this.ringIndex ? 'done' : ri === this.ringIndex ? 'next' : 'future';
        out.push({ ring: r, state: st });
      });
    });
    return out;
  }

  private advance(): void {
    this.stageIndex++;
    this.ringIndex = 0;
    if (this.stageIndex >= this.def.stages.length) this.complete();
    else this.onEvent?.('stage', this.stage?.text ?? '');
  }

  private complete(): void {
    if (this.state !== 'running') return;
    this.state = 'success';
    this.result = this.computeResult(true, 'Mission complete!');
    this.onEvent?.('success', 'Mission complete!');
  }

  fail(reason: string): void {
    if (this.state !== 'running') return;
    this.state = 'failed';
    this.failReason = reason;
    this.result = this.computeResult(false, reason);
    this.onEvent?.('fail', reason);
  }

  getResult(): MissionResult | null {
    return this.result;
  }

  update(dt: number, m: FlightModel, prev: Vector3): void {
    if (this.state !== 'running') return;
    this.time += dt;
    if (this.def.engineFailureAt !== undefined && !this.engineFailed && this.time >= this.def.engineFailureAt) {
      this.engineFailed = true;
      m.engineRunning = false;
      this.onEvent?.('engine', 'ENGINE FAILURE');
    }
    if (this.engineFailed) m.engineRunning = false;
    if (this.def.timeLimit && this.time > this.def.timeLimit) return this.fail('Out of time');
    const st = this.stage;
    if (!st) return;
    switch (st.type) {
      case 'takeoff':
        if (!m.onGround && m.telemetry.agl > 15) this.advance();
        break;
      case 'altitude':
        if (m.telemetry.agl >= st.agl) this.advance();
        break;
      case 'waypoint':
        if (Math.hypot(m.position.x - st.x, m.position.z - st.z) < st.radius) this.advance();
        break;
      case 'rings': {
        const r = st.rings[this.ringIndex];
        if (r && this.crossed(r, prev, m.position)) {
          this.ringIndex++;
          this.ringsPassed++;
          this.onEvent?.('ring', `${this.ringsPassed}/${this.totalRings}`);
          if (this.ringIndex >= st.rings.length) this.advance();
        }
        break;
      }
      case 'land': {
        const t = m.telemetry;
        if (m.wheelsOnGround === m.spec.gear.points.length && t.groundSpeed < 1.0) this.stoppedFor += dt;
        else this.stoppedFor = 0;
        if (this.touchdown && this.stoppedFor > 1.2) {
          const ap = this.world.runwayAt(m.position.x, m.position.z, 8);
          const target = this.world.getAirport(st.airport);
          if (!ap || ap.code !== target.code) {
            if (this.world.isPavedArea(m.position.x, m.position.z) && this.touchdown.onRunway && this.touchdown.airport === target.code) {
              // Rolled off onto the taxiway: accept.
            } else return this.fail(ap ? `Landed at the wrong airport (${ap.name})` : 'Ran off the runway');
          }
          this.landScore = this.scoreLanding(this.touchdown, m.spec.gear.maxSinkRate);
          this.advance();
        }
        break;
      }
    }
  }

  /** Called with flight-model events. */
  onFlightEvent(e: FlightEvent, m: FlightModel): void {
    if (this.state !== 'running') return;
    if (e.type === 'crash') return this.fail(e.reason);
    if (e.type !== 'touchdown') return;
    const st = this.stage;
    if (!st || st.type !== 'land') {
      // Touching down outside a landing stage (e.g. before taking off is fine).
      if (st && st.type !== 'takeoff' && e.surface !== 'runway' && e.surface !== 'paved') return this.fail('Unplanned landing');
      return;
    }
    const target = this.world.getAirport(st.airport);
    const ap = this.world.runwayAt(e.x, e.z, 2);
    const hdg = m.telemetry.heading;
    let endIndex = 0;
    let best = 999;
    target.runway.ends.forEach((end, i) => {
      const d = Math.abs(angleDiffDeg(hdg, end.heading));
      if (d < best) {
        best = d;
        endIndex = i;
      }
    });
    const end = target.runway.ends[endIndex];
    const rx = e.x - end.x;
    const rz = e.z - end.z;
    const along = rx * end.dx + rz * end.dz;
    const across = Math.abs(rx * end.dz - rz * end.dx);
    this.touchdown = {
      sinkRate: e.sinkRate,
      onRunway: !!ap && ap.code === target.code,
      airport: ap?.code ?? null,
      endIndex,
      distFromThreshold: along,
      centreline: across,
      groundSpeed: e.groundSpeed,
    };
    if (!ap) {
      if (along < 0 && across < target.runway.width) return this.fail('Landed short of the runway');
      return this.fail('Touched down off the runway');
    }
    if (ap.code !== target.code) return this.fail(`Wrong airport — this is ${ap.name}`);
    if (st.end !== undefined && endIndex !== st.end) return this.fail(`Wrong runway — expected ${target.runway.ends[st.end].ident}`);
  }

  private crossed(r: Ring, a: Vector3, b: Vector3): boolean {
    const d = headingToDir(r.heading);
    const sa = (a.x - r.x) * d.x + (a.z - r.z) * d.z;
    const sb = (b.x - r.x) * d.x + (b.z - r.z) * d.z;
    if (sa > 0 || sb < 0) return false;
    const t = sa / (sa - sb || 1e-9);
    const px = a.x + (b.x - a.x) * t;
    const py = a.y + (b.y - a.y) * t;
    const pz = a.z + (b.z - a.z) * t;
    return Math.hypot(px - r.x, py - r.y, pz - r.z) <= r.radius * 1.05;
  }

  private scoreLanding(td: TouchdownInfo, maxSink: number): number {
    let s = 1000;
    // Sink rate judged relative to what the landing gear is built for (airliners land firmer).
    const sinkPen = Math.max(0, td.sinkRate / maxSink - 0.15) * 650;
    const clPen = td.centreline * 9;
    const zonePen = Math.max(0, Math.abs(td.distFromThreshold - 300) - 180) * 0.7;
    s -= sinkPen + clPen + zonePen;
    this.breakdown.push(
      { label: 'Touchdown rate', value: `${Math.round(td.sinkRate * 196.85)} ft/min`, points: -Math.round(sinkPen) },
      { label: 'Centreline offset', value: `${td.centreline.toFixed(1)} m`, points: -Math.round(clPen) },
      { label: 'Touchdown point', value: `${Math.round(td.distFromThreshold)} m past threshold`, points: -Math.round(zonePen) },
    );
    return Math.max(100, Math.round(s));
  }

  /** Current objective for the HUD. */
  objective(m: FlightModel): Objective {
    const st = this.stage;
    if (!st) return { text: '', label: '', target: null, progress: '' };
    switch (st.type) {
      case 'takeoff':
        return { text: st.text ?? 'Take off', label: 'TAKE OFF', target: null, progress: '' };
      case 'altitude':
        return { text: st.text ?? `Climb to ${st.agl} m`, label: 'CLIMB', target: null, progress: `${Math.round(m.telemetry.agl)}/${st.agl} m AGL` };
      case 'waypoint':
        return { text: st.text ?? st.label, label: st.label.toUpperCase(), target: new Vector3(st.x, Math.max(this.world.groundHeight(st.x, st.z), 0) + 150, st.z), progress: '' };
      case 'rings': {
        const r = st.rings[this.ringIndex];
        return { text: st.text ?? 'Fly through the rings', label: 'RING', target: r ? new Vector3(r.x, r.y, r.z) : null, progress: `${this.ringsPassed}/${this.totalRings}` };
      }
      case 'land': {
        const ap = this.world.getAirport(st.airport);
        const ends = st.end !== undefined ? [ap.runway.ends[st.end]] : ap.runway.ends;
        // Target the nearest permitted threshold's aiming point.
        let bestE = ends[0];
        let bd = Infinity;
        for (const e of ends) {
          const d = Math.hypot(m.position.x - (e.x - e.dx * 3000), m.position.z - (e.z - e.dz * 3000));
          if (d < bd) {
            bd = d;
            bestE = e;
          }
        }
        return {
          text: st.text ?? `Land at ${ap.name}`,
          label: `RWY ${bestE.ident}`,
          target: new Vector3(bestE.x + bestE.dx * 300, ap.elevation, bestE.z + bestE.dz * 300),
          progress: '',
        };
      }
    }
  }

  private computeResult(success: boolean, reason: string): MissionResult {
    const def = this.def;
    const ringPts = this.ringsPassed * 100;
    const hasLand = def.stages.some((s) => s.type === 'land');
    let timePts = 0;
    if (success && def.parTime) timePts = Math.round(1000 * clamp(def.parTime / this.time, 0, 1.25));
    const landPts = success && hasLand ? this.landScore : 0;
    const maxScore = this.totalRings * 100 + (hasLand ? 1000 : 0) + (def.parTime ? 1000 : 0) + (def.stages.some((s) => s.type === 'takeoff') ? 200 : 0);
    const takeoffPts = def.stages.some((s) => s.type === 'takeoff') && this.stageIndex > 0 ? 200 : 0;
    const score = success ? ringPts + timePts + landPts + takeoffPts : 0;
    const pct = maxScore > 0 ? score / maxScore : 0;
    const stars = !success ? 0 : pct >= 0.85 ? 3 : pct >= 0.65 ? 2 : 1;
    const breakdown: MissionResult['breakdown'] = [];
    if (takeoffPts) breakdown.push({ label: 'Take-off', value: 'Complete', points: takeoffPts });
    if (this.totalRings) breakdown.push({ label: 'Rings', value: `${this.ringsPassed}/${this.totalRings}`, points: ringPts });
    if (def.parTime && success) breakdown.push({ label: 'Time bonus', value: `${this.time.toFixed(1)} s (par ${def.parTime} s)`, points: timePts });
    if (hasLand && success) breakdown.push({ label: 'Landing quality', value: `${landPts}/1000`, points: landPts }, ...this.breakdown);
    return { success, reason, score, maxScore, stars, time: this.time, breakdown };
  }
}
