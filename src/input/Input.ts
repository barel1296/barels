/**
 * Unified input: keyboard (physical key codes, layout independent), mouse,
 * gamepads (standard mapping) and on-screen touch controls.
 */
import { clamp } from '../core/math';

export type Action =
  | 'gear'
  | 'flapsDown'
  | 'flapsUp'
  | 'flapsCycle'
  | 'camera'
  | 'autopilot'
  | 'pause'
  | 'hud'
  | 'map'
  | 'lights'
  | 'smoke'
  | 'engine'
  | 'parkingBrake'
  | 'speedbrake'
  | 'restart'
  | 'help'
  | 'mute'
  | 'trimUp'
  | 'trimDown'
  | 'lookBack';

/** Default keyboard bindings (KeyboardEvent.code). */
export const KEY_BINDINGS: Record<Action, string[]> = {
  gear: ['KeyG'],
  flapsDown: ['BracketRight'],
  flapsUp: ['BracketLeft'],
  flapsCycle: ['KeyV'],
  camera: ['KeyC'],
  autopilot: ['KeyZ'],
  pause: ['KeyP', 'Escape'],
  hud: ['KeyH'],
  map: ['KeyM'],
  lights: ['KeyL'],
  smoke: ['KeyK'],
  engine: ['KeyI'],
  parkingBrake: ['KeyN'],
  speedbrake: ['KeyX'],
  restart: ['Backspace'],
  help: ['F1', 'Slash'],
  mute: ['KeyU'],
  trimUp: ['Comma', 'Home'],
  trimDown: ['Period', 'End'],
  lookBack: ['KeyB'],
};

export interface AxisState {
  pitch: number;
  roll: number;
  yaw: number;
  /** Rate of throttle change requested this frame (-1..1). */
  throttleDelta: number;
  /** Absolute throttle when an analog device sets it (null otherwise). */
  throttleAbs: number | null;
  brake: number;
  lookX: number;
  lookY: number;
}

export class Input {
  private keys = new Set<string>();
  private pressed: Action[] = [];
  /** Smoothed keyboard axes. */
  private kPitch = 0;
  private kRoll = 0;
  private kYaw = 0;
  readonly axes: AxisState = { pitch: 0, roll: 0, yaw: 0, throttleDelta: 0, throttleAbs: null, brake: 0, lookX: 0, lookY: 0 };
  invertPitch = false;
  sensitivity = 1;
  enabled = true;
  /** Touch controls state (written by TouchControls). */
  touch = { active: false, x: 0, y: 0, throttle: null as number | null, brake: false, rudder: 0 };
  private gpPrevButtons: boolean[] = [];
  gamepadConnected = false;
  lastDevice: 'keyboard' | 'gamepad' | 'touch' = 'keyboard';
  private onKeyDown = (e: KeyboardEvent) => this.keyDown(e);
  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);
  private onBlur = () => this.keys.clear();

  constructor() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('gamepadconnected', () => (this.gamepadConnected = true));
    window.addEventListener('gamepaddisconnected', () => (this.gamepadConnected = Input.pads().some((g) => !!g)));
  }

  private keyDown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
    // Keep the browser from scrolling or navigating on game keys.
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Slash', 'F1', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.code)) e.preventDefault();
    this.lastDevice = 'keyboard';
    if (!e.repeat) {
      for (const [action, codes] of Object.entries(KEY_BINDINGS) as [Action, string[]][]) {
        if (codes.includes(e.code)) this.pressed.push(action);
      }
    }
    this.keys.add(e.code);
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** Inject an action (from touch buttons / UI). */
  trigger(action: Action): void {
    this.pressed.push(action);
  }

  /** Returns and clears the actions pressed since the last call. */
  consumeActions(): Action[] {
    const a = this.pressed;
    this.pressed = [];
    return this.enabled ? a : a.filter((x) => x === 'pause' || x === 'help' || x === 'mute');
  }

  /** Sample all devices; call once per frame. */
  update(dt: number): AxisState {
    const k = (code: string) => this.keys.has(code);
    const ax = this.axes;
    // ---- keyboard (with spring-centring ramps) ----
    const tPitch = (k('KeyS') || k('ArrowDown') ? 1 : 0) - (k('KeyW') || k('ArrowUp') ? 1 : 0);
    const tRoll = (k('KeyD') || k('ArrowRight') ? 1 : 0) - (k('KeyA') || k('ArrowLeft') ? 1 : 0);
    const tYaw = (k('KeyE') ? 1 : 0) - (k('KeyQ') ? 1 : 0);
    const ramp = (cur: number, target: number, up: number, down: number) => {
      const rate = target === 0 ? down : Math.sign(target) !== Math.sign(cur) && cur !== 0 ? down * 1.5 : up;
      const d = target - cur;
      return cur + clamp(d, -rate * dt, rate * dt);
    };
    this.kPitch = ramp(this.kPitch, tPitch, 2.2 * this.sensitivity, 4);
    this.kRoll = ramp(this.kRoll, tRoll, 3.0 * this.sensitivity, 5);
    this.kYaw = ramp(this.kYaw, tYaw, 2.5, 4);
    let pitch = this.kPitch;
    let roll = this.kRoll;
    let yaw = this.kYaw;
    let thrDelta = (k('KeyR') || k('ShiftLeft') || k('ShiftRight') || k('PageUp') || k('Equal') || k('NumpadAdd') ? 1 : 0) -
      (k('KeyF') || k('PageDown') || k('Minus') || k('NumpadSubtract') ? 1 : 0);
    let thrAbs: number | null = null;
    let brake = k('Space') ? 1 : 0;
    let lookX = 0;
    let lookY = 0;

    // ---- gamepad ----
    const gp = Input.pads().find((g) => g && g.connected) ?? null;
    if (gp) {
      this.gamepadConnected = true;
      const dz = (v: number, d = 0.12) => (Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d));
      const lx = dz(gp.axes[0] ?? 0);
      const ly = dz(gp.axes[1] ?? 0);
      const rx = dz(gp.axes[2] ?? 0);
      const ry = dz(gp.axes[3] ?? 0);
      const b = (i: number) => gp.buttons[i]?.pressed ?? false;
      const bv = (i: number) => gp.buttons[i]?.value ?? 0;
      if (Math.abs(lx) + Math.abs(ly) > 0) {
        roll = lx;
        pitch = ly;
        this.lastDevice = 'gamepad';
      }
      // Bumpers = rudder, right stick = look.
      const rud = (b(5) ? 1 : 0) - (b(4) ? 1 : 0);
      if (rud) yaw = rud;
      lookX = rx;
      lookY = ry;
      // Triggers: RT throttle up / LT throttle down (rate).
      const rt = bv(7);
      const lt = bv(6);
      if (rt > 0.05 || lt > 0.05) {
        thrDelta = rt - lt;
        this.lastDevice = 'gamepad';
      }
      const pressedNow = gp.buttons.map((x) => x.pressed);
      const edge = (i: number) => pressedNow[i] && !this.gpPrevButtons[i];
      if (edge(0)) this.pressed.push('gear');
      if (edge(1)) this.pressed.push('flapsCycle');
      if (edge(3)) this.pressed.push('camera');
      if (edge(9)) this.pressed.push('pause');
      if (edge(8)) this.pressed.push('map');
      if (edge(12)) this.pressed.push('autopilot');
      if (edge(13)) this.pressed.push('lights');
      if (edge(14)) this.pressed.push('hud');
      if (edge(15)) this.pressed.push('smoke');
      if (edge(10)) this.pressed.push('speedbrake');
      if (b(2)) brake = 1;
      this.gpPrevButtons = pressedNow;
    }

    // ---- touch ----
    if (this.touch.active) {
      if (Math.abs(this.touch.x) + Math.abs(this.touch.y) > 0.01) {
        roll = this.touch.x;
        pitch = this.touch.y;
        this.lastDevice = 'touch';
      }
      if (this.touch.throttle !== null) thrAbs = this.touch.throttle;
      if (this.touch.brake) brake = 1;
      if (this.touch.rudder) yaw = this.touch.rudder;
    }

    if (this.invertPitch) pitch = -pitch;
    ax.pitch = this.enabled ? clamp(pitch, -1, 1) : 0;
    ax.roll = this.enabled ? clamp(roll, -1, 1) : 0;
    ax.yaw = this.enabled ? clamp(yaw, -1, 1) : 0;
    ax.throttleDelta = this.enabled ? thrDelta : 0;
    ax.throttleAbs = this.enabled ? thrAbs : null;
    ax.brake = this.enabled ? brake : 0;
    ax.lookX = lookX;
    ax.lookY = lookY;
    return ax;
  }

  /** Connected gamepads; empty when the API is missing or blocked by the embedding page. */
  static pads(): (Gamepad | null)[] {
    try {
      return navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
    } catch {
      return [];
    }
  }

  /** Number keys 0-9 set throttle directly (0 = idle, 9 = 100 %). */
  numberThrottle(): number | null {
    for (let d = 0; d <= 9; d++) {
      if (this.keys.has(`Digit${d}`)) return d === 0 ? 0 : d / 9;
    }
    return null;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }
}
