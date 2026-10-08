/** On-screen controls for touch devices: virtual stick, throttle lever and buttons. */
import type { Action, Input } from './Input';
import { clamp } from '../core/math';

export class TouchControls {
  readonly root: HTMLDivElement;
  private stick: HTMLDivElement;
  private knob: HTMLDivElement;
  private lever: HTMLDivElement;
  private leverKnob: HTMLDivElement;
  private stickId: number | null = null;
  private leverId: number | null = null;
  private center = { x: 0, y: 0, r: 60 };
  visible = false;

  constructor(
    parent: HTMLElement,
    private input: Input,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'touch-controls hidden';
    this.root.innerHTML = `
      <div class="tc-stick"><div class="tc-knob"></div></div>
      <div class="tc-lever"><div class="tc-lever-track"></div><div class="tc-lever-knob"></div><span>THR</span></div>
      <div class="tc-buttons">
        <button data-action="gear">GEAR</button>
        <button data-action="flapsCycle">FLAPS</button>
        <button data-action="autopilot">AP</button>
        <button data-action="camera">CAM</button>
        <button data-action="speedbrake">SPD BRK</button>
        <button data-action="map">MAP</button>
      </div>
      <div class="tc-rudder"><button data-rudder="-1">◀ RUD</button><button data-hold="brake">BRAKE</button><button data-rudder="1">RUD ▶</button></div>
      <button class="tc-pause" data-action="pause">❚❚</button>`;
    parent.appendChild(this.root);
    this.stick = this.root.querySelector('.tc-stick')!;
    this.knob = this.root.querySelector('.tc-knob')!;
    this.lever = this.root.querySelector('.tc-lever')!;
    this.leverKnob = this.root.querySelector('.tc-lever-knob')!;

    this.stick.addEventListener('pointerdown', (e) => {
      this.stickId = e.pointerId;
      this.stick.setPointerCapture(e.pointerId);
      const r = this.stick.getBoundingClientRect();
      this.center = { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2 - 20 };
      this.moveStick(e);
    });
    this.stick.addEventListener('pointermove', (e) => e.pointerId === this.stickId && this.moveStick(e));
    const endStick = (e: PointerEvent) => {
      if (e.pointerId !== this.stickId) return;
      this.stickId = null;
      this.input.touch.x = 0;
      this.input.touch.y = 0;
      this.knob.style.transform = 'translate(-50%, -50%)';
    };
    this.stick.addEventListener('pointerup', endStick);
    this.stick.addEventListener('pointercancel', endStick);

    this.lever.addEventListener('pointerdown', (e) => {
      this.leverId = e.pointerId;
      this.lever.setPointerCapture(e.pointerId);
      this.moveLever(e);
    });
    this.lever.addEventListener('pointermove', (e) => e.pointerId === this.leverId && this.moveLever(e));
    this.lever.addEventListener('pointerup', () => (this.leverId = null));

    this.root.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach((b) => {
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.input.lastDevice = 'touch';
        this.input.trigger(b.dataset.action as Action);
      });
    });
    this.root.querySelectorAll<HTMLButtonElement>('button[data-rudder]').forEach((b) => {
      const v = Number(b.dataset.rudder);
      b.addEventListener('pointerdown', () => (this.input.touch.rudder = v));
      const off = () => (this.input.touch.rudder = 0);
      b.addEventListener('pointerup', off);
      b.addEventListener('pointerleave', off);
    });
    const brake = this.root.querySelector<HTMLButtonElement>('button[data-hold="brake"]')!;
    brake.addEventListener('pointerdown', () => (this.input.touch.brake = true));
    brake.addEventListener('pointerup', () => (this.input.touch.brake = false));
    brake.addEventListener('pointerleave', () => (this.input.touch.brake = false));
  }

  private moveStick(e: PointerEvent): void {
    const dx = e.clientX - this.center.x;
    const dy = e.clientY - this.center.y;
    const len = Math.hypot(dx, dy);
    const k = len > this.center.r ? this.center.r / len : 1;
    const x = dx * k;
    const y = dy * k;
    this.knob.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
    this.input.touch.x = clamp(x / this.center.r, -1, 1);
    // Pull back (down on screen) = nose up.
    this.input.touch.y = clamp(y / this.center.r, -1, 1);
    this.input.lastDevice = 'touch';
  }

  private moveLever(e: PointerEvent): void {
    const r = this.lever.getBoundingClientRect();
    const t = clamp(1 - (e.clientY - r.top - 20) / (r.height - 40), 0, 1);
    this.setThrottle(t);
    this.input.touch.throttle = t;
  }

  /** Reflect the current throttle on the lever. */
  setThrottle(t: number): void {
    this.leverKnob.style.bottom = `${8 + t * (this.lever.clientHeight - 56)}px`;
  }

  show(on: boolean): void {
    this.visible = on;
    this.root.classList.toggle('hidden', !on);
    this.input.touch.active = on;
  }

  static isTouchDevice(): boolean {
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches;
  }
}
