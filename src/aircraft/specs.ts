/**
 * Aircraft definitions: mass properties, aerodynamic stability derivatives,
 * propulsion, landing gear and handling limits.
 *
 * Aerodynamic coefficients use the conventional aero body frame
 * (x forward, y right, z down) with *our* control sign convention:
 *   pitch input +1 = nose up, roll input +1 = roll right, yaw input +1 = nose right.
 * So control derivatives Cmde, Clda, Cndr are positive, while the damping and
 * stability derivatives keep their usual signs (Cma<0, Cmq<0, Clp<0, Cnr<0, Cnb>0, Clb<0).
 *
 * Geometry points (gear, collision) are in the three.js body frame:
 *   +X right, +Y up, -Z forward, origin at the centre of gravity.
 */
import { DEG } from '../core/math';

export interface AeroCoeffs {
  CL0: number;
  CLa: number;
  CLq: number;
  CLde: number;
  /** Positive stall angle of attack (rad). */
  alphaStall: number;
  /** Negative stall angle of attack (rad, negative). */
  alphaStallNeg: number;
  CD0: number;
  /** Induced drag factor k = 1/(pi e AR). */
  k: number;
  CYb: number;
  CYdr: number;
  Clb: number;
  Clp: number;
  Clr: number;
  Clda: number;
  Cldr: number;
  Cm0: number;
  Cma: number;
  Cmq: number;
  Cmde: number;
  Cnb: number;
  Cnp: number;
  Cnr: number;
  Cnda: number;
  Cndr: number;
  /** Extra transonic drag rise for fast jets. */
  waveDrag?: number;
}

export type CollisionKind = 'nose' | 'tail' | 'wing' | 'fin' | 'belly' | 'engine';

export interface GearPoint {
  x: number;
  y: number;
  z: number;
  steer?: boolean;
  brake?: boolean;
}

export interface CollisionPoint {
  x: number;
  y: number;
  z: number;
  kind: CollisionKind;
}

export type EngineType = 'piston' | 'jet';

export interface EngineSpec {
  type: EngineType;
  /** Shaft power for piston engines (W). */
  maxPower: number;
  /** Static thrust at full power, sea level (N). For jets: max dry thrust. */
  staticThrust: number;
  afterburnerThrust?: number;
  /** Spool time constants (s). */
  spoolUp: number;
  spoolDown: number;
  idleRPM: number;
  maxRPM: number;
  /** Number of engines (visual/audio only). */
  count: number;
  /** High-bypass turbofan: thrust lapses with Mach. */
  highBypass?: boolean;
}

export interface AircraftSpec {
  id: string;
  name: string;
  role: string;
  description: string;
  emptyMass: number;
  fuelCapacity: number;
  /** kg/s at full dry power. */
  fuelBurn: number;
  /** Moments of inertia about roll, pitch and yaw axes (kg m^2). */
  inertia: { roll: number; pitch: number; yaw: number };
  wingArea: number;
  wingSpan: number;
  chord: number;
  aero: AeroCoeffs;
  flaps: {
    detents: number[];
    /** Lift, drag and pitching moment increments at full flap. */
    CL: number;
    CD: number;
    Cm: number;
    /** Change of stall angle at full flap (rad, usually negative). */
    alphaStall: number;
    /** Fraction of full travel per second. */
    rate: number;
  };
  gear: {
    retractable: boolean;
    CD: number;
    retractTime: number;
    points: GearPoint[];
    /** Strut travel before bottoming out (m). */
    travel: number;
    /** Sink rate that collapses the gear (m/s). */
    maxSinkRate: number;
    wheelRadius: number;
  };
  engine: EngineSpec;
  /** Speedbrake / spoilers. Ground spoilers auto-deploy on touchdown at idle. */
  speedbrake?: { CD: number; CL: number; groundSpoilers: boolean };
  limits: { vne: number; gMax: number; gMin: number };
  /** Reference speeds (m/s) used by the HUD, assists and mission set-up. */
  speeds: { stall: number; rotate: number; approach: number; cruise: number; climb: number };
  collision: CollisionPoint[];
  /** Radius for obstacle (building/tree) checks around the CG. */
  bodyRadius: number;
  /** Fly-by-wire limits for the "Easy" flight model. */
  fbw: { pitchRate: number; rollRate: number; yawRate: number; gMax: number };
  camera: { distance: number; height: number; cockpit: [number, number, number] };
  hasSmoke: boolean;
  /** Livery colours (hex). */
  livery: { primary: number; secondary: number; accent: number };
  stats: { speed: number; agility: number; handling: number; range: number };
}

const KESTREL: AircraftSpec = {
  id: 'kestrel',
  name: 'Kestrel T-1',
  role: 'Light trainer',
  description:
    'A forgiving high-wing four-seater. Slow, stable and easy to land — the perfect aircraft to learn the basics.',
  emptyMass: 900,
  fuelCapacity: 150,
  fuelBurn: 0.011,
  inertia: { roll: 1285, pitch: 1825, yaw: 2667 },
  wingArea: 16.2,
  wingSpan: 11.0,
  chord: 1.49,
  aero: {
    CL0: 0.31,
    CLa: 5.14,
    CLq: 3.9,
    CLde: 0.3,
    alphaStall: 15.5 * DEG,
    alphaStallNeg: -12 * DEG,
    CD0: 0.032,
    k: 0.054,
    CYb: -0.31,
    CYdr: 0.19,
    Clb: -0.089,
    Clp: -0.47,
    Clr: 0.096,
    Clda: 0.06,
    Cldr: 0.0147,
    Cm0: -0.015,
    Cma: -0.89,
    Cmq: -12.4,
    Cmde: 0.5,
    Cnb: 0.065,
    Cnp: -0.03,
    Cnr: -0.099,
    Cnda: -0.0053,
    Cndr: 0.03,
  },
  flaps: { detents: [0, 10, 20, 30], CL: 0.62, CD: 0.06, Cm: -0.06, alphaStall: -2 * DEG, rate: 0.35 },
  gear: {
    retractable: false,
    CD: 0.008,
    retractTime: 1,
    points: [
      { x: 0, y: -1.3, z: -1.55, steer: true },
      { x: -1.3, y: -1.3, z: 0.45, brake: true },
      { x: 1.3, y: -1.3, z: 0.45, brake: true },
    ],
    travel: 0.32,
    maxSinkRate: 4.2,
    wheelRadius: 0.22,
  },
  engine: {
    type: 'piston',
    maxPower: 125000,
    staticThrust: 3100,
    spoolUp: 0.6,
    spoolDown: 0.8,
    idleRPM: 650,
    maxRPM: 2700,
    count: 1,
  },
  limits: { vne: 82, gMax: 3.8, gMin: -1.5 },
  speeds: { stall: 25, rotate: 28, approach: 34, cruise: 55, climb: 38 },
  collision: [
    { x: 0, y: -0.05, z: -2.65, kind: 'nose' },
    { x: 0, y: -0.35, z: 4.9, kind: 'tail' },
    { x: 0, y: 1.75, z: 5.6, kind: 'fin' },
    { x: -5.5, y: 1.05, z: 0.1, kind: 'wing' },
    { x: 5.5, y: 1.05, z: 0.1, kind: 'wing' },
    { x: 0, y: -0.75, z: -1.0, kind: 'belly' },
    { x: 0, y: -0.6, z: 1.6, kind: 'belly' },
  ],
  bodyRadius: 2.5,
  fbw: { pitchRate: 0.55, rollRate: 1.2, yawRate: 0.35, gMax: 3.5 },
  camera: { distance: 17, height: 4.2, cockpit: [-0.3, 0.75, -0.45] },
  hasSmoke: false,
  livery: { primary: 0xf4f4f0, secondary: 0x1d4f91, accent: 0xd8352a },
  stats: { speed: 2, agility: 2, handling: 5, range: 4 },
};

const VORTEX: AircraftSpec = {
  id: 'vortex',
  name: 'Vortex A-300',
  role: 'Aerobatic',
  description:
    'A high-powered aerobatic monoplane with a symmetric wing. Lightning-fast roll rate, inverted flight capable, with a smoke system for display flying.',
  emptyMass: 680,
  fuelCapacity: 120,
  fuelBurn: 0.02,
  inertia: { roll: 650, pitch: 1150, yaw: 1650 },
  wingArea: 10.7,
  wingSpan: 7.4,
  chord: 1.45,
  aero: {
    CL0: 0.0,
    CLa: 4.9,
    CLq: 4.2,
    CLde: 0.35,
    alphaStall: 16 * DEG,
    alphaStallNeg: -16 * DEG,
    CD0: 0.029,
    k: 0.078,
    CYb: -0.35,
    CYdr: 0.22,
    Clb: -0.03,
    Clp: -0.42,
    Clr: 0.06,
    Clda: 0.14,
    Cldr: 0.01,
    Cm0: 0.0,
    Cma: -0.55,
    Cmq: -11,
    Cmde: 0.5,
    Cnb: 0.07,
    Cnp: -0.02,
    Cnr: -0.11,
    Cnda: -0.004,
    Cndr: 0.045,
  },
  flaps: { detents: [0, 15], CL: 0.3, CD: 0.04, Cm: -0.03, alphaStall: -1 * DEG, rate: 0.6 },
  gear: {
    retractable: false,
    CD: 0.008,
    retractTime: 1,
    points: [
      { x: 0, y: -1.2, z: -1.3, steer: true },
      { x: -1.05, y: -1.2, z: 0.35, brake: true },
      { x: 1.05, y: -1.2, z: 0.35, brake: true },
    ],
    travel: 0.3,
    maxSinkRate: 4.5,
    wheelRadius: 0.2,
  },
  engine: {
    type: 'piston',
    maxPower: 235000,
    staticThrust: 5200,
    spoolUp: 0.45,
    spoolDown: 0.6,
    idleRPM: 800,
    maxRPM: 2800,
    count: 1,
  },
  limits: { vne: 115, gMax: 10, gMin: -10 },
  speeds: { stall: 28, rotate: 30, approach: 38, cruise: 75, climb: 50 },
  collision: [
    { x: 0, y: 0.0, z: -2.45, kind: 'nose' },
    { x: 0, y: -0.15, z: 4.3, kind: 'tail' },
    { x: 0, y: 1.35, z: 4.4, kind: 'fin' },
    { x: -3.7, y: -0.3, z: 0.25, kind: 'wing' },
    { x: 3.7, y: -0.3, z: 0.25, kind: 'wing' },
    { x: 0, y: -0.65, z: -0.6, kind: 'belly' },
    { x: 0, y: -0.45, z: 2.0, kind: 'belly' },
  ],
  bodyRadius: 2,
  fbw: { pitchRate: 1.3, rollRate: 4.2, yawRate: 0.6, gMax: 8 },
  camera: { distance: 13, height: 3.3, cockpit: [0, 0.62, 0.35] },
  hasSmoke: true,
  livery: { primary: 0xd8262e, secondary: 0xffffff, accent: 0x1b1b1b },
  stats: { speed: 3, agility: 5, handling: 3, range: 2 },
};

const FALCON: AircraftSpec = {
  id: 'falcon',
  name: 'Falcon JX-16',
  role: 'Jet fighter',
  description:
    'A supersonic single-engine fighter with afterburner. Blistering speed and climb rate, but a high landing speed demands precision.',
  emptyMass: 9200,
  fuelCapacity: 3200,
  fuelBurn: 1.9,
  inertia: { roll: 12875, pitch: 75674, yaw: 85552 },
  wingArea: 27.9,
  wingSpan: 9.96,
  chord: 3.45,
  aero: {
    CL0: 0.08,
    CLa: 3.6,
    CLq: 2.5,
    CLde: 0.25,
    alphaStall: 25 * DEG,
    alphaStallNeg: -15 * DEG,
    CD0: 0.0205,
    k: 0.12,
    CYb: -0.9,
    CYdr: 0.15,
    Clb: -0.07,
    Clp: -0.33,
    Clr: 0.04,
    Clda: 0.042,
    Cldr: 0.005,
    Cm0: 0.0,
    Cma: -0.42,
    Cmq: -9,
    Cmde: 0.22,
    Cnb: 0.13,
    Cnp: -0.01,
    Cnr: -0.32,
    Cnda: -0.001,
    Cndr: 0.04,
    waveDrag: 0.034,
  },
  flaps: { detents: [0, 20], CL: 0.35, CD: 0.05, Cm: -0.02, alphaStall: -2 * DEG, rate: 0.5 },
  speedbrake: { CD: 0.06, CL: 0, groundSpoilers: false },
  gear: {
    retractable: true,
    CD: 0.022,
    retractTime: 3.2,
    points: [
      { x: 0, y: -2.05, z: -4.1, steer: true },
      { x: -1.25, y: -2.05, z: 0.42, brake: true },
      { x: 1.25, y: -2.05, z: 0.42, brake: true },
    ],
    travel: 0.38,
    maxSinkRate: 5.5,
    wheelRadius: 0.36,
  },
  engine: {
    type: 'jet',
    maxPower: 0,
    staticThrust: 79000,
    afterburnerThrust: 129000,
    spoolUp: 2.4,
    spoolDown: 1.8,
    idleRPM: 0.62,
    maxRPM: 1.0,
    count: 1,
  },
  limits: { vne: 420, gMax: 9, gMin: -3 },
  speeds: { stall: 66, rotate: 78, approach: 80, cruise: 240, climb: 180 },
  collision: [
    { x: 0, y: 0.0, z: -7.6, kind: 'nose' },
    { x: 0, y: -0.75, z: 6.4, kind: 'tail' },
    { x: 0, y: 3.0, z: 6.2, kind: 'fin' },
    { x: -5.0, y: -0.25, z: 1.6, kind: 'wing' },
    { x: 5.0, y: -0.25, z: 1.6, kind: 'wing' },
    { x: 0, y: -1.05, z: -2.5, kind: 'belly' },
    { x: 0, y: -1.0, z: 3.0, kind: 'belly' },
  ],
  bodyRadius: 3.5,
  fbw: { pitchRate: 0.6, rollRate: 4.0, yawRate: 0.3, gMax: 9 },
  camera: { distance: 24, height: 5.5, cockpit: [0, 1.15, -3.9] },
  hasSmoke: true,
  livery: { primary: 0x7c8794, secondary: 0x5a636e, accent: 0xf2c230 },
  stats: { speed: 5, agility: 4, handling: 3, range: 3 },
};

const SKYLINER: AircraftSpec = {
  id: 'skyliner',
  name: 'SkyLiner 320',
  role: 'Twin-jet airliner',
  description:
    'A 150-seat narrow-body airliner. Heavy, smooth and stable with powerful high-lift flaps. Plan ahead — it takes time to slow down.',
  emptyMass: 50000,
  fuelCapacity: 12000,
  fuelBurn: 1.6,
  inertia: { roll: 950000, pitch: 2600000, yaw: 3400000 },
  wingArea: 122.6,
  wingSpan: 34.1,
  chord: 4.29,
  aero: {
    CL0: 0.27,
    CLa: 5.2,
    CLq: 4.5,
    CLde: 0.3,
    alphaStall: 13.5 * DEG,
    alphaStallNeg: -9 * DEG,
    CD0: 0.026,
    k: 0.043,
    CYb: -0.7,
    CYdr: 0.14,
    Clb: -0.12,
    Clp: -0.45,
    Clr: 0.12,
    Clda: 0.04,
    Cldr: 0.01,
    Cm0: 0.02,
    Cma: -1.1,
    Cmq: -26,
    Cmde: 0.75,
    Cnb: 0.16,
    Cnp: -0.03,
    Cnr: -0.24,
    Cnda: -0.002,
    Cndr: 0.065,
    waveDrag: 0.025,
  },
  flaps: { detents: [0, 5, 15, 25, 40], CL: 1.25, CD: 0.075, Cm: -0.1, alphaStall: -1.5 * DEG, rate: 0.12 },
  speedbrake: { CD: 0.07, CL: -0.75, groundSpoilers: true },
  gear: {
    retractable: true,
    CD: 0.02,
    retractTime: 7,
    points: [
      { x: 0, y: -3.6, z: -12.6, steer: true },
      { x: -3.8, y: -3.6, z: 1.6, brake: true },
      { x: 3.8, y: -3.6, z: 1.6, brake: true },
    ],
    travel: 0.45,
    maxSinkRate: 4.0,
    wheelRadius: 0.58,
  },
  engine: {
    type: 'jet',
    maxPower: 0,
    staticThrust: 240000,
    spoolUp: 4.5,
    spoolDown: 3.5,
    idleRPM: 0.22,
    maxRPM: 1.0,
    count: 2,
    highBypass: true,
  },
  limits: { vne: 185, gMax: 2.5, gMin: -1 },
  speeds: { stall: 62, rotate: 76, approach: 72, cruise: 150, climb: 120 },
  collision: [
    { x: 0, y: 0.2, z: -19.2, kind: 'nose' },
    { x: 0, y: -0.55, z: 17.5, kind: 'tail' },
    { x: 0, y: 8.2, z: 17.6, kind: 'fin' },
    { x: -17.0, y: 0.6, z: 5.6, kind: 'wing' },
    { x: 17.0, y: 0.6, z: 5.6, kind: 'wing' },
    { x: -5.7, y: -2.85, z: -3.2, kind: 'engine' },
    { x: 5.7, y: -2.85, z: -3.2, kind: 'engine' },
    { x: 0, y: -2.05, z: -8.0, kind: 'belly' },
    { x: 0, y: -2.0, z: 6.0, kind: 'belly' },
  ],
  bodyRadius: 9,
  fbw: { pitchRate: 0.18, rollRate: 0.35, yawRate: 0.12, gMax: 2.5 },
  camera: { distance: 70, height: 14, cockpit: [-0.55, 1.45, -16.9] },
  hasSmoke: false,
  livery: { primary: 0xf7f8fa, secondary: 0x0f3d7a, accent: 0x31a8e0 },
  stats: { speed: 4, agility: 1, handling: 4, range: 5 },
};

export const AIRCRAFT: AircraftSpec[] = [KESTREL, VORTEX, FALCON, SKYLINER];

export function getAircraft(id: string): AircraftSpec {
  return AIRCRAFT.find((a) => a.id === id) ?? KESTREL;
}

export function maxMass(spec: AircraftSpec): number {
  return spec.emptyMass + spec.fuelCapacity;
}
