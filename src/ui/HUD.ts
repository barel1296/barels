/**
 * Head-up display and instrument panel drawn on a 2D canvas overlay.
 */
import { Vector3, type PerspectiveCamera } from 'three';
import type { FlightModel } from '../physics/FlightModel';
import type { FlightControlSystem } from '../physics/FlightControls';
import type { HudMode, Units } from '../game/Settings';
import { DEG, FPM_PER_MS, FT_PER_M, KMH_PER_MS, KTS_PER_MS, RAD, clamp, wrap360 } from '../core/math';
import type { Minimap } from './Minimap';

export interface Warning {
  text: string;
  level: 'caution' | 'warning';
}

export interface IlsInfo {
  ident: string;
  airport: string;
  /** Deviation in "dots" (-2..2): positive = aircraft right of / above the path. */
  loc: number;
  gs: number;
  distance: number;
}

export interface MissionHud {
  title: string;
  text: string;
  progress: string;
  time: number;
  label: string;
  target: Vector3 | null;
  rings?: { pos: Vector3; next: boolean }[];
}

export interface HudData {
  model: FlightModel;
  fcs: FlightControlSystem;
  camera: PerspectiveCamera;
  cockpit: boolean;
  units: Units;
  mode: HudMode;
  warnings: Warning[];
  ils: IlsInfo | null;
  mission: MissionHud | null;
  fps: number | null;
  cameraLabel: string;
  lights: boolean;
  wind: { speed: number; from: number };
  minimap: Minimap | null;
  bigMap: boolean;
  touch: boolean;
}

interface Toast {
  text: string;
  sub?: string;
  until: number;
  color: string;
  big?: boolean;
}

const GREEN = '#57ff8f';
const AMBER = '#ffc23d';
const RED = '#ff4b4b';
const WHITE = '#f4f8ff';

const _v = new Vector3();

export class HUD {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private toasts: Toast[] = [];
  private time = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.resize();
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const box = this.canvas.parentElement;
    this.w = box?.clientWidth || window.innerWidth;
    this.h = box?.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
  }

  toast(text: string, opts: { sub?: string; duration?: number; color?: string; big?: boolean } = {}): void {
    this.toasts = this.toasts.filter((t) => t.text !== text);
    this.toasts.push({ text, sub: opts.sub, until: this.time + (opts.duration ?? 2.2), color: opts.color ?? WHITE, big: opts.big });
    if (this.toasts.length > 4) this.toasts.shift();
  }

  clearToasts(): void {
    this.toasts = [];
  }

  clear(): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  // ------------------------------------------------------------- helpers

  private project(cam: PerspectiveCamera, p: Vector3): { x: number; y: number; behind: boolean } {
    _v.copy(p).applyMatrix4(cam.matrixWorldInverse);
    const behind = _v.z > -0.01;
    _v.applyMatrix4(cam.projectionMatrix);
    return { x: (_v.x * 0.5 + 0.5) * this.w, y: (-_v.y * 0.5 + 0.5) * this.h, behind };
  }

  private dirPoint(cam: PerspectiveCamera, headingDeg: number, pitchDeg: number): { x: number; y: number; behind: boolean } {
    const h = headingDeg * DEG;
    const p = pitchDeg * DEG;
    _v.set(Math.sin(h) * Math.cos(p), Math.sin(p), -Math.cos(h) * Math.cos(p)).multiplyScalar(10000).add(cam.position);
    return this.project(cam, _v.clone());
  }

  private text(s: string, x: number, y: number, color = GREEN, size = 14, align: CanvasTextAlign = 'left', weight = 600): void {
    const c = this.ctx;
    c.font = `${weight} ${size}px "Segoe UI", Roboto, system-ui, sans-serif`;
    c.textAlign = align;
    c.textBaseline = 'middle';
    c.lineWidth = 3;
    c.strokeStyle = 'rgba(0,0,0,0.55)';
    c.strokeText(s, x, y);
    c.fillStyle = color;
    c.fillText(s, x, y);
  }

  private line(x1: number, y1: number, x2: number, y2: number, color = GREEN, width = 2): void {
    const c = this.ctx;
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x2, y2);
    c.strokeStyle = 'rgba(0,0,0,0.4)';
    c.lineWidth = width + 2;
    c.stroke();
    c.strokeStyle = color;
    c.lineWidth = width;
    c.stroke();
  }

  private panel(x: number, y: number, w: number, h: number, r = 10): void {
    const c = this.ctx;
    c.beginPath();
    c.roundRect(x, y, w, h, r);
    c.fillStyle = 'rgba(8, 16, 26, 0.55)';
    c.fill();
    c.strokeStyle = 'rgba(160, 200, 255, 0.18)';
    c.lineWidth = 1;
    c.stroke();
  }

  private fmtSpeed(ms: number, u: Units): string {
    return u === 'imperial' ? `${Math.round(ms * KTS_PER_MS)}` : `${Math.round(ms * KMH_PER_MS)}`;
  }
  private fmtAlt(m: number, u: Units): string {
    return u === 'imperial' ? `${Math.round(m * FT_PER_M)}` : `${Math.round(m)}`;
  }
  private fmtVs(ms: number, u: Units): string {
    return u === 'imperial' ? `${Math.round((ms * FPM_PER_MS) / 10) * 10}` : `${ms.toFixed(1)}`;
  }

  // ------------------------------------------------------------- main draw

  draw(d: HudData, dt: number): void {
    this.time += dt;
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    const m = d.model;
    if (d.mode === 'full') {
      this.drawConformal(d);
      this.drawTapes(d);
    }
    if (d.mode === 'instruments') this.drawSixPack(d);
    if (d.mode !== 'minimal') this.drawSystems(d);
    this.drawObjective(d);
    this.drawWarnings(d);
    if (d.mission) this.drawMission(d.mission);
    if (d.ils && d.mode === 'full') this.drawIls(d.ils);
    if (d.minimap && !d.bigMap && d.mode !== 'minimal') d.minimap.drawMini(c, this.w, this.h, m, d.mission?.target ?? null, d.mode === 'instruments', d.touch);
    if (d.minimap && d.bigMap) d.minimap.drawBig(c, this.w, this.h, m, d.mission);
    this.drawToasts();
    // Corner info.
    const top = d.mission ? 8 : 8;
    let ty = top + 14;
    if (d.fps !== null) {
      this.text(`${d.fps.toFixed(0)} FPS`, this.w - 12, ty, WHITE, 12, 'right', 500);
      ty += 18;
    }
    if (!d.touch) this.text(d.cameraLabel, this.w - 12, ty, 'rgba(244,248,255,0.65)', 12, 'right', 500);
  }

  // ------------------------------------------------------------- conformal HUD

  private drawConformal(d: HudData): void {
    const c = this.ctx;
    const cam = d.camera;
    const m = d.model;
    const t = m.telemetry;
    const cx = this.w / 2;
    const cy = this.h / 2;
    const R = Math.min(this.w, this.h) * 0.36;
    c.save();
    c.beginPath();
    c.ellipse(cx, cy, R * 1.25, R, 0, 0, Math.PI * 2);
    c.clip();
    // Pitch ladder (world-referenced, drawn along the aircraft heading).
    const hdg = t.heading;
    for (let p = -80; p <= 80; p += 5) {
      if (p !== 0 && p % 10 !== 0 && Math.abs(p - t.pitch) > 12) continue;
      const a = this.dirPoint(cam, hdg - 4.5, p);
      const b = this.dirPoint(cam, hdg + 4.5, p);
      if (a.behind || b.behind) continue;
      const gx = (b.x - a.x) * 0.36;
      const gy = (b.y - a.y) * 0.36;
      const col = p === 0 ? GREEN : 'rgba(87,255,143,0.85)';
      if (p === 0) {
        const L = this.dirPoint(cam, hdg - 30, 0);
        const Rr = this.dirPoint(cam, hdg + 30, 0);
        if (!L.behind && !Rr.behind) this.line(L.x, L.y, Rr.x, Rr.y, col, 1.5);
        continue;
      }
      if (p > 0) {
        this.line(a.x, a.y, a.x + gx, a.y + gy, col, 1.5);
        this.line(b.x, b.y, b.x - gx, b.y - gy, col, 1.5);
      } else {
        // Dashed below the horizon.
        for (let k = 0; k < 3; k++) {
          const f0 = k / 3;
          const f1 = f0 + 0.2;
          this.line(a.x + gx * f0, a.y + gy * f0, a.x + gx * f1, a.y + gy * f1, col, 1.5);
          this.line(b.x - gx * f0, b.y - gy * f0, b.x - gx * f1, b.y - gy * f1, col, 1.5);
        }
      }
      const tick = p > 0 ? 6 : -6;
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const nx = -Math.sin(ang) * tick;
      const ny = Math.cos(ang) * tick;
      this.line(a.x, a.y, a.x + nx, a.y + ny, col, 1.5);
      this.line(b.x, b.y, b.x + nx, b.y + ny, col, 1.5);
      this.text(`${Math.abs(p)}`, a.x - 16 * Math.cos(ang), a.y - 16 * Math.sin(ang), col, 11, 'center', 500);
      this.text(`${Math.abs(p)}`, b.x + 16 * Math.cos(ang), b.y + 16 * Math.sin(ang), col, 11, 'center', 500);
    }
    // Flight path marker.
    if (m.velocity.length() > 5) {
      const fp = this.project(cam, _v.copy(m.velocity).normalize().multiplyScalar(10000).add(cam.position).clone());
      if (!fp.behind) {
        c.beginPath();
        c.arc(fp.x, fp.y, 7, 0, Math.PI * 2);
        c.strokeStyle = 'rgba(0,0,0,0.45)';
        c.lineWidth = 4;
        c.stroke();
        c.strokeStyle = GREEN;
        c.lineWidth = 2;
        c.stroke();
        this.line(fp.x - 18, fp.y, fp.x - 7, fp.y);
        this.line(fp.x + 7, fp.y, fp.x + 18, fp.y);
        this.line(fp.x, fp.y - 7, fp.x, fp.y - 14);
      }
    }
    // Boresight (nose) cross.
    const nose = this.project(cam, _v.set(0, 0, -10000).applyQuaternion(m.quaternion).add(cam.position).clone());
    if (!nose.behind) {
      this.line(nose.x - 12, nose.y, nose.x - 4, nose.y, GREEN, 2);
      this.line(nose.x + 4, nose.y, nose.x + 12, nose.y, GREEN, 2);
      this.line(nose.x, nose.y - 4, nose.x, nose.y - 10, GREEN, 2);
    }
    c.restore();
    // Bank scale (top arc).
    const bx = cx;
    const by = cy - R * 0.05;
    const br = R * 0.92;
    c.save();
    for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
      const ang = (a - 90) * DEG;
      const len = a % 30 === 0 ? 10 : 6;
      this.line(bx + Math.cos(ang) * br, by + Math.sin(ang) * br, bx + Math.cos(ang) * (br + len), by + Math.sin(ang) * (br + len), 'rgba(87,255,143,0.8)', 1.5);
    }
    const bank = clamp(t.bank, -70, 70);
    const ba = (-bank - 90) * DEG;
    const px = bx + Math.cos(ba) * (br - 2);
    const py = by + Math.sin(ba) * (br - 2);
    c.translate(px, py);
    c.rotate(ba + Math.PI / 2);
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(-7, 11);
    c.lineTo(7, 11);
    c.closePath();
    c.fillStyle = Math.abs(t.bank) > 60 ? AMBER : GREEN;
    c.fill();
    c.restore();
  }

  private drawTapes(d: HudData): void {
    const c = this.ctx;
    const m = d.model;
    const t = m.telemetry;
    const u = d.units;
    const cx = this.w / 2;
    const cy = this.h / 2;
    const R = Math.min(this.w, this.h) * 0.36;
    const tapeH = R * 1.3;
    // ---- Speed tape (left) ----
    const sx = cx - R * 1.32 - 50;
    const spd = (u === 'imperial' ? KTS_PER_MS : KMH_PER_MS) * t.ias;
    const step = u === 'imperial' ? 10 : 20;
    const ppu = tapeH / (step * 8);
    c.save();
    c.beginPath();
    c.rect(sx - 40, cy - tapeH / 2, 80, tapeH);
    c.clip();
    for (let v = Math.floor((spd - step * 5) / step) * step; v < spd + step * 5; v += step / 2) {
      if (v < 0) continue;
      const y = cy - (v - spd) * ppu;
      const major = v % step === 0;
      this.line(sx + 22, y, sx + (major ? 10 : 16), y, 'rgba(87,255,143,0.8)', 1.5);
      if (major) this.text(`${v}`, sx + 4, y, 'rgba(87,255,143,0.85)', 12, 'right', 500);
    }
    // Speed bands: stall (red), flap range etc.
    const conv = u === 'imperial' ? KTS_PER_MS : KMH_PER_MS;
    const vs = m.spec.speeds.stall * conv;
    const vne = m.spec.limits.vne * conv;
    const yS = cy - (vs - spd) * ppu;
    c.fillStyle = 'rgba(255,75,75,0.6)';
    c.fillRect(sx + 23, yS, 4, Math.max(0, cy + tapeH / 2 - yS));
    const yN = cy - (vne - spd) * ppu;
    c.fillRect(sx + 23, cy - tapeH / 2, 4, Math.max(0, yN - (cy - tapeH / 2)));
    c.restore();
    this.box(sx - 32, cy - 14, 56, 28, `${Math.round(spd)}`, t.stallFactor > 0.3 || t.airspeed > m.spec.limits.vne ? RED : GREEN);
    this.text(u === 'imperial' ? 'KT' : 'KM/H', sx - 4, cy - tapeH / 2 - 12, GREEN, 11, 'center', 500);
    this.text(`GS ${this.fmtSpeed(t.groundSpeed, u)}`, sx - 4, cy + tapeH / 2 + 14, GREEN, 12, 'center', 500);
    if (m.spec.engine.type === 'jet') this.text(`M ${t.mach.toFixed(2)}`, sx - 4, cy + tapeH / 2 + 32, GREEN, 12, 'center', 500);

    // ---- Altitude tape (right) ----
    const ax = cx + R * 1.32 + 50;
    const alt = t.altitude * (u === 'imperial' ? FT_PER_M : 1);
    const astep = u === 'imperial' ? 100 : 50;
    const appu = tapeH / (astep * 8);
    c.save();
    c.beginPath();
    c.rect(ax - 40, cy - tapeH / 2, 90, tapeH);
    c.clip();
    for (let v = Math.floor((alt - astep * 5) / astep) * astep; v < alt + astep * 5; v += astep / 2) {
      const y = cy - (v - alt) * appu;
      const major = v % astep === 0;
      this.line(ax - 22, y, ax - (major ? 10 : 16), y, 'rgba(87,255,143,0.8)', 1.5);
      if (major) this.text(`${v}`, ax - 4, y, 'rgba(87,255,143,0.85)', 12, 'left', 500);
    }
    // Ground (terrain) marker.
    const gAlt = (t.altitude - t.agl) * (u === 'imperial' ? FT_PER_M : 1);
    const yG = cy - (gAlt - alt) * appu;
    if (yG < cy + tapeH / 2) {
      c.fillStyle = 'rgba(210,140,60,0.5)';
      c.fillRect(ax - 22, yG, 12, cy + tapeH / 2 - yG);
    }
    c.restore();
    this.box(ax - 26, cy - 14, 70, 28, `${Math.round(alt)}`, GREEN);
    this.text(u === 'imperial' ? 'FT' : 'M', ax + 8, cy - tapeH / 2 - 12, GREEN, 11, 'center', 500);
    const vsTxt = this.fmtVs(t.verticalSpeed, u);
    this.text(`VS ${t.verticalSpeed >= 0 ? '+' : ''}${vsTxt}`, ax + 8, cy + tapeH / 2 + 14, GREEN, 12, 'center', 500);
    if (t.agl < 760) this.text(`R ${this.fmtAlt(Math.max(0, t.agl - 1), u)}`, ax + 8, cy + tapeH / 2 + 32, t.agl < 60 ? AMBER : GREEN, 12, 'center', 600);

    // ---- Heading tape (top) ----
    const hy = cy - R - 40;
    const tapeW = R * 1.3;
    const hdg = t.heading;
    c.save();
    c.beginPath();
    c.rect(cx - tapeW / 2, hy - 20, tapeW, 40);
    c.clip();
    const hppu = tapeW / 60;
    for (let v = Math.floor((hdg - 35) / 5) * 5; v < hdg + 35; v += 5) {
      const x = cx + (v - hdg) * hppu;
      const major = v % 10 === 0;
      this.line(x, hy + 10, x, hy + (major ? 2 : 6), 'rgba(87,255,143,0.8)', 1.5);
      if (major) {
        const h = wrap360(v);
        const lbl = h === 0 ? 'N' : h === 90 ? 'E' : h === 180 ? 'S' : h === 270 ? 'W' : `${(h / 10).toFixed(0).padStart(2, '0')}`;
        this.text(lbl, x, hy - 8, 'rgba(87,255,143,0.9)', 12, 'center', 600);
      }
    }
    // Autopilot heading bug.
    if (d.fcs.autopilot.engaged) {
      let dh = d.fcs.autopilot.heading - hdg;
      dh = ((dh + 540) % 360) - 180;
      const bxp = cx + clamp(dh, -30, 30) * hppu;
      c.fillStyle = '#ff7cf2';
      c.fillRect(bxp - 5, hy + 10, 10, 5);
    }
    c.restore();
    this.box(cx - 24, hy + 14, 48, 22, `${Math.round(wrap360(hdg)).toString().padStart(3, '0')}`, GREEN);

    // ---- G / AoA readouts ----
    this.text(`G ${t.gLoad.toFixed(1)}`, sx - 4, cy - tapeH / 2 - 32, t.gLoad > m.spec.limits.gMax || t.gLoad < m.spec.limits.gMin ? RED : GREEN, 13, 'center', 600);
    this.text(`α ${(t.alpha * RAD).toFixed(0)}°`, ax + 8, cy - tapeH / 2 - 32, t.stallFactor > 0.2 ? RED : GREEN, 13, 'center', 600);
  }

  private box(x: number, y: number, w: number, h: number, s: string, color: string): void {
    const c = this.ctx;
    c.fillStyle = 'rgba(0,0,0,0.55)';
    c.fillRect(x, y, w, h);
    c.strokeStyle = color;
    c.lineWidth = 1.5;
    c.strokeRect(x, y, w, h);
    this.text(s, x + w / 2, y + h / 2 + 1, color, 16, 'center', 700);
  }

  // ------------------------------------------------------------- systems panel

  private drawSystems(d: HudData): void {
    const m = d.model;
    const t = m.telemetry;
    const spec = m.spec;
    const x = 14;
    const h = 196;
    const y = this.h - h - 14;
    if (d.mode === 'instruments' || d.touch) return this.drawSystemsCompact(d);
    this.panel(x, y, 196, h);
    // Throttle bar.
    const thrPct = Math.round(m.throttle * 100);
    this.text('THR', x + 14, y + 16, WHITE, 11, 'left', 600);
    const barX = x + 16;
    const barY = y + 28;
    const barH = h - 44;
    this.ctx.fillStyle = 'rgba(255,255,255,0.12)';
    this.ctx.fillRect(barX, barY, 14, barH);
    this.ctx.fillStyle = m.afterburner ? '#ff8a3d' : '#38bdf8';
    this.ctx.fillRect(barX, barY + barH * (1 - m.throttle), 14, barH * m.throttle);
    if (spec.engine.afterburnerThrust) {
      this.ctx.fillStyle = RED;
      this.ctx.fillRect(barX - 3, barY + barH * 0.03, 20, 2);
    }
    this.text(`${thrPct}%`, barX + 7, barY + barH + 10, WHITE, 11, 'center', 600);
    const col2 = x + 50;
    let ly = y + 18;
    const row = (k: string, v: string, color = WHITE) => {
      this.text(k, col2, ly, 'rgba(244,248,255,0.6)', 11, 'left', 500);
      this.text(v, x + 184, ly, color, 12, 'right', 700);
      ly += 19;
    };
    row(spec.engine.type === 'jet' ? 'N1' : 'RPM', spec.engine.type === 'jet' ? `${m.rpm.toFixed(0)}%` : `${Math.round(m.rpm)}`, m.engineRunning ? WHITE : RED);
    const fuelPct = (m.fuel / spec.fuelCapacity) * 100;
    row('FUEL', `${fuelPct.toFixed(0)}%`, fuelPct < 10 ? RED : fuelPct < 25 ? AMBER : WHITE);
    const fl = spec.flaps.detents[m.flapsDetent];
    row('FLAPS', fl === 0 ? 'UP' : `${fl}°`, fl ? '#38bdf8' : WHITE);
    const gearTxt = !spec.gear.retractable ? 'FIXED' : m.gearPos > 0.99 ? 'DOWN' : m.gearPos < 0.01 ? 'UP' : 'TRANSIT';
    row('GEAR', gearTxt, gearTxt === 'DOWN' || gearTxt === 'FIXED' ? '#4ade80' : gearTxt === 'UP' ? WHITE : AMBER);
    if (spec.speedbrake) row('SPD BRK', m.spoilerPos > 0.05 ? (m.groundSpoilersDeployed ? 'GND' : 'EXT') : 'RET', m.spoilerPos > 0.05 ? AMBER : WHITE);
    row('BRAKES', m.parkingBrake ? 'PARK' : m.brake > 0.05 ? 'ON' : 'OFF', m.parkingBrake || m.brake > 0.05 ? AMBER : WHITE);
    const ap = d.fcs.autopilot;
    row('A/P', ap.engaged ? 'ON' : 'OFF', ap.engaged ? '#ff7cf2' : WHITE);
    if (ap.engaged) {
      this.text(`HDG ${Math.round(ap.heading).toString().padStart(3, '0')}  ALT ${this.fmtAlt(ap.altitude, d.units)}`, col2, ly, '#ff7cf2', 11, 'left', 600);
      ly += 17;
    } else if (d.fcs.assist === 'realistic') {
      row('TRIM', `${d.fcs.trim >= 0 ? '+' : ''}${(d.fcs.trim * 100).toFixed(0)}`, WHITE);
    } else {
      row('MODE', 'EASY FBW', '#93c5fd');
    }
    // Wind.
    void t;
  }

  private drawSystemsCompact(d: HudData): void {
    const m = d.model;
    const spec = m.spec;
    const items: [string, string, string][] = [
      ['THR', `${Math.round(m.throttle * 100)}%${m.afterburner ? ' AB' : ''}`, m.afterburner ? '#ff8a3d' : WHITE],
      ['FLAPS', spec.flaps.detents[m.flapsDetent] ? `${spec.flaps.detents[m.flapsDetent]}°` : 'UP', WHITE],
      ['GEAR', !spec.gear.retractable ? 'FIXED' : m.gearPos > 0.99 ? 'DOWN' : m.gearPos < 0.01 ? 'UP' : '···', m.gearPos > 0.99 ? '#4ade80' : WHITE],
      ['FUEL', `${Math.round((m.fuel / spec.fuelCapacity) * 100)}%`, WHITE],
      ['A/P', d.fcs.autopilot.engaged ? 'ON' : 'OFF', d.fcs.autopilot.engaged ? '#ff7cf2' : WHITE],
    ];
    const x = 14;
    const y = 14 + (d.mission ? 112 : 0);
    this.panel(x, y, 150, items.length * 19 + 12);
    items.forEach(([k, v, c], i) => {
      this.text(k, x + 12, y + 16 + i * 19, 'rgba(244,248,255,0.6)', 11, 'left', 500);
      this.text(v, x + 138, y + 16 + i * 19, c, 12, 'right', 700);
    });
  }

  // ------------------------------------------------------------- six-pack

  private drawSixPack(d: HudData): void {
    const c = this.ctx;
    const m = d.model;
    const t = m.telemetry;
    const reserved = d.touch ? 215 : 0;
    const size = clamp(Math.min(this.w / 7.2, (this.h - reserved) / 3.2, this.h / 4.4), 46, 150);
    const r = size / 2;
    const gap = 10;
    const totalW = size * 3 + gap * 2;
    const x0 = this.w / 2 - totalW / 2;
    const y0 = Math.max(60, this.h - size * 2 - gap - 16 - reserved);
    // Panel background.
    c.beginPath();
    c.roundRect(x0 - 14, y0 - 12, totalW + 28, size * 2 + gap + 24, 14);
    c.fillStyle = 'rgba(20,22,26,0.82)';
    c.fill();
    const centers = [0, 1, 2].flatMap((i) => [0, 1].map((j) => ({ x: x0 + r + i * (size + gap), y: y0 + r + j * (size + gap), i, j })));
    const get = (i: number, j: number) => centers.find((q) => q.i === i && q.j === j)!;
    const u = d.units;
    // Airspeed.
    {
      const p = get(0, 0);
      const kt = t.ias * KTS_PER_MS;
      const max = Math.max(200, Math.ceil((m.spec.limits.vne * KTS_PER_MS * 1.1) / 50) * 50);
      this.gaugeFace(p.x, p.y, r, u === 'imperial' ? 'KNOTS' : 'KM/H');
      const angOf = (v: number) => (-225 + (v / max) * 300) * DEG;
      const arc = (v0: number, v1: number, color: string, rr: number) => {
        c.beginPath();
        c.arc(p.x, p.y, rr, angOf(v0), angOf(v1));
        c.strokeStyle = color;
        c.lineWidth = 4;
        c.stroke();
      };
      const k = KTS_PER_MS;
      arc(m.spec.speeds.stall * k * 0.9, m.spec.speeds.approach * k * 1.5, '#e5e7eb', r * 0.86);
      arc(m.spec.speeds.stall * k, m.spec.speeds.cruise * k * 1.1, '#22c55e', r * 0.8);
      arc(m.spec.speeds.cruise * k * 1.1, m.spec.limits.vne * k, '#eab308', r * 0.8);
      arc(m.spec.limits.vne * k, m.spec.limits.vne * k * 1.02, '#ef4444', r * 0.8);
      this.ticks(p.x, p.y, r, max, max > 400 ? 50 : 20, angOf, (v) => `${u === 'imperial' ? v : Math.round(v * 1.852)}`);
      this.needle(p.x, p.y, r * 0.78, angOf(clamp(kt, 0, max)));
    }
    // Attitude.
    {
      const p = get(1, 0);
      c.save();
      c.beginPath();
      c.arc(p.x, p.y, r * 0.92, 0, Math.PI * 2);
      c.clip();
      c.translate(p.x, p.y);
      c.rotate(-t.bank * DEG);
      const off = clamp(t.pitch, -40, 40) * (r / 40);
      c.fillStyle = '#2f7fd8';
      c.fillRect(-r * 2, -r * 2 + off, r * 4, r * 2);
      c.fillStyle = '#8a5a2b';
      c.fillRect(-r * 2, off, r * 4, r * 2);
      c.strokeStyle = '#fff';
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(-r, off);
      c.lineTo(r, off);
      c.stroke();
      c.lineWidth = 1.2;
      for (const pp of [-20, -10, 10, 20]) {
        const yy = off - pp * (r / 40);
        const ww = Math.abs(pp) === 10 ? r * 0.25 : r * 0.4;
        c.beginPath();
        c.moveTo(-ww, yy);
        c.lineTo(ww, yy);
        c.stroke();
      }
      c.restore();
      // Fixed aircraft symbol.
      c.strokeStyle = '#ffb000';
      c.lineWidth = 3;
      c.beginPath();
      c.moveTo(p.x - r * 0.5, p.y);
      c.lineTo(p.x - r * 0.15, p.y);
      c.lineTo(p.x, p.y + r * 0.08);
      c.lineTo(p.x + r * 0.15, p.y);
      c.lineTo(p.x + r * 0.5, p.y);
      c.stroke();
      this.bezel(p.x, p.y, r);
    }
    // Altimeter.
    {
      const p = get(2, 0);
      this.gaugeFace(p.x, p.y, r, u === 'imperial' ? 'ALT FT' : 'ALT M');
      const alt = u === 'imperial' ? t.altitude * FT_PER_M : t.altitude;
      const angOf = (v: number) => (-90 + (v / 1000) * 360) * DEG;
      for (let v = 0; v < 1000; v += 20) {
        const a = angOf(v);
        const major = v % 100 === 0;
        c.beginPath();
        c.moveTo(p.x + Math.cos(a) * r * (major ? 0.72 : 0.8), p.y + Math.sin(a) * r * (major ? 0.72 : 0.8));
        c.lineTo(p.x + Math.cos(a) * r * 0.88, p.y + Math.sin(a) * r * 0.88);
        c.strokeStyle = '#fff';
        c.lineWidth = major ? 2 : 1;
        c.stroke();
        if (major) this.text(`${v / 100}`, p.x + Math.cos(a) * r * 0.58, p.y + Math.sin(a) * r * 0.58, '#fff', r * 0.16, 'center', 600);
      }
      this.needle(p.x, p.y, r * 0.45, angOf((alt / 10) % 1000), 4);
      this.needle(p.x, p.y, r * 0.8, angOf(alt % 1000), 2.2);
      this.text(`${Math.round(alt)}`, p.x, p.y + r * 0.42, '#fff', r * 0.16, 'center', 700);
    }
    // Turn coordinator.
    {
      const p = get(0, 1);
      this.gaugeFace(p.x, p.y, r, 'TURN');
      const rate = (m.omega.z * Math.cos(t.bank * DEG) - m.omega.y * Math.sin(-t.bank * DEG)) * RAD;
      const ang = clamp(rate / 3, -2, 2) * 15 * DEG;
      c.save();
      c.translate(p.x, p.y - r * 0.05);
      c.rotate(ang);
      c.strokeStyle = '#fff';
      c.lineWidth = 3;
      c.beginPath();
      c.moveTo(-r * 0.6, 0);
      c.lineTo(r * 0.6, 0);
      c.moveTo(0, 0);
      c.lineTo(0, -r * 0.18);
      c.stroke();
      c.restore();
      // Standard rate marks.
      for (const s of [-1, 1]) {
        const a = s * 15 * DEG;
        c.beginPath();
        c.moveTo(p.x + Math.cos(a) * r * 0.62 * s, p.y + Math.sin(a) * r * 0.62);
        c.lineTo(p.x + Math.cos(a) * r * 0.78 * s, p.y + Math.sin(a) * r * 0.78);
        c.strokeStyle = '#fff';
        c.lineWidth = 2;
        c.stroke();
      }
      // Slip ball.
      const by = p.y + r * 0.5;
      c.beginPath();
      c.roundRect(p.x - r * 0.45, by - r * 0.09, r * 0.9, r * 0.18, r * 0.09);
      c.fillStyle = '#111';
      c.fill();
      c.strokeStyle = '#888';
      c.stroke();
      const slip = clamp(-t.beta * RAD / 6, -1, 1) * r * 0.36;
      c.beginPath();
      c.arc(p.x + slip, by, r * 0.07, 0, Math.PI * 2);
      c.fillStyle = '#fff';
      c.fill();
    }
    // Heading indicator.
    {
      const p = get(1, 1);
      this.gaugeFace(p.x, p.y, r, '');
      c.save();
      c.translate(p.x, p.y);
      c.rotate(-t.heading * DEG);
      for (let hh = 0; hh < 360; hh += 10) {
        const a = (hh - 90) * DEG;
        const major = hh % 30 === 0;
        c.beginPath();
        c.moveTo(Math.cos(a) * r * (major ? 0.7 : 0.78), Math.sin(a) * r * (major ? 0.7 : 0.78));
        c.lineTo(Math.cos(a) * r * 0.88, Math.sin(a) * r * 0.88);
        c.strokeStyle = '#fff';
        c.lineWidth = major ? 2 : 1;
        c.stroke();
        if (major) {
          c.save();
          c.translate(Math.cos(a) * r * 0.56, Math.sin(a) * r * 0.56);
          c.rotate(hh * DEG);
          const lbl = hh === 0 ? 'N' : hh === 90 ? 'E' : hh === 180 ? 'S' : hh === 270 ? 'W' : `${hh / 10}`;
          this.text(lbl, 0, 0, hh % 90 === 0 ? '#ffb000' : '#fff', r * 0.17, 'center', 700);
          c.restore();
        }
      }
      c.restore();
      // Aircraft symbol.
      c.strokeStyle = '#ffb000';
      c.lineWidth = 2.5;
      c.beginPath();
      c.moveTo(p.x, p.y - r * 0.35);
      c.lineTo(p.x, p.y + r * 0.3);
      c.moveTo(p.x - r * 0.25, p.y - r * 0.05);
      c.lineTo(p.x + r * 0.25, p.y - r * 0.05);
      c.moveTo(p.x - r * 0.12, p.y + r * 0.25);
      c.lineTo(p.x + r * 0.12, p.y + r * 0.25);
      c.stroke();
      if (d.fcs.autopilot.engaged) {
        const a = (d.fcs.autopilot.heading - t.heading - 90) * DEG;
        c.fillStyle = '#ff7cf2';
        c.beginPath();
        c.arc(p.x + Math.cos(a) * r * 0.9, p.y + Math.sin(a) * r * 0.9, 4, 0, Math.PI * 2);
        c.fill();
      }
    }
    // VSI.
    {
      const p = get(2, 1);
      this.gaugeFace(p.x, p.y, r, u === 'imperial' ? 'VS ×100 FPM' : 'VS M/S');
      const vs = u === 'imperial' ? (t.verticalSpeed * FPM_PER_MS) / 100 : t.verticalSpeed;
      const max = u === 'imperial' ? 20 : 10;
      const angOf = (v: number) => (180 + (clamp(v, -max, max) / max) * 170) * DEG;
      for (let v = -max; v <= max; v += max / 4) {
        const a = angOf(v);
        c.beginPath();
        c.moveTo(p.x + Math.cos(a) * r * 0.72, p.y + Math.sin(a) * r * 0.72);
        c.lineTo(p.x + Math.cos(a) * r * 0.88, p.y + Math.sin(a) * r * 0.88);
        c.strokeStyle = '#fff';
        c.lineWidth = 2;
        c.stroke();
        this.text(`${Math.abs(v)}`, p.x + Math.cos(a) * r * 0.56, p.y + Math.sin(a) * r * 0.56, '#fff', r * 0.15, 'center', 600);
      }
      this.needle(p.x, p.y, r * 0.8, angOf(vs));
    }
  }

  private gaugeFace(x: number, y: number, r: number, label: string): void {
    const c = this.ctx;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fillStyle = '#0d0f12';
    c.fill();
    this.bezel(x, y, r);
    if (label) this.text(label, x, y + r * 0.28, 'rgba(255,255,255,0.7)', r * 0.13, 'center', 600);
  }

  private bezel(x: number, y: number, r: number): void {
    const c = this.ctx;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.strokeStyle = '#3b4048';
    c.lineWidth = 4;
    c.stroke();
  }

  private ticks(x: number, y: number, r: number, max: number, step: number, angOf: (v: number) => number, label: (v: number) => string): void {
    const c = this.ctx;
    for (let v = 0; v <= max; v += step / 2) {
      const a = angOf(v);
      const major = v % step === 0;
      c.beginPath();
      c.moveTo(x + Math.cos(a) * r * (major ? 0.66 : 0.74), y + Math.sin(a) * r * (major ? 0.66 : 0.74));
      c.lineTo(x + Math.cos(a) * r * 0.88, y + Math.sin(a) * r * 0.88);
      c.strokeStyle = '#fff';
      c.lineWidth = major ? 2 : 1;
      c.stroke();
      if (major && v % (step * 2) === 0) this.text(label(v), x + Math.cos(a) * r * 0.5, y + Math.sin(a) * r * 0.5, '#fff', r * 0.14, 'center', 600);
    }
  }

  private needle(x: number, y: number, len: number, ang: number, width = 3): void {
    const c = this.ctx;
    c.beginPath();
    c.moveTo(x - Math.cos(ang) * len * 0.15, y - Math.sin(ang) * len * 0.15);
    c.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    c.strokeStyle = '#fff';
    c.lineWidth = width;
    c.lineCap = 'round';
    c.stroke();
    c.lineCap = 'butt';
    c.beginPath();
    c.arc(x, y, 5, 0, Math.PI * 2);
    c.fillStyle = '#ddd';
    c.fill();
  }

  // ------------------------------------------------------------- overlays

  private drawWarnings(d: HudData): void {
    if (!d.warnings.length) return;
    const blink = Math.floor(this.time * 3) % 2 === 0;
    const cy = this.h / 2 + Math.min(this.w, this.h) * 0.22;
    d.warnings.slice(0, 3).forEach((w, i) => {
      const col = w.level === 'warning' ? RED : AMBER;
      if (w.level === 'warning' && !blink) return;
      const y = cy + i * 34;
      const c = this.ctx;
      c.font = '800 20px "Segoe UI", Roboto, system-ui, sans-serif';
      const tw = c.measureText(w.text).width + 28;
      c.fillStyle = 'rgba(0,0,0,0.55)';
      c.fillRect(this.w / 2 - tw / 2, y - 15, tw, 30);
      c.strokeStyle = col;
      c.lineWidth = 2;
      c.strokeRect(this.w / 2 - tw / 2, y - 15, tw, 30);
      this.text(w.text, this.w / 2, y + 1, col, 20, 'center', 800);
    });
  }

  private drawMission(mi: MissionHud): void {
    const x = 14;
    const y = 14;
    const w = Math.min(380, this.w - 28);
    this.panel(x, y, w, 96);
    this.text(mi.title.toUpperCase(), x + 14, y + 18, '#93c5fd', 12, 'left', 700);
    const mm = Math.floor(mi.time / 60);
    const ss = (mi.time % 60).toFixed(1).padStart(4, '0');
    this.text(`${mm}:${ss}`, x + w - 14, y + 18, WHITE, 14, 'right', 700);
    // Wrap objective text.
    const c = this.ctx;
    c.font = '500 13px "Segoe UI", Roboto, system-ui, sans-serif';
    const words = mi.text.split(' ');
    const lines: string[] = [];
    let cur = '';
    for (const wd of words) {
      const test = cur ? `${cur} ${wd}` : wd;
      if (c.measureText(test).width > w - 28) {
        lines.push(cur);
        cur = wd;
      } else cur = test;
    }
    if (cur) lines.push(cur);
    lines.slice(0, 3).forEach((l, i) => this.text(l, x + 14, y + 40 + i * 17, WHITE, 13, 'left', 500));
    if (mi.progress) this.text(mi.progress, x + w - 14, y + 82, '#fde68a', 13, 'right', 700);
  }

  private drawObjective(d: HudData): void {
    const mi = d.mission;
    if (!mi) return;
    const cam = d.camera;
    // Rings in view get a small marker (helps spotting them at distance).
    if (mi.rings) {
      for (const r of mi.rings) {
        if (!r.next) continue;
        const p = this.project(cam, r.pos);
        if (p.behind) continue;
        this.ctx.beginPath();
        this.ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        this.ctx.fillStyle = AMBER;
        this.ctx.fill();
      }
    }
    if (!mi.target) return;
    const p = this.project(cam, mi.target);
    const dist = cam.position.distanceTo(mi.target);
    const distTxt = d.units === 'imperial' ? `${(dist / 1852).toFixed(dist < 1852 ? 2 : 1)} NM` : `${(dist / 1000).toFixed(1)} KM`;
    const margin = 60;
    const inside = !p.behind && p.x > margin && p.x < this.w - margin && p.y > margin && p.y < this.h - margin;
    const c = this.ctx;
    if (inside && mi.label === 'RING' && dist < 2500) {
      // The ring itself is visible: just label it below.
      this.text(distTxt, p.x, p.y + 30, '#fde047', 12, 'center', 700);
    } else if (inside) {
      c.save();
      c.translate(p.x, p.y);
      c.rotate(Math.PI / 4);
      c.strokeStyle = 'rgba(0,0,0,0.5)';
      c.lineWidth = 5;
      c.strokeRect(-11, -11, 22, 22);
      c.strokeStyle = '#fde047';
      c.lineWidth = 2.5;
      c.strokeRect(-11, -11, 22, 22);
      c.restore();
      this.text(mi.label, p.x, p.y - 26, '#fde047', 12, 'center', 700);
      this.text(distTxt, p.x, p.y + 26, '#fde047', 12, 'center', 600);
    } else {
      // Edge arrow pointing toward the target.
      let dx = p.x - this.w / 2;
      let dy = p.y - this.h / 2;
      if (p.behind) {
        dx = -dx;
        dy = -dy;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) dy = 1;
      }
      const ang = Math.atan2(dy, dx);
      const ex = this.w / 2 + Math.cos(ang) * (this.w / 2 - margin);
      const ey = this.h / 2 + Math.sin(ang) * (this.h / 2 - margin);
      const k = Math.min((this.w / 2 - margin) / Math.abs(Math.cos(ang) || 1e-6), (this.h / 2 - margin) / Math.abs(Math.sin(ang) || 1e-6));
      const ax = this.w / 2 + Math.cos(ang) * k;
      const ay = this.h / 2 + Math.sin(ang) * k;
      void ex;
      void ey;
      c.save();
      c.translate(ax, ay);
      c.rotate(ang);
      c.beginPath();
      c.moveTo(16, 0);
      c.lineTo(-10, -12);
      c.lineTo(-4, 0);
      c.lineTo(-10, 12);
      c.closePath();
      c.fillStyle = '#fde047';
      c.strokeStyle = 'rgba(0,0,0,0.6)';
      c.lineWidth = 3;
      c.stroke();
      c.fill();
      c.restore();
      this.text(`${mi.label} ${distTxt}`, ax - Math.cos(ang) * 46, ay - Math.sin(ang) * 30, '#fde047', 12, 'center', 700);
    }
  }

  private drawIls(ils: IlsInfo): void {
    const c = this.ctx;
    const cx = this.w / 2;
    const cy = this.h / 2;
    const R = Math.min(this.w, this.h) * 0.3;
    const col = '#e879f9';
    // Glideslope (right side, vertical).
    const gx = cx + R * 1.05;
    for (let k = -2; k <= 2; k++) {
      c.beginPath();
      c.arc(gx, cy + k * R * 0.18, 3, 0, Math.PI * 2);
      c.strokeStyle = col;
      c.lineWidth = 1.5;
      c.stroke();
    }
    const gy = cy + clamp(ils.gs, -2.3, 2.3) * R * 0.18;
    c.beginPath();
    c.moveTo(gx, gy - 8);
    c.lineTo(gx + 7, gy);
    c.lineTo(gx, gy + 8);
    c.lineTo(gx - 7, gy);
    c.closePath();
    c.fillStyle = col;
    c.fill();
    // Localizer (bottom, horizontal).
    const ly = cy + R * 0.62;
    for (let k = -2; k <= 2; k++) {
      c.beginPath();
      c.arc(cx + k * R * 0.18, ly, 3, 0, Math.PI * 2);
      c.strokeStyle = col;
      c.stroke();
    }
    const lx = cx + clamp(ils.loc, -2.3, 2.3) * R * 0.18;
    c.beginPath();
    c.moveTo(lx - 8, ly);
    c.lineTo(lx, ly - 7);
    c.lineTo(lx + 8, ly);
    c.lineTo(lx, ly + 7);
    c.closePath();
    c.fillStyle = col;
    c.fill();
    this.text(`ILS ${ils.ident}  ${(ils.distance / 1852).toFixed(1)} NM`, cx, ly + 20, col, 12, 'center', 700);
  }

  private drawToasts(): void {
    this.toasts = this.toasts.filter((t) => t.until > this.time);
    let y = this.h * 0.2;
    for (const t of this.toasts) {
      const remain = t.until - this.time;
      const a = Math.min(1, remain / 0.4);
      this.ctx.globalAlpha = a;
      this.text(t.text, this.w / 2, y, t.color, t.big ? 34 : 20, 'center', 800);
      if (t.sub) this.text(t.sub, this.w / 2, y + (t.big ? 30 : 22), WHITE, 14, 'center', 500);
      this.ctx.globalAlpha = 1;
      y += t.big ? 64 : t.sub ? 50 : 32;
    }
  }
}
