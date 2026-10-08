/**
 * Procedural 3D aircraft models with animated control surfaces, propellers,
 * retractable/compressing landing gear, lights and afterburner.
 */
import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  SphereGeometry,
  SpotLight,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
  type Material,
  type Texture,
} from 'three';
import type { AircraftSpec } from './specs';
import type { FlightModel } from '../physics/FlightModel';
import { loft, surface, surfacePoint, type Section, type SurfaceDef } from './geometry';
import { DEG } from '../core/math';
import { makeGlowTexture } from '../world/textures';

type Axis = 'x' | 'y';

interface Hinged {
  pivot: Group;
  inner: Group;
  role: 'aileronL' | 'aileronR' | 'elevator' | 'rudder' | 'flap' | 'spoiler' | 'stabilator';
  max: number;
}

interface GearLeg {
  pivot: Group;
  slider: Group;
  steer: Group | null;
  index: number;
  retractAxis: Axis;
  retractAngle: number;
}

interface Lamp {
  sprite: Sprite;
  kind: 'nav' | 'strobe' | 'beacon';
  phase: number;
}

export interface ModelPoints {
  smoke: Vector3;
  exhaust: Vector3[];
  wingTips: [Vector3, Vector3];
  cockpit: Vector3;
}

const glowTex: { t: Texture | null } = { t: null };
function glow(): Texture {
  if (!glowTex.t) glowTex.t = makeGlowTexture();
  return glowTex.t;
}

export class AircraftModel {
  readonly root = new Group();
  readonly spec: AircraftSpec;
  readonly points: ModelPoints;
  private hinges: Hinged[] = [];
  private gear: GearLeg[] = [];
  private props: { group: Group; blades: Group; disc: Mesh; dir: number }[] = [];
  private lamps: Lamp[] = [];
  private flame: Mesh | null = null;
  private flameMat: MeshBasicMaterial | null = null;
  private nozzleGlow: MeshBasicMaterial | null = null;
  readonly landingLight: SpotLight;
  /** Meshes hidden in the cockpit view (pilot, canopy frame obstructions). */
  readonly exteriorOnly: Object3D[] = [];
  readonly cockpitOnly: Object3D[] = [];
  private materials: Material[] = [];
  private textures: Texture[] = [];
  private time = 0;

  constructor(spec: AircraftSpec) {
    this.spec = spec;
    this.root.name = `aircraft-${spec.id}`;
    this.points = { smoke: new Vector3(), exhaust: [], wingTips: [new Vector3(), new Vector3()], cockpit: new Vector3(...spec.camera.cockpit) };
    switch (spec.id) {
      case 'vortex':
        this.buildVortex();
        break;
      case 'falcon':
        this.buildFalcon();
        break;
      case 'skyliner':
        this.buildSkyliner();
        break;
      default:
        this.buildKestrel();
    }
    this.buildGear();
    this.buildLights();
    this.landingLight = new SpotLight(0xfff4e0, 0, 900, 18 * DEG, 0.4, 1.2);
    const nose = spec.collision.find((c) => c.kind === 'nose')!;
    this.landingLight.position.set(0, nose.y - 0.2, nose.z + 0.5);
    this.landingLight.target.position.set(0, nose.y - 8, nose.z - 60);
    this.root.add(this.landingLight, this.landingLight.target);
    this.root.traverse((o) => {
      if ((o as Mesh).isMesh && !(o as Mesh).userData.noShadow) {
        o.castShadow = true;
      }
    });
  }

  // ------------------------------------------------------------- materials

  private mat(color: number, opts: Partial<{ metal: number; rough: number; side: typeof DoubleSide; map: Texture; emissive: number }> = {}): MeshStandardMaterial {
    const m = new MeshStandardMaterial({ color, metalness: opts.metal ?? 0.25, roughness: opts.rough ?? 0.5 });
    if (opts.side !== undefined) m.side = opts.side;
    if (opts.map) m.map = opts.map;
    if (opts.emissive) m.emissive.setHex(opts.emissive);
    this.materials.push(m);
    return m;
  }

  private glass(): MeshStandardMaterial {
    const m = new MeshStandardMaterial({ color: 0x1d2c3c, metalness: 0.9, roughness: 0.08, transparent: true, opacity: 0.82 });
    this.materials.push(m);
    return m;
  }

  private add(geo: BufferGeometry, mat: Material, parent: Object3D = this.root): Mesh {
    const m = new Mesh(geo, mat);
    parent.add(m);
    return m;
  }

  /** Builds a full surface with optional hinged control surface cut-outs. */
  private wing(
    def: SurfaceDef,
    mat: Material,
    cuts: { role: Hinged['role']; chord: number; span: [number, number]; max: number; mat?: Material }[] = [],
  ): void {
    // Fixed part: forward of the hinge line where cuts exist.
    const hingeFrac = cuts.length ? Math.min(...cuts.map((c) => c.chord)) : 1;
    this.add(surface({ ...def, chord: [0, hingeFrac] }), mat);
    if (!cuts.length) return;
    // Fill trailing-edge segments not covered by any cut.
    const covered = cuts.map((c) => c.span).sort((a, b) => a[0] - b[0]);
    let s = 0;
    for (const [a, b] of covered) {
      if (a > s + 0.001) this.add(surface({ ...def, chord: [hingeFrac, 1], spanRange: [s, a] }), mat);
      s = Math.max(s, b);
    }
    if (s < 0.999) this.add(surface({ ...def, chord: [hingeFrac, 1], spanRange: [s, 1] }), mat);
    for (const c of cuts) this.hinge(def, c.chord, c.span, c.role, c.max, c.mat ?? mat);
  }

  private hinge(def: SurfaceDef, chordFrac: number, span: [number, number], role: Hinged['role'], max: number, mat: Material): void {
    const a = surfacePoint(def, span[0], chordFrac, 0);
    const b = surfacePoint(def, span[1], chordFrac, 0);
    let axis = b.clone().sub(a).normalize();
    // Horizontal surfaces: hinge axis points +X (so +angle = trailing edge down).
    if (def.kind !== 'vertical' && axis.x < 0) axis = axis.negate();
    if (def.kind === 'vertical' && axis.y < 0) axis = axis.negate();
    const origin = def.kind !== 'vertical' && b.x < a.x ? b : a;
    const pivot = new Group();
    pivot.position.copy(origin);
    const q = new Quaternion().setFromUnitVectors(new Vector3(def.kind === 'vertical' ? 0 : 1, def.kind === 'vertical' ? 1 : 0, 0), axis);
    pivot.quaternion.copy(q);
    const inner = new Group();
    pivot.add(inner);
    const geo = surface({ ...def, chord: [chordFrac, 1], spanRange: span });
    // Express geometry in the pivot frame.
    const inv = pivot.matrix.compose(pivot.position, pivot.quaternion, new Vector3(1, 1, 1)).clone().invert();
    geo.applyMatrix4(inv);
    const mesh = new Mesh(geo, mat);
    inner.add(mesh);
    this.root.add(pivot);
    this.hinges.push({ pivot, inner, role, max: max * DEG });
  }

  private propeller(pos: [number, number, number], radius: number, blades: number, spinnerColor: number, dir = 1): void {
    const group = new Group();
    group.position.set(...pos);
    const bladeMat = this.mat(0x1c1c1c, { metal: 0.3, rough: 0.6 });
    const tipMat = this.mat(0xf2c230, { rough: 0.5 });
    const spinner = new Mesh(new ConeGeometry(radius * 0.17, radius * 0.38, 16).rotateX(-Math.PI / 2), this.mat(spinnerColor, { metal: 0.5, rough: 0.3 }));
    spinner.position.z = -radius * 0.12;
    group.add(spinner);
    const bladeGroup = new Group();
    for (let k = 0; k < blades; k++) {
      const holder = new Group();
      holder.rotation.z = (k / blades) * Math.PI * 2;
      const blade = new Mesh(new CylinderGeometry(radius * 0.035, radius * 0.06, radius * 0.92, 6), bladeMat);
      blade.scale.set(1, 1, 0.3);
      blade.position.y = radius * 0.5;
      blade.rotation.y = 0.35;
      const tip = new Mesh(new CylinderGeometry(radius * 0.034, radius * 0.036, radius * 0.1, 6), tipMat);
      tip.scale.set(1, 1, 0.3);
      tip.position.y = radius * 0.98;
      tip.rotation.y = 0.35;
      holder.add(blade, tip);
      bladeGroup.add(holder);
    }
    group.add(bladeGroup);
    const discMat = new MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0, side: DoubleSide, depthWrite: false });
    this.materials.push(discMat);
    const disc = new Mesh(new CylinderGeometry(radius, radius, 0.01, 40, 1, true).rotateX(Math.PI / 2), discMat);
    const discFace = new Mesh(new CylinderGeometry(radius, radius, 0.005, 40).rotateX(Math.PI / 2), discMat);
    disc.userData.noShadow = true;
    discFace.userData.noShadow = true;
    group.add(disc, discFace);
    this.root.add(group);
    this.props.push({ group, blades: bladeGroup, disc: discFace, dir });
  }

  // ------------------------------------------------------------- aircraft

  private buildKestrel(): void {
    const L = this.spec.livery;
    const body = this.mat(L.primary, { metal: 0.15, rough: 0.45 });
    const stripe = this.mat(L.secondary, { metal: 0.2, rough: 0.45 });
    const accent = this.mat(L.accent);
    const fus: Section[] = [
      { z: -2.62, w: 0.26, h: 0.26, y: 0.0 },
      { z: -2.45, w: 0.4, h: 0.38, y: 0.0, e: 2.4 },
      { z: -1.8, w: 0.52, h: 0.5, y: 0.04, e: 2.6 },
      { z: -1.15, w: 0.56, h: 0.62, y: 0.14, e: 3 },
      { z: -0.4, w: 0.6, h: 0.74, y: 0.22, e: 3 },
      { z: 0.6, w: 0.58, h: 0.7, y: 0.22, e: 3 },
      { z: 1.6, w: 0.44, h: 0.52, y: 0.22, e: 2.6 },
      { z: 3.0, w: 0.26, h: 0.36, y: 0.27, e: 2.4 },
      { z: 4.6, w: 0.12, h: 0.22, y: 0.36 },
      { z: 5.35, w: 0.03, h: 0.08, y: 0.42 },
    ];
    this.add(loft(fus), body);
    // Cheat-line stripe.
    this.add(
      loft([
        { z: -2.3, w: 0.405, h: 0.06, y: -0.02 },
        { z: -1.1, w: 0.57, h: 0.07, y: -0.05, e: 3 },
        { z: 1.6, w: 0.45, h: 0.07, y: 0.0, e: 3 },
        { z: 4.5, w: 0.13, h: 0.04, y: 0.25 },
      ]),
      stripe,
    );
    // Cabin glass.
    this.add(
      loft([
        { z: -1.25, w: 0.47, h: 0.18, y: 0.66, e: 3 },
        { z: -0.85, w: 0.6, h: 0.3, y: 0.65, e: 3.5 },
        { z: 0.65, w: 0.6, h: 0.3, y: 0.64, e: 3.5 },
        { z: 1.1, w: 0.48, h: 0.18, y: 0.66, e: 3 },
      ]),
      this.glass(),
    ).userData.glass = true;
    const wingY = 0.95;
    const def = (kind: 'right' | 'left'): SurfaceDef => ({
      root: [kind === 'right' ? 0.3 : -0.3, wingY, -0.8],
      rootChord: 1.62,
      tipChord: 1.2,
      span: 5.2,
      sweep: 0.15,
      dihedral: 1.7,
      thickness: 0.14,
      kind,
    });
    for (const k of ['left', 'right'] as const) {
      this.wing(def(k), body, [
        { role: 'flap', chord: 0.74, span: [0.05, 0.5], max: 35 },
        { role: k === 'left' ? 'aileronL' : 'aileronR', chord: 0.74, span: [0.53, 0.94], max: 18 },
      ]);
      // Tip accent.
      this.add(surface({ ...def(k), spanRange: [0.96, 1] }), accent);
      // Wing strut.
      const sx = k === 'right' ? 1 : -1;
      const a = new Vector3(sx * 0.5, -0.35, -0.3);
      const b = new Vector3(sx * 2.7, wingY - 0.05, -0.25);
      this.strut(a, b, 0.045, body);
    }
    this.wing({ root: [0.05, 0.3, 4.3], rootChord: 1.1, tipChord: 0.75, span: 1.75, sweep: 0.15, thickness: 0.1, kind: 'right' }, body, [
      { role: 'elevator', chord: 0.58, span: [0.05, 0.98], max: 25 },
    ]);
    this.wing({ root: [-0.05, 0.3, 4.3], rootChord: 1.1, tipChord: 0.75, span: 1.75, sweep: 0.15, thickness: 0.1, kind: 'left' }, body, [
      { role: 'elevator', chord: 0.58, span: [0.05, 0.98], max: 25 },
    ]);
    this.wing({ root: [0, 0.42, 3.75], rootChord: 1.55, tipChord: 0.8, span: 1.45, sweep: 0.85, thickness: 0.1, kind: 'vertical' }, stripe, [
      { role: 'rudder', chord: 0.62, span: [0.04, 0.97], max: 22 },
    ]);
    this.propeller([0, 0, -2.66], 0.95, 2, 0xd8352a);
    this.pilot([-0.3, 0.55, -0.45], 0x6b4f3a);
    this.dashboard([0, 0.5, -1.0], 1.1, 0.35);
    this.points.smoke.set(0, -0.3, 5.0);
    this.points.exhaust.push(new Vector3(0.3, -0.45, -1.9));
    this.points.wingTips[0].set(-5.5, wingY + 0.15, -0.1);
    this.points.wingTips[1].set(5.5, wingY + 0.15, -0.1);
  }

  private buildVortex(): void {
    const L = this.spec.livery;
    const body = this.mat(L.primary, { metal: 0.2, rough: 0.35 });
    const white = this.mat(L.secondary, { metal: 0.2, rough: 0.35 });
    const dark = this.mat(L.accent, { metal: 0.3, rough: 0.4 });
    const fus: Section[] = [
      { z: -2.42, w: 0.2, h: 0.2, y: 0.0 },
      { z: -2.3, w: 0.42, h: 0.42, y: 0.0 },
      { z: -1.6, w: 0.5, h: 0.5, y: 0.02 },
      { z: -0.6, w: 0.5, h: 0.52, y: 0.04, e: 2.3 },
      { z: 0.6, w: 0.46, h: 0.5, y: 0.06, e: 2.3 },
      { z: 2.0, w: 0.3, h: 0.36, y: 0.08 },
      { z: 3.6, w: 0.13, h: 0.2, y: 0.12 },
      { z: 4.4, w: 0.04, h: 0.08, y: 0.14 },
    ];
    this.add(loft(fus), body);
    // White sunburst stripes.
    this.add(
      loft([
        { z: -2.2, w: 0.425, h: 0.1, y: 0.25 },
        { z: -0.4, w: 0.505, h: 0.1, y: 0.4, e: 2.3 },
        { z: 2.0, w: 0.31, h: 0.08, y: 0.24 },
        { z: 4.2, w: 0.08, h: 0.04, y: 0.2 },
      ]),
      white,
    );
    // Bubble canopy.
    this.add(
      loft([
        { z: -0.75, w: 0.18, h: 0.08, y: 0.48 },
        { z: -0.3, w: 0.36, h: 0.3, y: 0.5 },
        { z: 0.7, w: 0.36, h: 0.3, y: 0.5 },
        { z: 1.3, w: 0.18, h: 0.12, y: 0.48 },
      ]),
      this.glass(),
    );
    const wingDef = (kind: 'right' | 'left'): SurfaceDef => ({
      root: [kind === 'right' ? 0.35 : -0.35, -0.32, -0.75],
      rootChord: 1.95,
      tipChord: 1.0,
      span: 3.35,
      sweep: 0.45,
      dihedral: 0,
      thickness: 0.15,
      kind,
    });
    for (const k of ['left', 'right'] as const) {
      this.wing(wingDef(k), body, [
        { role: 'flap', chord: 0.72, span: [0.05, 0.3], max: 20 },
        { role: k === 'left' ? 'aileronL' : 'aileronR', chord: 0.72, span: [0.32, 0.97], max: 25, mat: white },
      ]);
    }
    this.wing({ root: [0.05, 0.08, 3.45], rootChord: 1.05, tipChord: 0.62, span: 1.55, sweep: 0.2, thickness: 0.1, kind: 'right' }, body, [
      { role: 'elevator', chord: 0.5, span: [0.04, 0.98], max: 28, mat: white },
    ]);
    this.wing({ root: [-0.05, 0.08, 3.45], rootChord: 1.05, tipChord: 0.62, span: 1.55, sweep: 0.2, thickness: 0.1, kind: 'left' }, body, [
      { role: 'elevator', chord: 0.5, span: [0.04, 0.98], max: 28, mat: white },
    ]);
    this.wing({ root: [0, 0.2, 3.2], rootChord: 1.35, tipChord: 0.72, span: 1.2, sweep: 0.55, thickness: 0.1, kind: 'vertical' }, body, [
      { role: 'rudder', chord: 0.5, span: [0.03, 0.98], max: 28, mat: white },
    ]);
    this.propeller([0, 0, -2.46], 0.98, 3, 0xffffff);
    this.pilot([0, 0.55, 0.35], 0x2a2a2a);
    this.dashboard([0, 0.42, -0.2], 0.7, 0.25);
    void dark;
    this.points.smoke.set(0, -0.2, 4.2);
    this.points.exhaust.push(new Vector3(0.38, -0.3, -1.7), new Vector3(-0.38, -0.3, -1.7));
    this.points.wingTips[0].set(-3.7, -0.3, 0.35);
    this.points.wingTips[1].set(3.7, -0.3, 0.35);
  }

  private buildFalcon(): void {
    const L = this.spec.livery;
    const body = this.mat(L.primary, { metal: 0.45, rough: 0.5 });
    const dark = this.mat(L.secondary, { metal: 0.45, rough: 0.55 });
    const accent = this.mat(L.accent, { rough: 0.5 });
    const radome = this.mat(0x4e5660, { metal: 0.2, rough: 0.6 });
    // Radome.
    this.add(
      loft([
        { z: -7.65, w: 0.02, h: 0.02, y: 0.05 },
        { z: -7.0, w: 0.22, h: 0.22, y: 0.05 },
        { z: -6.4, w: 0.36, h: 0.36, y: 0.06 },
      ], 18, false, false),
      radome,
    );
    const fus: Section[] = [
      { z: -6.4, w: 0.36, h: 0.36, y: 0.06 },
      { z: -5.2, w: 0.52, h: 0.5, y: 0.08 },
      { z: -3.6, w: 0.62, h: 0.62, y: 0.1 },
      { z: -2.0, w: 0.95, h: 0.68, y: 0.05, e: 2.8 },
      { z: 0.0, w: 1.05, h: 0.72, y: 0.0, e: 3 },
      { z: 3.0, w: 0.85, h: 0.7, y: 0.02, e: 2.6 },
      { z: 5.5, w: 0.62, h: 0.62, y: 0.04 },
      { z: 6.6, w: 0.56, h: 0.56, y: 0.04 },
    ];
    this.add(loft(fus, 24, false, true), body);
    // Nozzle.
    const nozzleMat = this.mat(0x3a3a3c, { metal: 0.8, rough: 0.35, side: DoubleSide });
    this.add(
      loft([
        { z: 6.55, w: 0.56, h: 0.56, y: 0.04 },
        { z: 7.4, w: 0.5, h: 0.5, y: 0.04 },
      ], 20, false, false),
      nozzleMat,
    );
    this.nozzleGlow = new MeshBasicMaterial({ color: 0xff7a2a, transparent: true, opacity: 0.0 });
    this.materials.push(this.nozzleGlow);
    const glowDisc = new Mesh(new CylinderGeometry(0.46, 0.46, 0.02, 20).rotateX(Math.PI / 2), this.nozzleGlow);
    glowDisc.position.set(0, 0.04, 7.0);
    this.root.add(glowDisc);
    this.flameMat = new MeshBasicMaterial({ color: 0xffa64d, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false });
    this.materials.push(this.flameMat);
    this.flame = new Mesh(new ConeGeometry(0.42, 3.6, 18, 1, true).rotateX(Math.PI / 2).translate(0, 0, 1.8), this.flameMat);
    this.flame.position.set(0, 0.04, 7.35);
    this.flame.userData.noShadow = true;
    this.root.add(this.flame);
    // Intake under the forward fuselage.
    this.add(
      loft([
        { z: -3.4, w: 0.55, h: 0.36, y: -0.72, e: 3.2 },
        { z: -2.0, w: 0.6, h: 0.42, y: -0.7, e: 3.2 },
        { z: 1.0, w: 0.6, h: 0.42, y: -0.55, e: 3.2 },
        { z: 2.5, w: 0.4, h: 0.3, y: -0.4, e: 3 },
      ], 20, true, true),
      dark,
    );
    // Canopy.
    this.add(
      loft([
        { z: -5.4, w: 0.12, h: 0.08, y: 0.5 },
        { z: -4.6, w: 0.42, h: 0.38, y: 0.52 },
        { z: -3.0, w: 0.45, h: 0.42, y: 0.5 },
        { z: -1.6, w: 0.3, h: 0.28, y: 0.45 },
        { z: -0.6, w: 0.08, h: 0.05, y: 0.55 },
      ]),
      this.glass(),
    );
    // Wings with leading-edge strakes.
    for (const k of ['left', 'right'] as const) {
      const sx = k === 'right' ? 1 : -1;
      const def: SurfaceDef = { root: [sx * 0.8, -0.12, -0.9], rootChord: 4.4, tipChord: 1.05, span: 4.15, sweep: 3.35, thickness: 0.05, kind: k };
      this.wing(def, body, [
        { role: 'flap', chord: 0.74, span: [0.04, 0.45], max: 20 },
        { role: k === 'left' ? 'aileronL' : 'aileronR', chord: 0.74, span: [0.45, 0.82], max: 21 },
      ]);
      // Strake.
      this.add(surface({ root: [sx * 0.75, -0.08, -4.6], rootChord: 3.8, tipChord: 0.3, span: 0.35, sweep: 3.4, thickness: 0.05, kind: k }), body);
      // Tip rail + missile.
      const tip = new Mesh(new CylinderGeometry(0.07, 0.07, 3.0, 8).rotateX(Math.PI / 2), this.mat(0xe6e6e6, { metal: 0.3 }));
      tip.position.set(sx * 5.0, -0.12, 3.0);
      this.root.add(tip);
      const fins = new Mesh(new ConeGeometry(0.07, 0.4, 8).rotateX(-Math.PI / 2), accent);
      fins.position.set(sx * 5.0, -0.12, 1.3);
      this.root.add(fins);
    }
    // All-moving horizontal tail (stabilators).
    for (const k of ['left', 'right'] as const) {
      const sx = k === 'right' ? 1 : -1;
      const def: SurfaceDef = { root: [sx * 0.75, -0.02, 4.35], rootChord: 2.4, tipChord: 0.9, span: 2.45, sweep: 1.55, dihedral: -10, thickness: 0.05, kind: k };
      this.hinge(def, 0.0, [0, 1], 'stabilator', 22, body);
    }
    // Vertical fin.
    this.wing({ root: [0, 0.6, 3.15], rootChord: 3.3, tipChord: 1.25, span: 2.95, sweep: 2.3, thickness: 0.06, kind: 'vertical' }, body, [
      { role: 'rudder', chord: 0.72, span: [0.06, 0.9], max: 30, mat: dark },
    ]);
    this.pilot([0, 0.65, -3.75], 0xd8d8d0);
    this.dashboard([0, 0.55, -4.6], 0.8, 0.28);
    this.points.smoke.set(0, 0.04, 7.6);
    this.points.exhaust.push(new Vector3(0, 0.04, 7.6));
    this.points.wingTips[0].set(-5.0, -0.12, 2.0);
    this.points.wingTips[1].set(5.0, -0.12, 2.0);
  }

  private buildSkyliner(): void {
    const L = this.spec.livery;
    const tex = this.liveryTexture();
    const body = this.mat(0xffffff, { metal: 0.2, rough: 0.38, map: tex });
    const wingMat = this.mat(0xc9ced4, { metal: 0.45, rough: 0.4 });
    const tail = this.mat(L.secondary, { metal: 0.2, rough: 0.4 });
    const engineMat = this.mat(0xe8eaee, { metal: 0.35, rough: 0.35 });
    const dark = this.mat(0x2a2d33, { metal: 0.5, rough: 0.5 });
    const R = 2.0;
    const fus: Section[] = [
      { z: -19.2, w: 0.06, h: 0.06, y: -0.35 },
      { z: -18.7, w: 0.85, h: 0.8, y: -0.25 },
      { z: -17.6, w: 1.55, h: 1.5, y: -0.12 },
      { z: -16.0, w: 1.95, h: 1.92, y: -0.02 },
      { z: -14.0, w: R, h: R, y: 0 },
      { z: 9.0, w: R, h: R, y: 0 },
      { z: 12.0, w: 1.75, h: 1.6, y: 0.35 },
      { z: 15.0, w: 1.1, h: 0.95, y: 0.9 },
      { z: 17.6, w: 0.45, h: 0.45, y: 1.2 },
      { z: 18.6, w: 0.12, h: 0.18, y: 1.25 },
    ];
    this.add(loft(fus, 28), body);
    // Wings.
    for (const k of ['left', 'right'] as const) {
      const sx = k === 'right' ? 1 : -1;
      const def: SurfaceDef = { root: [sx * 1.6, -1.25, -4.2], rootChord: 6.8, tipChord: 1.55, span: 15.6, sweep: 7.4, dihedral: 5.5, thickness: 0.13, kind: k };
      this.wing(def, wingMat, [
        { role: 'flap', chord: 0.74, span: [0.04, 0.62], max: 40 },
        { role: k === 'left' ? 'aileronL' : 'aileronR', chord: 0.74, span: [0.65, 0.93], max: 20 },
      ]);
      // Spoiler panels on the upper surface.
      for (let s = 0; s < 3; s++) {
        const s0 = 0.22 + s * 0.12;
        this.spoiler(def, [s0, s0 + 0.11], wingMat);
      }
      // Winglet.
      const tipP = surfacePoint(def, 1, 0, 0);
      this.add(
        surface({ root: [tipP.x, tipP.y, tipP.z + 0.1], rootChord: 1.45, tipChord: 0.6, span: 2.0, sweep: 1.1, thickness: 0.08, kind: 'vertical' }),
        tail,
      );
      // Engine nacelle on a pylon.
      const ex = sx * 5.7;
      const nac = loft(
        [
          { z: -6.2, w: 0.95, h: 0.95, y: 0 },
          { z: -5.6, w: 1.08, h: 1.08, y: 0 },
          { z: -3.0, w: 1.05, h: 1.05, y: 0 },
          { z: -1.6, w: 0.75, h: 0.75, y: 0 },
          { z: -0.9, w: 0.4, h: 0.4, y: 0 },
        ],
        24,
        false,
        true,
      );
      const nm = this.add(nac, engineMat);
      nm.position.set(ex, -2.25, 0);
      const intake = new Mesh(new CylinderGeometry(0.9, 0.9, 0.3, 24).rotateX(Math.PI / 2), dark);
      intake.position.set(ex, -2.25, -5.95);
      this.root.add(intake);
      const lip = new Mesh(new TorusGeometry(0.98, 0.1, 8, 24), engineMat);
      lip.position.set(ex, -2.25, -6.2);
      this.root.add(lip);
      const pylon = surface({ root: [ex, -1.65, -4.4], rootChord: 4.0, tipChord: 3.2, span: 0.75, sweep: 0.9, thickness: 0.08, kind: 'vertical' });
      this.add(pylon, wingMat);
      this.points.exhaust.push(new Vector3(ex, -2.25, -0.7));
    }
    // Horizontal tail.
    for (const k of ['left', 'right'] as const) {
      const sx = k === 'right' ? 1 : -1;
      this.wing({ root: [sx * 0.4, 1.0, 14.0], rootChord: 3.7, tipChord: 1.4, span: 5.9, sweep: 3.6, dihedral: 6, thickness: 0.1, kind: k }, wingMat, [
        { role: 'elevator', chord: 0.7, span: [0.05, 0.95], max: 25 },
      ]);
    }
    this.wing({ root: [0, 1.6, 11.8], rootChord: 5.8, tipChord: 2.0, span: 6.4, sweep: 4.9, thickness: 0.1, kind: 'vertical' }, tail, [
      { role: 'rudder', chord: 0.68, span: [0.05, 0.95], max: 25 },
    ]);
    this.dashboard([0, 0.95, -16.3], 1.6, 0.4);
    this.points.smoke.set(0, 1.2, 18.6);
    this.points.wingTips[0].set(-17.2, 0.4, 5.6);
    this.points.wingTips[1].set(17.2, 0.4, 5.6);
  }

  private liveryTexture(): Texture {
    const L = this.spec.livery;
    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 256;
    const ctx = c.getContext('2d')!;
    const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
    // u (x axis of canvas) = around circumference (0 = right side middle, going up),
    // v (y axis, flipped) = along the body from nose (v=0) to tail (v=1).
    ctx.fillStyle = hex(L.primary);
    ctx.fillRect(0, 0, 1024, 256);
    const around = (a: number) => (a / (Math.PI * 2)) * 1024;
    // Belly (around 270°) in grey.
    ctx.fillStyle = '#c3c8cf';
    ctx.fillRect(around(Math.PI * 1.25), 0, around(Math.PI * 0.5), 256);
    // Cheat line under the windows on both sides.
    ctx.fillStyle = hex(L.accent);
    for (const a of [0, Math.PI]) {
      const x = around(a - 0.18 + (a === 0 ? 0 : 0.36));
      ctx.fillRect(Math.min(x, x) - 4, 0, 10, 256);
    }
    // Passenger windows: rows along v at around ±0.3 rad above the side.
    ctx.fillStyle = '#1f2a36';
    const zMin = -19.2;
    const zMax = 18.6;
    const vOf = (z: number) => 256 - ((z - zMin) / (zMax - zMin)) * 256;
    for (const a of [0.28, Math.PI - 0.28]) {
      const x = around(a);
      for (let z = -12; z < 9; z += 0.95) ctx.fillRect(x - 3, vOf(z) - 0.9, 6, 1.6);
    }
    // Cockpit windows.
    for (const a of [0.45, Math.PI - 0.45, 0.9, Math.PI - 0.9]) {
      ctx.fillRect(around(a) - 10, vOf(-17.4) - 3, 20, 4);
    }
    // Doors.
    ctx.strokeStyle = '#9aa3ad';
    ctx.lineWidth = 1;
    for (const z of [-15, 7.5]) for (const a of [0.15, Math.PI - 0.15]) ctx.strokeRect(around(a) - 8, vOf(z) - 3, 16, 5);
    const t = new CanvasTexture(c);
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = 4;
    this.textures.push(t);
    return t;
  }

  private spoiler(def: SurfaceDef, span: [number, number], mat: Material): void {
    // A thin plate hinged at 60% chord on the upper surface.
    const a = surfacePoint(def, span[0], 0.58, 0.055);
    const b = surfacePoint(def, span[1], 0.58, 0.055);
    let axis = b.clone().sub(a).normalize();
    if (axis.x < 0) axis = axis.negate();
    const origin = b.x < a.x ? b : a;
    const pivot = new Group();
    pivot.position.copy(origin);
    pivot.quaternion.setFromUnitVectors(new Vector3(1, 0, 0), axis);
    const inner = new Group();
    pivot.add(inner);
    const len = a.distanceTo(b);
    const chordLen = (def.rootChord + (def.tipChord - def.rootChord) * (span[0] + span[1]) * 0.5) * 0.14;
    const plate = new Mesh(new BoxGeometry(len, 0.04, chordLen), mat);
    plate.position.set(len / 2, 0, chordLen / 2);
    inner.add(plate);
    this.root.add(pivot);
    this.hinges.push({ pivot, inner, role: 'spoiler', max: 50 * DEG });
  }

  private strut(a: Vector3, b: Vector3, r: number, mat: Material): void {
    const len = a.distanceTo(b);
    const m = new Mesh(new CylinderGeometry(r, r, len, 6), mat);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), b.clone().sub(a).normalize());
    m.scale.set(1, 1, 0.45);
    this.root.add(m);
  }

  private pilot(pos: [number, number, number], helmet: number): void {
    const g = new Group();
    const head = new Mesh(new SphereGeometry(0.13, 12, 10), this.mat(0xe0b896, { rough: 0.7, metal: 0 }));
    const hel = new Mesh(new SphereGeometry(0.15, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), this.mat(helmet, { rough: 0.4 }));
    hel.position.y = 0.02;
    const torso = new Mesh(new CylinderGeometry(0.17, 0.2, 0.45, 10), this.mat(0x2c3e50, { rough: 0.8, metal: 0 }));
    torso.position.y = -0.33;
    g.add(head, hel, torso);
    g.position.set(...pos);
    this.root.add(g);
    this.exteriorOnly.push(g);
  }

  /**
   * Instrument panel / glare shield placed relative to the pilot's eye so it occupies the
   * lower part of the cockpit view on every aircraft.
   */
  private dashboard(_pos: [number, number, number], width: number, height: number): void {
    const eye = this.spec.camera.cockpit;
    const dist = 0.8;
    const top = eye[1] - Math.tan(25 * DEG) * dist;
    const g = new Group();
    const panelMat = this.mat(0x2b3036, { rough: 0.85, metal: 0.1 });
    const panel = new Mesh(new BoxGeometry(width * 1.3, height * 1.6, 0.06), panelMat);
    panel.position.set(0, -height * 0.8, 0);
    const shroud = new Mesh(new BoxGeometry(width * 1.35, 0.04, 0.16), this.mat(0x16181b, { rough: 0.95, metal: 0 }));
    shroud.position.set(0, 0.0, 0.05);
    // A few instrument bezels for depth.
    const bezelMat = this.mat(0x0b0c0e, { rough: 0.6, metal: 0.3 });
    for (let i = 0; i < 6; i++) {
      const b = new Mesh(new CylinderGeometry(height * 0.2, height * 0.2, 0.03, 18).rotateX(Math.PI / 2), bezelMat);
      b.position.set((i % 3 - 1) * height * 0.48 + eye[0] * 0.8, -height * 0.32 - Math.floor(i / 3) * height * 0.46, 0.04);
      g.add(b);
    }
    g.add(panel, shroud);
    g.position.set(0, top, eye[2] - dist);
    g.visible = false;
    this.root.add(g);
    this.cockpitOnly.push(g);
  }

  // ------------------------------------------------------------- gear & lights

  private buildGear(): void {
    const spec = this.spec;
    const tireMat = this.mat(0x1b1b1b, { rough: 0.9, metal: 0 });
    const hubMat = this.mat(0xb8bcc2, { metal: 0.6, rough: 0.35 });
    const strutMat = this.mat(0x9da3aa, { metal: 0.7, rough: 0.3 });
    const r = spec.gear.wheelRadius;
    const retract = spec.gear.retractable;
    const fairing = spec.id === 'vortex' || spec.id === 'kestrel';
    spec.gear.points.forEach((gp, index) => {
      const isNose = !!gp.steer;
      const wheelY = gp.y + r;
      // Attach point on the airframe.
      const topY = spec.id === 'skyliner' ? (isNose ? -1.7 : -1.4) : spec.id === 'falcon' ? -0.75 : isNose ? -0.35 : -0.55;
      const topX = spec.id === 'kestrel' && !isNose ? Math.sign(gp.x) * 0.45 : spec.id === 'vortex' && !isNose ? Math.sign(gp.x) * 0.5 : gp.x;
      const pivot = new Group();
      pivot.position.set(topX, topY, gp.z);
      const slider = new Group();
      pivot.add(slider);
      const steer = isNose ? new Group() : null;
      // Leg from pivot to wheel centre (in pivot coordinates).
      const end = new Vector3(gp.x - topX, wheelY - topY, 0);
      const legLen = end.length();
      const leg = new Mesh(new CylinderGeometry(r * 0.18, r * 0.22, legLen, 8), strutMat);
      leg.position.copy(end).multiplyScalar(0.5);
      leg.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), end.clone().normalize());
      slider.add(leg);
      const wheels = new Group();
      wheels.position.copy(end);
      const twin = spec.id === 'skyliner';
      const offsets = twin ? [-0.42, 0.42] : [0];
      for (const ox of offsets) {
        const tire = new Mesh(new CylinderGeometry(r, r, r * 0.7, 16).rotateZ(Math.PI / 2), tireMat);
        tire.position.x = ox;
        const hub = new Mesh(new CylinderGeometry(r * 0.55, r * 0.55, r * 0.74, 12).rotateZ(Math.PI / 2), hubMat);
        hub.position.x = ox;
        wheels.add(tire, hub);
      }
      if (fairing) {
        const spat = new Mesh(new SphereGeometry(r * 1.25, 12, 10), this.mat(spec.livery.primary, { rough: 0.4 }));
        spat.scale.set(0.55, 0.85, 1.9);
        spat.position.y = r * 0.15;
        wheels.add(spat);
      }
      if (steer) {
        steer.position.copy(end);
        wheels.position.set(0, 0, 0);
        steer.add(wheels);
        slider.add(steer);
      } else slider.add(wheels);
      this.root.add(pivot);
      // Retraction: nose gear folds forward, mains fold inward (toward centreline).
      let retractAxis: Axis = 'x';
      let retractAngle = 0;
      if (retract) {
        if (isNose) {
          retractAxis = 'x';
          retractAngle = 100 * DEG;
        } else {
          retractAxis = spec.id === 'skyliner' ? 'y' : 'y';
          retractAngle = 0;
        }
      }
      this.gear.push({ pivot, slider, steer, index, retractAxis, retractAngle });
      if (retract && !isNose) {
        // Mains rotate about the fore-aft axis to fold inward.
        (pivot.userData as { foldZ: number }).foldZ = -Math.sign(gp.x || 1) * 92 * DEG;
      }
    });
  }

  private buildLights(): void {
    const spec = this.spec;
    const [lt, rt] = this.points.wingTips;
    const lamp = (pos: Vector3, color: number, kind: Lamp['kind'], size: number, phase = 0) => {
      const m = new SpriteMaterial({ map: glow(), color, blending: AdditiveBlending, depthWrite: false, transparent: true });
      this.materials.push(m);
      const s = new Sprite(m);
      s.position.copy(pos);
      s.scale.setScalar(size);
      s.userData.noShadow = true;
      this.root.add(s);
      this.lamps.push({ sprite: s, kind, phase });
    };
    const big = spec.id === 'skyliner' ? 2.2 : 1;
    lamp(lt.clone().add(new Vector3(-0.05, 0, 0)), 0xff2a2a, 'nav', 0.9 * big);
    lamp(rt.clone().add(new Vector3(0.05, 0, 0)), 0x2aff5a, 'nav', 0.9 * big);
    const tail = spec.collision.find((c) => c.kind === 'tail')!;
    lamp(new Vector3(0, tail.y + 0.3, tail.z + 0.3), 0xffffff, 'nav', 0.7 * big);
    lamp(lt.clone().add(new Vector3(0, 0, 0.25)), 0xffffff, 'strobe', 2.2 * big, 0);
    lamp(rt.clone().add(new Vector3(0, 0, 0.25)), 0xffffff, 'strobe', 2.2 * big, 0.08);
    const fin = spec.collision.find((c) => c.kind === 'fin')!;
    lamp(new Vector3(0, fin.y + 0.1, fin.z - 0.2), 0xff3020, 'beacon', 1.3 * big, 0.5);
  }

  // ------------------------------------------------------------- per-frame

  /**
   * Animate from the flight model.
   * @param lightsOn nav/strobe/landing lights switch
   * @param night 0..1 for landing-light intensity
   */
  update(m: FlightModel, dt: number, lightsOn: boolean, night: number): void {
    this.time += dt;
    const s = m.surfaces;
    const flap = m.flapsPos;
    for (const h of this.hinges) {
      let a = 0;
      switch (h.role) {
        case 'elevator':
        case 'stabilator':
          a = -s.elevator * h.max;
          break;
        case 'aileronR':
          a = -s.aileron * h.max;
          break;
        case 'aileronL':
          a = s.aileron * h.max;
          break;
        case 'rudder':
          a = s.rudder * h.max;
          break;
        case 'flap':
          a = flap * h.max;
          break;
        case 'spoiler':
          a = -m.spoilerPos * h.max;
          break;
      }
      if (h.role === 'stabilator') {
        // Differential tail adds roll authority.
        const right = h.pivot.position.x > 0;
        a += (right ? -1 : 1) * s.aileron * 6 * DEG;
      }
      h.inner.rotation.set(h.role === 'rudder' ? 0 : a, h.role === 'rudder' ? a : 0, 0);
    }
    // Propellers.
    const rpm = m.rpm;
    for (const p of this.props) {
      p.blades.rotation.z += p.dir * (rpm / 60) * Math.PI * 2 * dt;
      const blur = Math.min(1, Math.max(0, (rpm - 400) / 1400));
      (p.disc.material as MeshBasicMaterial).opacity = blur * (this.cockpitView ? 0.07 : 0.22);
      p.blades.visible = blur < 0.97 || Math.floor(this.time * 30) % 3 === 0;
    }
    // Gear: retraction + strut compression + nose steering.
    const gp = m.gearPos;
    for (const g of this.gear) {
      const foldZ = (g.pivot.userData as { foldZ?: number }).foldZ;
      if (foldZ !== undefined) g.pivot.rotation.z = (1 - gp) * foldZ;
      else if (g.retractAngle) g.pivot.rotation.x = (1 - gp) * g.retractAngle;
      g.slider.position.y = m.wheelCompression[g.index] ?? 0;
      if (g.steer) g.steer.rotation.y = -m.steerAngle;
      g.pivot.visible = gp > 0.02;
    }
    // Afterburner / nozzle glow.
    if (this.flame && this.flameMat) {
      const ab = m.afterburner ? 1 : 0;
      const flick = 0.85 + Math.sin(this.time * 60) * 0.08 + Math.sin(this.time * 37) * 0.07;
      this.flameMat.opacity = ab * 0.8 * flick;
      this.flame.scale.set(1, 1, (0.6 + ab * 0.6) * flick);
      this.flame.visible = ab > 0;
    }
    if (this.nozzleGlow) this.nozzleGlow.opacity = Math.min(1, Math.max(0, (m.engineSpool - 0.55) * 2)) * 0.9;
    // Lights.
    for (const l of this.lamps) {
      let on = lightsOn;
      let k = 1;
      if (l.kind === 'strobe') {
        const t = (this.time + l.phase) % 1.2;
        on = lightsOn && (t < 0.05 || (t > 0.16 && t < 0.2));
        k = 1.4;
      } else if (l.kind === 'beacon') {
        const t = (this.time + l.phase) % 1.0;
        k = Math.max(0, Math.sin(t * Math.PI * 2)) * 1.2;
        on = lightsOn && k > 0.05;
      }
      l.sprite.visible = on;
      (l.sprite.material as SpriteMaterial).opacity = Math.min(1, k * (0.55 + night * 0.45));
    }
    this.landingLight.intensity = lightsOn && m.gearDown ? 600 * Math.max(night, 0.0) : 0;
    this.landingLight.visible = this.landingLight.intensity > 0;
  }

  private cockpitView = false;

  setCockpitView(on: boolean): void {
    this.cockpitView = on;
    for (const o of this.exteriorOnly) o.visible = !on;
    for (const o of this.cockpitOnly) o.visible = on;
  }

  /** Clone visible meshes as world-space debris pieces (for crash break-up). */
  debrisPieces(): Mesh[] {
    const out: Mesh[] = [];
    this.root.updateMatrixWorld(true);
    this.root.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh || !mesh.visible || mesh.userData.noShadow) return;
      if ((mesh.material as MeshBasicMaterial).isMeshBasicMaterial) return;
      const c = new Mesh(mesh.geometry, mesh.material);
      mesh.matrixWorld.decompose(c.position, c.quaternion, c.scale);
      out.push(c);
    });
    return out;
  }

  /** World-space position of a model-local point. */
  worldPoint(local: Vector3, out = new Vector3()): Vector3 {
    return out.copy(local).applyMatrix4(this.root.matrixWorld);
  }

  dispose(): void {
    this.root.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
    this.materials.forEach((m) => m.dispose());
    this.textures.forEach((t) => t.dispose());
  }
}
