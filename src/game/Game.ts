/**
 * Game orchestrator: state machine, main loop, flight sessions, missions, FX, audio and UI.
 */
import {
  ACESFilmicToneMapping,
  Group,
  Mesh,
  MeshBasicMaterial,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  TorusGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';
import { World, QUALITY, HEIGHTMAP_SIZE } from '../world/World';
import type { EnvOptions } from '../world/Environment';
import { FlightModel, type FlightEvent } from '../physics/FlightModel';
import { FlightControlSystem } from '../physics/FlightControls';
import { getAircraft, type AircraftSpec } from '../aircraft/specs';
import { AircraftModel } from '../aircraft/AircraftModel';
import { CameraController, CAMERA_LABELS } from './CameraController';
import { Input, type Action } from '../input/Input';
import { TouchControls } from '../input/TouchControls';
import { AudioEngine } from '../audio/AudioEngine';
import { ParticleSystem, AdditiveBlending, NormalBlending } from '../fx/Particles';
import { Debris } from '../fx/Debris';
import { Rain } from '../fx/Rain';
import { HUD, type IlsInfo, type Warning, type MissionHud } from '../ui/HUD';
import { Minimap } from '../ui/Minimap';
import { Menus, type FreeFlightConfig } from '../ui/Menus';
import { Store, type Settings } from './Settings';
import { buildMissions, MissionRuntime, type MissionDef, type SpawnDef } from './Missions';
import { Traffic } from './Traffic';
import { makeSmokeTexture } from '../world/textures';
import { DEG, FPM_PER_MS, FT_PER_M, KTS_PER_MS, angleDiffDeg, clamp } from '../core/math';

type State = 'loading' | 'menu' | 'preparing' | 'flying' | 'paused' | 'crashed' | 'result';

interface Session {
  aircraft: string;
  env: EnvOptions;
  spawn: SpawnDef;
  mission: MissionDef | null;
  label: string;
}

interface FlightStats {
  time: number;
  distance: number;
  maxAlt: number;
  maxSpeed: number;
  landings: number;
  bestLanding: number | null;
}

const PHYS_DT = 1 / 240;
const _v = new Vector3();
const _v2 = new Vector3();
const _wind = new Vector3();
const _air = new Vector3();

export class Game {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(60, 1, 0.5, 90000);
  readonly world: World;
  readonly store = new Store();
  readonly input = new Input();
  readonly audio = new AudioEngine();
  readonly hud: HUD;
  readonly menus: Menus;
  readonly touch: TouchControls;
  readonly camCtl: CameraController;
  readonly missions: MissionDef[];
  minimap: Minimap | null = null;
  state: State = 'loading';

  // Flight session.
  session: Session | null = null;
  model: FlightModel | null = null;
  fcs = new FlightControlSystem();
  aircraft: AircraftModel | null = null;
  mission: MissionRuntime | null = null;
  private stats: FlightStats = { time: 0, distance: 0, maxAlt: 0, maxSpeed: 0, landings: 0, bestLanding: null };
  private accumulator = 0;
  private prevPos = new Vector3();
  private lightsOn = false;
  private bigMap = false;
  private crashTimer = 0;
  private crashPos = new Vector3();
  private resultTimer = -1;
  private ringGroup = new Group();
  private ringMeshes: { mesh: Mesh; idx: number }[] = [];
  private ringMat = { next: new MeshBasicMaterial({ color: 0xffc233, transparent: true, opacity: 0.95, fog: false }), future: new MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.45, fog: true }) };
  private landingCheck: { sink: number; airport: string | null; time: number } | null = null;
  private lastTouchdown = 0;

  // FX.
  private smoke: ParticleSystem;
  private fire: ParticleSystem;
  private debris = new Debris();
  private rain = new Rain();
  private lightning = 0;
  private nextLightning = 8;

  readonly traffic: Traffic;
  private trafficSmoke: Vector3[] = [];

  // Menu preview.
  private preview: { model: AircraftModel; fm: FlightModel } | null = null;
  private previewYaw = 0.6;

  // Misc.
  private last = performance.now();
  private fps = 60;
  private whiteout: HTMLDivElement;
  private hint: HTMLDivElement;
  private dragging = false;
  private lastPointer = { x: 0, y: 0 };
  private time = 0;
  private settingsApplied: Settings;

  constructor(private canvas: HTMLCanvasElement, hudCanvas: HTMLCanvasElement, private uiRoot: HTMLElement) {
    const s = this.store.settings;
    this.settingsApplied = { ...s };
    const q = QUALITY[s.quality];
    this.renderer = new WebGLRenderer({ canvas, antialias: q.antialias, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
    this.world = new World(this.scene, q, { time: 'dawn', weather: 'clear' });
    this.world.buildEnvMap(this.renderer);
    this.scene.add(this.ringGroup, this.debris.group, this.rain.lines);
    this.camCtl = new CameraController(this.camera);
    this.hud = new HUD(hudCanvas);
    this.missions = buildMissions(this.world.map);
    const smokeTex = makeSmokeTexture();
    this.smoke = new ParticleSystem(5000, smokeTex, NormalBlending);
    this.fire = new ParticleSystem(1200, smokeTex, AdditiveBlending);
    this.scene.add(this.smoke.points, this.fire.points);
    this.traffic = new Traffic(this.world.map);
    this.scene.add(this.traffic.group);

    this.whiteout = document.createElement('div');
    this.whiteout.className = 'whiteout';
    this.uiRoot.appendChild(this.whiteout);
    this.hint = document.createElement('div');
    this.hint.className = 'hint hidden';
    this.uiRoot.appendChild(this.hint);
    this.touch = new TouchControls(this.uiRoot, this.input);
    this.menus = new Menus(this.uiRoot, this.store, this.missions, {
      startFreeFlight: (cfg) => this.startFreeFlight(cfg),
      startMission: (id, ac) => this.startMission(id, ac),
      resume: () => this.resume(),
      restart: () => this.restart(),
      exitToMenu: () => this.exitToMenu(),
      applySettings: (st) => this.applySettings(st),
      previewAircraft: (id) => this.setPreview(id),
      resetProgress: () => this.store.reset(),
      click: () => {
        this.audio.init();
        this.audio.play('click');
      },
      nextMission: (id) => {
        const i = this.missions.findIndex((m) => m.id === id);
        const next = this.missions[(i + 1) % this.missions.length];
        this.menus.showBriefing(next.id);
        this.state = 'menu';
        this.endSession();
        this.enterMenuScene();
      },
    });
    this.applySettings(s);
    this.bindPointer();
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.fcs.onAutopilotChange = (on, reason) => {
      this.audio.play(on ? 'apOn' : 'apOff');
      this.hud.toast(on ? 'AUTOPILOT ENGAGED' : 'AUTOPILOT DISCONNECTED', { sub: reason, color: '#ff7cf2' });
    };
  }

  // ------------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    this.menus.showLoading(0, 'Starting engines');
    this.loop();
    await this.world.init((p, label) => this.menus.showLoading(p, label));
    if (this.world.heightmap) this.minimap = new Minimap(this.world.map, this.world.heightmap, HEIGHTMAP_SIZE);
    this.menus.showLoading(1, 'Ready');
    this.state = 'menu';
    this.enterMenuScene();
    this.menus.showMain();
  }

  private resize(): void {
    const box = this.canvas.parentElement;
    const w = box?.clientWidth || window.innerWidth;
    const h = box?.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.hud.resize();
  }

  private bindPointer(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' && this.touch.visible) return;
      this.dragging = true;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      this.camCtl.beginDrag();
      this.audio.init();
    });
    window.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastPointer.x;
      const dy = e.clientY - this.lastPointer.y;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      if (this.state === 'menu') this.previewYaw -= dx * 0.005;
      else this.camCtl.drag(dx, dy, this.store.settings.sensitivity);
    });
    window.addEventListener('pointerup', () => {
      if (!this.dragging) return;
      this.dragging = false;
      this.camCtl.endDrag();
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.camCtl.wheel(e.deltaY);
    }, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  applySettings(s: Settings): void {
    const prev = this.settingsApplied;
    this.settingsApplied = { ...s };
    this.audio.setVolume(s.volume);
    this.audio.setMuted(s.muted);
    this.input.invertPitch = s.invertPitch;
    this.input.sensitivity = s.sensitivity;
    this.fcs.assist = s.assist;
    this.traffic?.setEnabled(s.traffic);
    if (prev.quality !== s.quality) {
      const q = QUALITY[s.quality];
      this.world.setQuality(q);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
      this.resize();
    }
    this.updateTouchVisibility();
  }

  private updateTouchVisibility(): void {
    const mode = this.store.settings.touchControls;
    const want = mode === 'on' || (mode === 'auto' && TouchControls.isTouchDevice());
    this.touch.show(want && (this.state === 'flying' || this.state === 'preparing'));
  }

  // ------------------------------------------------------------------ menu scene

  private enterMenuScene(): void {
    this.world.setEnvironment({ time: 'dawn', weather: 'clear', windSpeed: 3, windFrom: 90 });
    this.world.buildEnvMap(this.renderer);
    this.rain.intensity = 0;
    this.setPreview(this.store.data.lastAircraft);
    this.hint.classList.add('hidden');
    this.whiteout.style.opacity = '0';
    this.updateTouchVisibility();
  }

  private setPreview(id: string): void {
    if (this.preview?.model.spec.id === id) return;
    this.clearPreview();
    const spec = getAircraft(id);
    const ap = this.world.map.getAirport('HBR');
    const rw = ap.runway;
    const fm = new FlightModel(spec);
    // Park on the apron facing the runway.
    const v = ap.apronSide * (rw.width / 2 + 75 + 60);
    const u = -rw.length * 0.12 + 40;
    const x = rw.x + rw.ux * u - rw.uz * v;
    const z = rw.z + rw.uz * u + rw.ux * v;
    fm.placeOnGround(this.world, x, z, (rw.heading + (ap.apronSide > 0 ? 180 : 0) + 30) % 360);
    const model = new AircraftModel(spec);
    model.root.position.copy(fm.position);
    model.root.quaternion.copy(fm.quaternion);
    this.scene.add(model.root);
    this.preview = { model, fm };
  }

  private clearPreview(): void {
    if (!this.preview) return;
    this.scene.remove(this.preview.model.root);
    this.preview.model.dispose();
    this.preview = null;
  }

  // ------------------------------------------------------------------ sessions

  startFreeFlight(cfg: FreeFlightConfig): void {
    let spawn: SpawnDef;
    const rwy = (code: string, end: 0 | 1): SpawnDef => ({ kind: 'runway', airport: code, end });
    switch (cfg.location) {
      case 'HBR-27':
        spawn = rwy('HBR', 1);
        break;
      case 'NFD-36':
        spawn = rwy('NFD', 0);
        break;
      case 'EGL-05':
        spawn = rwy('EGL', 0);
        break;
      case 'GUL-14':
        spawn = rwy('GUL', 0);
        break;
      case 'AIR-ISLAND':
        spawn = { kind: 'air', x: -7000, z: 5000, agl: 1500, heading: 60, speed: 1 };
        break;
      case 'AIR-CITY':
        spawn = { kind: 'air', x: -1500, z: 11500, agl: 600, heading: 70, speed: 1 };
        break;
      case 'AIR-FINAL':
        spawn = { kind: 'approach', airport: 'HBR', end: 1, distance: 6000 };
        break;
      default:
        spawn = rwy('HBR', 0);
    }
    this.beginSession({
      aircraft: cfg.aircraft,
      env: { time: cfg.time, weather: cfg.weather, windSpeed: cfg.windSpeed, windFrom: cfg.windFrom },
      spawn,
      mission: null,
      label: 'Free flight',
    });
  }

  startMission(id: string, aircraft: string): void {
    const def = this.missions.find((m) => m.id === id);
    if (!def) return;
    this.store.data.lastAircraft = aircraft;
    this.store.save();
    this.beginSession({
      aircraft,
      env: { time: def.time, weather: def.weather, windSpeed: def.wind?.speed, windFrom: def.wind?.from },
      spawn: def.spawn,
      mission: def,
      label: def.title,
    });
  }

  private beginSession(s: Session): void {
    this.audio.init();
    this.endSession();
    this.clearPreview();
    this.session = s;
    this.hud.clearToasts();
    this.menus.hide();
    this.state = 'preparing';
    this.world.setEnvironment(s.env);
    this.world.buildEnvMap(this.renderer);
    this.rain.intensity = this.world.env.rain;
    const spec = getAircraft(s.aircraft);
    this.model = new FlightModel(spec);
    this.model.onEvent = (e) => this.onFlightEvent(e);
    this.aircraft = new AircraftModel(spec);
    this.scene.add(this.aircraft.root);
    this.audio.setEngine(spec.engine.type, spec.engine.count);
    this.spawn(s.spawn);
    this.lightsOn = this.world.env.night > 0.5 || s.env.weather === 'storm' || s.env.time !== 'day';
    this.camCtl.setMode('chase');
    this.camCtl.zoom = 1;
    this.stats = { time: 0, distance: 0, maxAlt: 0, maxSpeed: 0, landings: 0, bestLanding: null };
    this.mission = s.mission ? new MissionRuntime(s.mission, this.world.map) : null;
    if (this.mission) {
      this.mission.onEvent = (kind, msg) => this.onMissionEvent(kind, msg);
      this.buildRings();
    }
    this.prevPos.copy(this.model.position);
    this.crashTimer = 0;
    this.resultTimer = -1;
    this.bigMap = false;
    this.landingCheck = null;
    this.prepareTimer = 0;
    // Pre-position the camera so terrain streams in around the spawn point.
    this.camCtl.update(0.016, this.model, this.world);
    this.menus.showLoading(0.5, 'Preparing your aircraft');
  }

  private prepareTimer = 0;

  private spawn(sp: SpawnDef): void {
    const m = this.model!;
    const spec = m.spec;
    const map = this.world.map;
    let airborne = false;
    if (sp.kind === 'runway') {
      const ap = map.getAirport(sp.airport);
      const e = ap.runway.ends[sp.end];
      const x = e.x + e.dx * 40;
      const z = e.z + e.dz * 40;
      m.placeOnGround(this.world, x, z, e.heading);
      m.setFlaps(spec.flaps.detents.length > 2 ? 1 : 0);
      m.flapsPos = m.flapsRatio;
      m.throttle = 0;
    } else if (sp.kind === 'approach') {
      const ap = map.getAirport(sp.airport);
      const e = ap.runway.ends[sp.end];
      const d = sp.distance;
      const alt = ap.elevation + Math.tan(3 * DEG) * (d + 300);
      m.gearDown = true;
      m.gearPos = 1;
      m.setFlaps(spec.flaps.detents.length - 1);
      m.flapsPos = 1;
      const V = spec.speeds.approach * 1.05;
      m.placeInAir(e.x - e.dx * d, alt, e.z - e.dz * d, e.heading, V, -3);
      m.throttle = spec.engine.type === 'jet' ? 0.5 : 0.42;
      m.engineSpool = 0.75;
      airborne = true;
    } else {
      const g = Math.max(map.groundHeight(sp.x, sp.z), 0);
      m.gearDown = !spec.gear.retractable;
      m.gearPos = m.gearDown ? 1 : 0;
      m.setFlaps(0);
      m.flapsPos = 0;
      const V = spec.speeds.cruise * (sp.speed ?? 1);
      m.placeInAir(sp.x, g + sp.agl, sp.z, sp.heading, V, 0);
      m.throttle = spec.engine.type === 'jet' ? (spec.engine.afterburnerThrust ? 0.75 : 0.6) : 0.7;
      m.engineSpool = 0.85;
      airborne = true;
    }
    this.fcs.reset(airborne, airborne ? m.computeTrimElevator(m.telemetry.airspeed, m.position.y) : 0);
    this.fcs.assist = this.store.settings.assist;
    this.accumulator = 0;
  }

  private endSession(): void {
    if (this.aircraft) {
      this.scene.remove(this.aircraft.root);
      this.debris.clear();
      this.aircraft.dispose();
      this.aircraft = null;
    }
    this.debris.clear();
    this.model = null;
    this.mission = null;
    this.ringGroup.clear();
    this.ringMeshes = [];
    this.smoke.clear();
    this.fire.clear();
    this.fcs.disengageAutopilot();
    this.input.enabled = true;
    this.touch.show(false);
  }

  private buildRings(): void {
    this.ringGroup.clear();
    this.ringMeshes = [];
    if (!this.mission) return;
    this.mission.ringStates().forEach((rs, idx) => {
      const r = rs.ring;
      const geo = new TorusGeometry(r.radius, Math.max(1.6, r.radius * 0.1), 10, 48);
      const mesh = new Mesh(geo, this.ringMat.future);
      mesh.position.set(r.x, r.y, r.z);
      mesh.rotation.y = -r.heading * DEG;
      this.ringGroup.add(mesh);
      this.ringMeshes.push({ mesh, idx });
    });
  }

  restart(): void {
    if (!this.session) return;
    const s = this.session;
    this.beginSession(s);
  }

  exitToMenu(): void {
    this.commitCareer();
    this.endSession();
    this.session = null;
    this.state = 'menu';
    this.enterMenuScene();
    this.menus.showMain();
  }

  private pause(): void {
    if (this.state !== 'flying') return;
    this.state = 'paused';
    this.menus.showPause(!!this.mission, this.session?.label ?? '');
    this.touch.show(false);
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.menus.hide();
    this.state = 'flying';
    this.last = performance.now();
    this.updateTouchVisibility();
  }

  private commitCareer(): void {
    const c = this.store.data.career;
    c.flightTime += this.stats.time;
    c.distance += this.stats.distance;
    c.landings += this.stats.landings;
    c.maxAltitude = Math.max(c.maxAltitude, this.stats.maxAlt);
    c.maxSpeed = Math.max(c.maxSpeed, this.stats.maxSpeed);
    this.stats.time = 0;
    this.stats.distance = 0;
    this.stats.landings = 0;
    this.store.save();
  }

  // ------------------------------------------------------------------ events

  private onFlightEvent(e: FlightEvent): void {
    const m = this.model!;
    this.mission?.onFlightEvent(e, m);
    switch (e.type) {
      case 'touchdown': {
        const sinkFpm = e.sinkRate * FPM_PER_MS;
        if (e.sinkRate > 0.4) this.audio.play('touchdown');
        this.camCtl.shake(clamp(e.sinkRate / 3, 0.2, 2));
        // Tyre smoke at the main wheels.
        if (e.groundSpeed > 15 && this.aircraft) {
          for (const gp of m.spec.gear.points) {
            if (gp.steer) continue;
            _v.set(gp.x, gp.y, gp.z).applyQuaternion(m.quaternion).add(m.position);
            for (let k = 0; k < 14; k++) {
              _v2.set((Math.random() - 0.5) * 3, Math.random() * 2, (Math.random() - 0.5) * 3).addScaledVector(m.velocity, 0.3);
              this.smoke.emit(_v, _v2, { life: 2.2, size0: 1.2, size1: 5, alpha: 0.45, color: 0xd8d8d8, drag: 1.5 });
            }
          }
        }
        if (!this.mission && (e.surface === 'runway' || e.surface === 'paved')) {
          this.landingCheck = { sink: e.sinkRate, airport: this.world.map.runwayAt(e.x, e.z)?.code ?? null, time: 0 };
        }
        if (performance.now() - this.lastTouchdown > 3000 && e.sinkRate > 0.3) {
          const label = e.sinkRate < 1 ? 'Butter!' : e.sinkRate < 2 ? 'Smooth landing' : e.sinkRate < 3 ? 'Firm landing' : 'Hard landing!';
          this.hud.toast(label, { sub: `${Math.round(sinkFpm)} ft/min`, color: e.sinkRate < 2 ? '#4ade80' : '#fbbf24' });
        }
        this.lastTouchdown = performance.now();
        break;
      }
      case 'liftoff':
        this.hud.toast('Airborne', { duration: 1.5, color: '#93c5fd' });
        break;
      case 'tailstrike':
        this.hud.toast('TAIL STRIKE', { color: '#fbbf24' });
        this.camCtl.shake(1);
        break;
      case 'hardlanding':
        this.camCtl.shake(2);
        break;
      case 'gear':
        this.audio.play('gear');
        this.hud.toast(e.down ? 'Gear DOWN' : 'Gear UP', { duration: 1.6 });
        break;
      case 'flaps':
        this.audio.play('flaps');
        this.hud.toast(`Flaps ${m.spec.flaps.detents[e.detent] === 0 ? 'UP' : m.spec.flaps.detents[e.detent] + '°'}`, { duration: 1.4 });
        break;
      case 'crash':
        this.onCrash(e.reason);
        break;
    }
  }

  private onCrash(reason: string): void {
    const m = this.model!;
    this.state = 'crashed';
    this.crashTimer = 0;
    this.crashPos.copy(m.position);
    this.fcs.disengageAutopilot();
    const water = this.world.isWater(m.position.x, m.position.z) && m.position.y < 8;
    this.audio.play(water ? 'splash' : 'crash');
    this.camCtl.shake(4);
    this.store.data.career.crashes++;
    if (this.aircraft) {
      const pieces = this.aircraft.debrisPieces();
      this.aircraft.root.visible = false;
      this.debris.spawn(pieces, m.velocity, 14 + m.velocity.length() * 0.15);
    }
    const p = m.position;
    if (water) {
      for (let k = 0; k < 120; k++) {
        _v2.set((Math.random() - 0.5) * 14, Math.random() * 22, (Math.random() - 0.5) * 14);
        this.smoke.emit(_v.set(p.x, 0.5, p.z), _v2, { life: 2.5, size0: 2, size1: 9, alpha: 0.7, color: 0xf2f6ff, rise: -6, drag: 0.6 });
      }
    } else {
      for (let k = 0; k < 140; k++) {
        _v2.set((Math.random() - 0.5) * 30, Math.random() * 25, (Math.random() - 0.5) * 30).addScaledVector(m.velocity, 0.15);
        this.fire.emit(p, _v2, { life: 0.8 + Math.random() * 1.4, size0: 4, size1: 18, alpha: 0.9, color: k % 3 ? 0xff8a2a : 0xffd27a, drag: 2.5, rise: 4 });
      }
      for (let k = 0; k < 90; k++) {
        _v2.set((Math.random() - 0.5) * 10, 4 + Math.random() * 10, (Math.random() - 0.5) * 10);
        this.smoke.emit(p, _v2, { life: 6 + Math.random() * 6, size0: 6, size1: 40, alpha: 0.55, color: 0x2a2a2a, rise: 2, drag: 0.8, fadeIn: 0.1 });
      }
    }
    this.hud.toast('CRASHED', { sub: reason, color: '#f87171', big: true, duration: 3.5 });
    if (this.mission) this.mission.fail(reason);
  }

  private onMissionEvent(kind: 'ring' | 'stage' | 'success' | 'fail' | 'engine', msg: string): void {
    switch (kind) {
      case 'ring':
        this.audio.play('chime');
        this.hud.toast(`Ring ${msg}`, { duration: 1.2, color: '#fde047' });
        break;
      case 'stage':
        this.audio.play('toggle');
        this.hud.toast('Objective updated', { sub: msg, duration: 3.5, color: '#93c5fd' });
        break;
      case 'engine':
        this.hud.toast('ENGINE FAILURE', { sub: 'Glide to the runway!', color: '#f87171', big: true, duration: 4 });
        this.audio.play('fail');
        break;
      case 'success':
        this.audio.play('success');
        this.hud.toast('MISSION COMPLETE', { color: '#4ade80', big: true, duration: 3 });
        this.resultTimer = 2.5;
        break;
      case 'fail':
        if (this.state !== 'crashed') {
          this.audio.play('fail');
          this.hud.toast('MISSION FAILED', { sub: msg, color: '#f87171', big: true, duration: 3 });
          this.resultTimer = 2.5;
        }
        break;
    }
  }

  private showResults(): void {
    const s = this.session!;
    const m = this.model!;
    this.state = 'result';
    this.touch.show(false);
    const fmt = (t: number) => `${Math.floor(t / 60)}:${Math.floor(t % 60).toString().padStart(2, '0')}`;
    const stats = [
      { label: 'Aircraft', value: m.spec.name },
      { label: 'Flight time', value: fmt(this.stats.time) },
      { label: 'Distance', value: `${(this.stats.distance / 1852).toFixed(1)} NM` },
      { label: 'Max altitude', value: `${Math.round(this.stats.maxAlt * FT_PER_M).toLocaleString()} ft` },
      { label: 'Max speed', value: `${Math.round(this.stats.maxSpeed * KTS_PER_MS)} kt` },
    ];
    const r = this.mission?.getResult() ?? null;
    let newBest = false;
    if (this.mission && r && r.success) newBest = this.store.submit(this.mission.def.id, r.score, r.time, r.stars);
    this.commitCareer();
    this.menus.showResult({
      title: s.label,
      success: r ? r.success : !m.crashed,
      reason: r ? r.reason : m.crashed ? m.crashReason : 'Flight ended',
      missionId: this.mission?.def.id ?? null,
      result: r,
      newBest,
      stats,
      hasNext: !!this.mission,
    });
  }

  // ------------------------------------------------------------------ input actions

  private handleAction(a: Action): void {
    const m = this.model;
    if (a === 'mute') {
      const muted = !this.audio.isMuted;
      this.audio.setMuted(muted);
      this.store.settings.muted = muted;
      this.store.save();
      this.hud.toast(muted ? 'Sound off' : 'Sound on', { duration: 1.2 });
      return;
    }
    if (this.state === 'paused' || this.state === 'menu' || this.state === 'result') {
      if (a === 'pause') {
        if (this.state === 'paused' && this.menus.current === 'pause') this.resume();
        else if (!this.menus.back() && this.state === 'paused') this.resume();
      }
      return;
    }
    if (a === 'pause' || a === 'help') {
      if (this.state === 'flying') {
        this.pause();
        if (a === 'help') this.menus.showControls(() => this.menus.showPause(!!this.mission, this.session?.label ?? ''));
      } else if (this.state === 'crashed') this.showResults();
      return;
    }
    if (a === 'restart') return this.restart();
    if (a === 'camera') {
      const mode = this.camCtl.cycle();
      this.hud.toast(CAMERA_LABELS[mode], { duration: 1.2 });
      return;
    }
    if (a === 'hud') {
      const order = ['full', 'instruments', 'minimal'] as const;
      const cur = this.store.settings.hud;
      this.store.settings.hud = order[(order.indexOf(cur) + 1) % 3];
      this.hint.classList.add('hidden');
      this.store.save();
      this.hud.toast(`HUD: ${this.store.settings.hud}`, { duration: 1.2 });
      return;
    }
    if (a === 'map') {
      this.bigMap = !this.bigMap;
      return;
    }
    if (!m || this.state !== 'flying') return;
    const spec = m.spec;
    switch (a) {
      case 'gear':
        if (!spec.gear.retractable) this.hud.toast('Fixed landing gear', { duration: 1.2 });
        else if (!m.toggleGear()) this.hud.toast('Cannot retract gear on the ground', { color: '#fbbf24' });
        break;
      case 'flapsDown':
        m.setFlaps(m.flapsDetent + 1);
        break;
      case 'flapsUp':
        m.setFlaps(m.flapsDetent - 1);
        break;
      case 'flapsCycle':
        m.setFlaps(m.flapsDetent >= spec.flaps.detents.length - 1 ? 0 : m.flapsDetent + 1);
        break;
      case 'autopilot':
        if (this.fcs.autopilot.engaged) this.fcs.disengageAutopilot();
        else if (!this.fcs.engageAutopilot(m)) this.hud.toast('Autopilot unavailable on the ground', { color: '#fbbf24' });
        break;
      case 'lights':
        this.lightsOn = !this.lightsOn;
        this.audio.play('toggle');
        this.hud.toast(this.lightsOn ? 'Lights ON' : 'Lights OFF', { duration: 1 });
        break;
      case 'smoke':
        if (spec.hasSmoke) {
          m.smokeOn = !m.smokeOn;
          this.audio.play('toggle');
          this.hud.toast(m.smokeOn ? 'Smoke ON' : 'Smoke OFF', { duration: 1 });
        } else this.hud.toast('No smoke system on this aircraft', { duration: 1.2 });
        break;
      case 'engine':
        if (this.mission?.engineFailed) {
          this.hud.toast('Engine will not restart!', { color: '#f87171' });
          break;
        }
        if (m.fuel <= 0) {
          this.hud.toast('No fuel', { color: '#f87171' });
          break;
        }
        m.engineRunning = !m.engineRunning;
        this.audio.play('toggle');
        this.hud.toast(m.engineRunning ? 'Engine start' : 'Engine shutdown', { duration: 1.4 });
        break;
      case 'parkingBrake':
        m.parkingBrake = !m.parkingBrake;
        this.audio.play('toggle');
        this.hud.toast(m.parkingBrake ? 'Parking brake SET' : 'Parking brake RELEASED', { duration: 1.2 });
        break;
      case 'speedbrake':
        if (spec.speedbrake) {
          m.speedbrake = m.speedbrake > 0 ? 0 : 1;
          this.hud.toast(m.speedbrake ? 'Speedbrake EXTENDED' : 'Speedbrake RETRACTED', { duration: 1.2 });
        } else this.hud.toast('No speedbrake on this aircraft', { duration: 1.2 });
        break;
      case 'trimUp':
        this.fcs.trim = clamp(this.fcs.trim + 0.03, -1, 1);
        break;
      case 'trimDown':
        this.fcs.trim = clamp(this.fcs.trim - 0.03, -1, 1);
        break;
    }
  }

  // ------------------------------------------------------------------ main loop

  private loop = (): void => {
    requestAnimationFrame(this.loop);
    const now = performance.now();
    const rawDt = (now - this.last) / 1000;
    this.last = now;
    const dt = Math.min(0.1, Math.max(0.0001, rawDt));
    this.fps += (1 / Math.max(rawDt, 0.001) - this.fps) * 0.05;
    this.time += dt;
    this.frame(dt);
  };

  private frame(dt: number): void {
    const axes = this.input.update(dt);
    for (const a of this.input.consumeActions()) this.handleAction(a);
    const m = this.model;
    switch (this.state) {
      case 'loading':
        this.renderer.render(this.scene, this.camera);
        return;
      case 'menu':
      case 'result':
        this.updateMenuScene(dt);
        break;
      case 'preparing':
        this.updatePreparing(dt);
        break;
      case 'flying':
        this.updateFlight(dt, axes);
        break;
      case 'paused':
        this.audio.update(this.audioParams(true));
        break;
      case 'crashed':
        this.updateCrashed(dt);
        break;
    }
    if (this.state !== 'paused') {
      this.traffic.update(dt, this.world.env.night);
      for (const sp of this.traffic.smokePoints(this.trafficSmoke)) {
        if (Math.random() < dt * 45) this.smoke.emit(sp, _v2.set(0, 0, 0), { life: 9, size0: 1.2, size1: 9, alpha: 0.7, color: 0xf8f8f8, drag: 0.3 });
      }
    }
    const focus = m && this.state !== 'menu' ? (this.state === 'crashed' ? this.crashPos : m.position) : this.preview?.fm.position ?? this.camera.position;
    this.world.update(this.camera, this.state === 'paused' ? 0 : dt, focus, window.innerHeight);
    const fx = this.state === 'paused' ? 0 : dt;
    _wind.copy(this.world.env.wind);
    this.smoke.update(fx, _wind, window.innerHeight, this.camera.fov);
    this.fire.update(fx, _wind, window.innerHeight, this.camera.fov);
    this.debris.update(fx, this.world);
    this.renderer.render(this.scene, this.camera);
    if (this.state === 'flying' || this.state === 'crashed' || this.state === 'paused') this.drawHud(dt);
    else this.hud.clear();
  }

  private updateMenuScene(dt: number): void {
    const p = this.preview;
    if (!p) return;
    if (!this.dragging) this.previewYaw += dt * 0.08;
    const span = p.model.spec.wingSpan;
    const dist = Math.max(16, span * 1.35);
    const target = _v.copy(p.fm.position).add(_v2.set(0, span * 0.05, 0));
    this.camera.position.set(target.x + Math.sin(this.previewYaw) * dist, target.y + dist * 0.28, target.z + Math.cos(this.previewYaw) * dist);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(target);
    if (this.camera.fov !== 50) {
      this.camera.fov = 50;
      this.camera.near = 0.5;
      this.camera.updateProjectionMatrix();
    }
    p.model.update(p.fm, dt, true, this.world.env.night);
    this.audio.update(this.audioParams(true));
  }

  private updatePreparing(dt: number): void {
    const m = this.model!;
    this.prepareTimer += dt;
    this.camCtl.update(dt, m, this.world);
    this.aircraft!.root.position.copy(m.position);
    this.aircraft!.root.quaternion.copy(m.quaternion);
    this.aircraft!.update(m, dt, this.lightsOn, this.world.env.night);
    const ready = this.world.terrain.isDetailedAround(this.camera.position) && this.world.terrain.isDetailedAround(m.position);
    this.menus.showLoading(Math.min(0.98, 0.5 + this.prepareTimer / 8), 'Loading scenery');
    if ((ready && this.prepareTimer > 0.3) || this.prepareTimer > 8) {
      this.menus.hide();
      this.state = 'flying';
      this.updateTouchVisibility();
      this.last = performance.now();
      const st = this.mission?.stage;
      if (this.mission) this.hud.toast(this.mission.def.title, { sub: st?.text, duration: 5, color: '#93c5fd' });
      else this.hud.toast('Free flight', { sub: m.onGround ? 'Throttle up with R or Shift. Press F1 for controls.' : 'Press F1 for controls.', duration: 4, color: '#93c5fd' });
      this.showHint();
    }
  }

  private showHint(): void {
    const touch = this.touch.visible;
    this.hint.textContent = touch
      ? ''
      : 'W/S pitch · A/D roll · Q/E rudder · R/F throttle · G gear · V flaps · Space brakes · C camera · Z autopilot · F1 help';
    this.hint.classList.toggle('hidden', touch || this.store.settings.hud === 'instruments');
    window.setTimeout(() => this.hint.classList.add('hidden'), 12000);
  }

  private updateFlight(dt: number, axes: ReturnType<Input['update']>): void {
    const m = this.model!;
    const fcs = this.fcs;
    // Throttle.
    const numThr = this.input.numberThrottle();
    let thrInput = false;
    if (axes.throttleAbs !== null) {
      m.throttle = axes.throttleAbs;
      thrInput = true;
    } else if (numThr !== null) {
      m.throttle = numThr;
      thrInput = true;
    } else if (axes.throttleDelta) {
      m.throttle = clamp(m.throttle + axes.throttleDelta * dt * 0.6, 0, 1);
      thrInput = true;
    }
    if (thrInput && fcs.autopilot.engaged && fcs.autopilot.autothrottle) {
      fcs.autopilot.autothrottle = false;
      this.hud.toast('Autothrottle OFF', { duration: 1.5, color: '#ff7cf2' });
    }
    if (this.touch.visible) this.touch.setThrottle(m.throttle);
    m.brake = axes.brake;
    // Continuous trim while held.
    if (this.input.isDown('Comma') || this.input.isDown('Home')) fcs.trim = clamp(fcs.trim + 0.25 * dt, -1, 1);
    if (this.input.isDown('Period') || this.input.isDown('End')) fcs.trim = clamp(fcs.trim - 0.25 * dt, -1, 1);
    // Camera look.
    this.camCtl.look(axes.lookX, axes.lookY, dt);
    if (this.input.isDown('KeyB') && this.camCtl.mode !== 'orbit') {
      this.camCtl.lookYaw = Math.PI * 0.98;
      this.camCtl.lookPitch = 0.1;
    }

    // Physics sub-steps.
    this.prevPos.copy(m.position);
    this.accumulator += dt;
    let steps = 0;
    const pilot = { pitch: axes.pitch, roll: axes.roll, yaw: axes.yaw };
    while (this.accumulator >= PHYS_DT && steps < 48 && !m.crashed) {
      this.world.env.sampleWind(m.position, m.telemetry.agl, this.world.elapsed, _wind);
      const cmd = fcs.update(m, pilot, PHYS_DT);
      if (fcs.autopilot.engaged && fcs.autopilot.autothrottle) m.throttle = fcs.apThrottle;
      m.step(PHYS_DT, cmd, this.world, _wind, axes.yaw);
      this.accumulator -= PHYS_DT;
      steps++;
    }
    if (steps >= 48) this.accumulator = 0;
    if (!m.crashed) {
      const hit = this.traffic.collide(m.position, m.spec.bodyRadius);
      if (hit) m.crash(`Mid-air collision with ${hit.callsign}`);
    }
    if (this.state !== 'flying') return; // crashed during physics

    // Stats.
    const t = m.telemetry;
    if (!m.onGround) this.stats.time += dt;
    this.stats.distance += Math.hypot(m.position.x - this.prevPos.x, m.position.z - this.prevPos.z);
    this.stats.maxAlt = Math.max(this.stats.maxAlt, t.altitude);
    this.stats.maxSpeed = Math.max(this.stats.maxSpeed, t.airspeed);

    // Free-flight landing detection.
    if (this.landingCheck) {
      if (m.wheelsOnGround > 0 && t.groundSpeed < 2) {
        this.landingCheck.time += dt;
        if (this.landingCheck.time > 1) {
          this.stats.landings++;
          const apc = this.landingCheck.airport;
          this.hud.toast('Landed', { sub: apc ? this.world.map.getAirport(apc).name : undefined, color: '#4ade80', duration: 3 });
          this.audio.play('success');
          this.landingCheck = null;
        }
      } else if (!m.onGround) this.landingCheck = null;
    }

    // Mission.
    if (this.mission) {
      this.mission.update(dt, m, this.prevPos);
      this.updateRings(dt);
      if (this.resultTimer >= 0) {
        this.resultTimer -= dt;
        if (this.resultTimer < 0) return this.showResults();
      }
    }

    // Visuals.
    const ac = this.aircraft!;
    ac.root.position.copy(m.position);
    ac.root.quaternion.copy(m.quaternion);
    ac.root.updateMatrixWorld(true);
    ac.update(m, dt, this.lightsOn, this.world.env.night);
    ac.setCockpitView(this.camCtl.mode === 'cockpit');
    this.camCtl.update(dt, m, this.world);
    if (m.afterburner) this.camCtl.shake(0.15);
    if (m.onGround && t.groundSpeed > 20) this.camCtl.shake(0.04 + t.groundSpeed / 2000);
    this.emitEffects(dt);
    this.updateWeatherFx(dt);
    this.audio.update(this.audioParams(false));
  }

  private updateRings(dt: number): void {
    if (!this.mission) return;
    const states = this.mission.ringStates();
    for (const rm of this.ringMeshes) {
      const st = states[rm.idx].state;
      rm.mesh.visible = st !== 'done';
      rm.mesh.material = st === 'next' ? this.ringMat.next : this.ringMat.future;
      const s = st === 'next' ? 1 + Math.sin(this.time * 4) * 0.04 : 1;
      rm.mesh.scale.setScalar(s);
    }
    void dt;
  }

  private emitEffects(dt: number): void {
    const m = this.model!;
    const ac = this.aircraft!;
    const t = m.telemetry;
    // Smoke trail.
    if (m.smokeOn) {
      const n = Math.max(1, Math.round(dt * 70));
      ac.worldPoint(ac.points.smoke, _v);
      for (let k = 0; k < n; k++) {
        _v2.copy(m.velocity).multiplyScalar(0.05);
        const f = k / n;
        _air.copy(_v).addScaledVector(m.velocity, -dt * f);
        this.smoke.emit(_air, _v2, { life: 9, size0: 1.2, size1: 9, alpha: 0.75, color: 0xf8f8f8, drag: 0.3 });
      }
    }
    // Contrails at altitude for jets.
    if (m.spec.engine.type === 'jet' && t.altitude > 7500 && m.engineSpool > 0.6) {
      for (const ex of ac.points.exhaust) {
        ac.worldPoint(ex, _v);
        this.smoke.emit(_v, _v2.set(0, 0, 0), { life: 14, size0: 2, size1: 14, alpha: 0.5, color: 0xffffff, drag: 0.1 });
      }
    }
    // Wingtip vortices when pulling hard.
    if (!m.onGround && t.airspeed > 45 && (t.gLoad > 2.6 || t.alpha > m.spec.aero.alphaStall * 0.6)) {
      for (const wt of ac.points.wingTips) {
        ac.worldPoint(wt, _v);
        this.smoke.emit(_v, _v2.set(0, 0, 0), { life: 0.9, size0: 0.4, size1: 1.0, alpha: 0.35, color: 0xffffff, drag: 0.2 });
      }
    }
    // Dust on grass/sand.
    if (m.onGround && t.groundSpeed > 8 && Math.random() < dt * 20) {
      const surf = this.world.surfaceType(m.position.x, m.position.z);
      if (surf === 'grass' || surf === 'sand') {
        _v.copy(m.position);
        _v.y = this.world.groundHeight(_v.x, _v.z) + 0.5;
        this.smoke.emit(_v, _v2.set(0, 1, 0), { life: 2, size0: 1.5, size1: 6, alpha: 0.35, color: surf === 'sand' ? 0xd8c79c : 0x9a8b6a, drag: 1.5 });
      }
    }
    // Light exhaust haze for jets at high power on the ground.
    if (m.spec.engine.type === 'jet' && m.onGround && m.engineSpool > 0.85) {
      for (const ex of ac.points.exhaust) {
        ac.worldPoint(ex, _v);
        _v2.set(0, 0, 25).applyQuaternion(m.quaternion);
        this.smoke.emit(_v, _v2, { life: 1.2, size0: 1, size1: 6, alpha: 0.12, color: 0xcfcfcf, drag: 2 });
      }
    }
  }

  private updateWeatherFx(dt: number): void {
    const env = this.world.env;
    const cam = this.camera.position;
    // Cloud white-out.
    const dens = this.world.clouds.densityAt(cam);
    this.whiteout.style.opacity = String(Math.min(0.92, dens * 1.6));
    if (env.night > 0.5) this.whiteout.style.background = '#1a1f29';
    else this.whiteout.style.background = '#e8edf2';
    // Rain.
    this.rain.intensity = env.rain * (cam.y < env.cloudBase + env.cloudThickness ? 1 : 0);
    const m = this.model;
    this.rain.update(dt, this.camera, m ? m.velocity : _v.set(0, 0, 0), env.wind);
    // Lightning in storms.
    if (env.options.weather === 'storm') {
      this.nextLightning -= dt;
      if (this.nextLightning < 0) {
        this.lightning = 1;
        this.nextLightning = 6 + Math.random() * 14;
        window.setTimeout(() => this.audio.play('crash'), 600 + Math.random() * 2000);
      }
    }
    if (this.lightning > 0) {
      this.lightning = Math.max(0, this.lightning - dt * 4);
      this.world.hemi.intensity = env.hemiIntensity + this.lightning * 6 * (Math.random() > 0.3 ? 1 : 0.3);
    } else this.world.hemi.intensity = env.hemiIntensity;
  }

  private updateCrashed(dt: number): void {
    this.crashTimer += dt;
    this.camCtl.updateCrash(dt, this.crashPos, this.world);
    // Lingering smoke column.
    if (Math.random() < dt * 25 && !this.world.isWater(this.crashPos.x, this.crashPos.z)) {
      _v2.set((Math.random() - 0.5) * 3, 5 + Math.random() * 4, (Math.random() - 0.5) * 3);
      this.smoke.emit(this.crashPos, _v2, { life: 9, size0: 5, size1: 34, alpha: 0.45, color: 0x303030, rise: 1.5, drag: 0.7, fadeIn: 0.15 });
      if (this.crashTimer < 8) this.fire.emit(this.crashPos, _v2.multiplyScalar(0.6), { life: 0.8, size0: 3, size1: 8, alpha: 0.7, color: 0xff7a1a, drag: 2, rise: 3 });
    }
    this.audio.update(this.audioParams(false, true));
    if (this.crashTimer > 3.2 && this.state === 'crashed') this.showResults();
  }

  private audioParams(paused: boolean, crashed = false): Parameters<AudioEngine['update']>[0] {
    const m = this.model;
    if (!m || crashed) {
      return { spool: 0, rpm: 0, throttle: 0, afterburner: false, running: false, airspeed: 0, stallWarning: false, pullUp: false, overspeed: false, gearWarning: false, cockpit: false, distance: 50, paused: paused || this.state === 'menu' || this.state === 'result' };
    }
    const w = this.lastWarnings;
    return {
      spool: m.engineSpool,
      rpm: m.rpm,
      throttle: m.throttle,
      afterburner: m.afterburner,
      running: m.engineRunning,
      airspeed: m.telemetry.airspeed,
      stallWarning: w.some((x) => x.text === 'STALL'),
      pullUp: w.some((x) => x.text === 'PULL UP' || x.text === 'TERRAIN'),
      overspeed: w.some((x) => x.text === 'OVERSPEED'),
      gearWarning: w.some((x) => x.text === 'GEAR'),
      cockpit: this.camCtl.mode === 'cockpit',
      distance: this.camera.position.distanceTo(m.position),
      paused,
    };
  }

  // ------------------------------------------------------------------ HUD

  private lastWarnings: Warning[] = [];

  private computeWarnings(): Warning[] {
    const m = this.model!;
    const t = m.telemetry;
    const spec = m.spec;
    const w: Warning[] = [];
    if (m.crashed) return w;
    const airborne = !m.onGround && t.agl > 3;
    if (airborne && (t.stallFactor > 0.25 || t.alpha > (spec.aero.alphaStall + spec.flaps.alphaStall * m.flapsPos) * 0.92)) w.push({ text: 'STALL', level: 'warning' });
    // Terrain awareness: look ahead along the velocity vector.
    if (airborne && t.airspeed > 20) {
      const look = clamp(t.airspeed * 0.06, 3, 9);
      let danger = false;
      for (const s of [0.4, 0.7, 1]) {
        _v.copy(m.position).addScaledVector(m.velocity, look * s);
        const gh = this.world.groundHeight(_v.x, _v.z);
        const nearRunway = this.world.map.runwayAt(_v.x, _v.z, 150);
        if (_v.y < gh + 12 && !(nearRunway && m.gearDown && t.verticalSpeed > -6)) danger = true;
      }
      if (danger) w.push({ text: 'PULL UP', level: 'warning' });
    }
    if (t.airspeed > spec.limits.vne) w.push({ text: 'OVERSPEED', level: 'warning' });
    if (t.gLoad > spec.limits.gMax || t.gLoad < spec.limits.gMin) w.push({ text: 'OVER-G', level: 'warning' });
    if (spec.gear.retractable && m.gearPos < 0.5 && airborne && t.agl < 250 && t.airspeed < spec.speeds.approach * 1.35 && t.verticalSpeed < 0)
      w.push({ text: 'GEAR', level: 'warning' });
    if (airborne && Math.abs(t.bank) > 75 && t.agl < 400) w.push({ text: 'BANK ANGLE', level: 'caution' });
    if (!m.engineRunning && airborne) w.push({ text: 'ENGINE OFF', level: 'caution' });
    if (m.fuel / spec.fuelCapacity < 0.1) w.push({ text: m.fuel <= 0 ? 'NO FUEL' : 'LOW FUEL', level: 'caution' });
    if (m.parkingBrake && m.throttle > 0.3 && m.onGround) w.push({ text: 'PARKING BRAKE', level: 'caution' });
    return w;
  }

  private computeIls(): IlsInfo | null {
    const m = this.model!;
    // Only shown when set up for an approach: not climbing away.
    if (m.telemetry.verticalSpeed > 1.5) return null;
    let best: IlsInfo | null = null;
    let bestScore = Infinity;
    for (const ap of this.world.map.airports) {
      for (const e of ap.runway.ends) {
        const rx = m.position.x - e.x;
        const rz = m.position.z - e.z;
        const d = -(rx * e.dx + rz * e.dz);
        if (d < -200 || d > 18000) continue;
        const lat = rx * e.dz - rz * e.dx;
        const latAng = Math.atan2(lat, Math.max(d + 1000, 1)) / DEG;
        if (Math.abs(latAng) > 10) continue;
        if (Math.abs(angleDiffDeg(m.telemetry.heading, e.heading)) > 35) continue;
        const h = m.position.y - ap.elevation;
        const gsAng = Math.atan2(h, d + 300) / DEG;
        const info: IlsInfo = {
          ident: e.ident,
          airport: ap.code,
          // Positive = aircraft right of centreline → needle shows the course to the left.
          loc: clamp(-latAng / 1.0, -2.5, 2.5),
          gs: clamp((gsAng - 3) / 0.3, -2.5, 2.5),
          distance: Math.max(0, d),
        };
        const score = Math.abs(latAng) * 400 + d;
        if (score < bestScore) {
          bestScore = score;
          best = info;
        }
      }
    }
    return best;
  }

  private drawHud(dt: number): void {
    const m = this.model;
    if (!m) return;
    if (this.state === 'flying') this.lastWarnings = this.computeWarnings();
    const mi = this.mission;
    let missionHud: MissionHud | null = null;
    if (mi) {
      const obj = mi.objective(m);
      missionHud = {
        title: mi.def.title,
        text: obj.text,
        progress: obj.progress,
        time: mi.time,
        label: obj.label,
        target: obj.target,
        rings: mi.ringStates().filter((r) => r.state !== 'done').map((r) => ({ pos: new Vector3(r.ring.x, r.ring.y, r.ring.z), next: r.state === 'next' })),
      };
    }
    const settings = this.store.settings;
    const hudMode = this.state === 'crashed' ? 'minimal' : settings.hud;
    this.hud.draw(
      {
        model: m,
        fcs: this.fcs,
        camera: this.camera,
        cockpit: this.camCtl.mode === 'cockpit',
        units: settings.units,
        mode: hudMode,
        warnings: this.state === 'flying' ? this.lastWarnings : [],
        ils: this.state === 'flying' && !m.onGround ? this.computeIls() : null,
        mission: this.state === 'flying' ? missionHud : null,
        fps: settings.showFps ? this.fps : null,
        cameraLabel: CAMERA_LABELS[this.camCtl.mode],
        lights: this.lightsOn,
        wind: { speed: this.world.env.windSpeed, from: this.world.env.windFrom },
        minimap: this.state === 'flying' ? this.minimap : null,
        bigMap: this.bigMap && this.state === 'flying',
        touch: this.touch.visible,
        traffic: this.traffic.info(),
      },
      dt,
    );
  }

  // ------------------------------------------------------------------ test hooks

  /** Small API used by end-to-end tests and debugging. */
  debugApi(): Record<string, unknown> {
    return {
      state: () => this.state,
      menu: () => this.menus.current,
      startFreeFlight: (cfg: Partial<FreeFlightConfig>) =>
        this.startFreeFlight({ aircraft: 'kestrel', location: 'HBR-09', time: 'day', weather: 'clear', windSpeed: 0, windFrom: 0, ...cfg }),
      startMission: (id: string, ac?: string) => this.startMission(id, ac ?? this.missions.find((x) => x.id === id)?.aircraft ?? 'kestrel'),
      missions: () => this.missions.map((x) => x.id),
      telemetry: () => {
        const m = this.model;
        if (!m) return null;
        return {
          ...m.telemetry,
          throttle: m.throttle,
          onGround: m.onGround,
          wheels: m.wheelsOnGround,
          groundTime: m.groundTime,
          crashed: m.crashed,
          crashReason: m.crashReason,
          gearPos: m.gearPos,
          flaps: m.flapsDetent,
          x: m.position.x,
          y: m.position.y,
          z: m.position.z,
          vx: m.velocity.x,
          vy: m.velocity.y,
          vz: m.velocity.z,
          gamma: m.gamma,
          q: m.omega.y,
          r: m.omega.z,
          fbw: m.spec.fbw,
          approach: m.spec.speeds.approach,
        };
      },
      runwayEnd: (code: string, end: 0 | 1) => {
        const ap = this.world.map.getAirport(code);
        const e = ap.runway.ends[end];
        return { x: e.x, z: e.z, dx: e.dx, dz: e.dz, elevation: ap.elevation, heading: e.heading };
      },
      mission: () => (this.mission ? { stage: this.mission.stageIndex, rings: this.mission.ringsPassed, state: this.mission.state } : null),
      setThrottle: (v: number) => this.model && (this.model.throttle = v),
      press: (a: Action) => this.input.trigger(a),
      chunks: () => this.world.terrain.chunkCount,
      aircraftSpec: (): AircraftSpec | null => this.model?.spec ?? null,
      setCameraMode: (mode: 'chase' | 'cockpit' | 'orbit' | 'flyby') => this.camCtl.setMode(mode),
      exit: () => this.exitToMenu(),
      world: () => this.world,
      /** Remove transient messages (used for clean screenshots). */
      cleanHud: () => {
        this.hud.clearToasts();
        this.hint.classList.add('hidden');
      },
      /** Fast-forward the flight (no rendering) with optional fixed pilot inputs. */
      simulate: (seconds: number, inp: { pitch?: number; roll?: number; yaw?: number; throttle?: number; brake?: number } = {}) => {
        const dt = 1 / 60;
        for (let i = 0; i < Math.round(seconds / dt) && this.state === 'flying'; i++) {
          const ax = this.input.update(dt);
          if (inp.pitch !== undefined) ax.pitch = inp.pitch;
          if (inp.roll !== undefined) ax.roll = inp.roll;
          if (inp.yaw !== undefined) ax.yaw = inp.yaw;
          if (inp.brake !== undefined) ax.brake = inp.brake;
          if (inp.throttle !== undefined && this.model) this.model.throttle = inp.throttle;
          ax.throttleDelta = 0;
          ax.throttleAbs = null;
          for (const a of this.input.consumeActions()) this.handleAction(a);
          this.updateFlight(dt, ax);
          if ((this.state as State) === 'crashed') break;
        }
        return this.state;
      },
    };
  }
}
