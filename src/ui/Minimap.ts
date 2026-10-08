/** Pre-rendered island map: rotating minimap and full-screen navigation chart. */
import type { WorldMap } from '../world/WorldMap';
import { WORLD_HALF } from '../world/WorldMap';
import type { FlightModel } from '../physics/FlightModel';
import type { MissionHud } from './HUD';
import type { Vector3 } from 'three';
import { DEG } from '../core/math';

export class Minimap {
  readonly image: HTMLCanvasElement;
  private size: number;
  rangeMeters = 9000;

  constructor(
    private world: WorldMap,
    heights: Float32Array,
    size: number,
  ) {
    this.size = size;
    this.image = document.createElement('canvas');
    this.image.width = size;
    this.image.height = size;
    const ctx = this.image.getContext('2d')!;
    const img = ctx.createImageData(size, size);
    const cell = (2 * WORLD_HALF) / size;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const h = heights[r * size + c];
        const hx = heights[r * size + Math.min(c + 1, size - 1)] - h;
        const hz = heights[Math.min(r + 1, size - 1) * size + c] - h;
        let R: number;
        let G: number;
        let B: number;
        if (h < 0) {
          const t = Math.max(0, 1 + h / 120);
          R = 18 + 40 * t;
          G = 52 + 90 * t;
          B = 92 + 90 * t;
        } else {
          const t = Math.min(1, h / 1700);
          if (h < 6) {
            R = 214;
            G = 200;
            B = 150;
          } else {
            R = 92 + 120 * t;
            G = 140 + 70 * t;
            B = 70 + 150 * t;
          }
          if (h > 1400) {
            R = G = B = 235;
          }
          // Hill shading.
          const shade = Math.max(0.55, Math.min(1.35, 1 + (-hx - hz) / (cell * 0.9)));
          R *= shade;
          G *= shade;
          B *= shade;
        }
        const k = (r * size + c) * 4;
        img.data[k] = R;
        img.data[k + 1] = G;
        img.data[k + 2] = B;
        img.data[k + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // City.
    const city = world.city;
    const cp = this.toPx(city.x, city.z);
    ctx.fillStyle = 'rgba(120,120,128,0.55)';
    ctx.beginPath();
    ctx.arc(cp.x, cp.y, (city.radius / cell) * 0.9, 0, Math.PI * 2);
    ctx.fill();
    // Runways.
    for (const ap of world.airports) {
      const rw = ap.runway;
      const a = this.toPx(rw.ends[0].x, rw.ends[0].z);
      const b = this.toPx(rw.ends[1].x, rw.ends[1].z);
      ctx.strokeStyle = '#1b1b1b';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  private toPx(x: number, z: number): { x: number; y: number } {
    return { x: ((x + WORLD_HALF) / (2 * WORLD_HALF)) * this.size, y: ((z + WORLD_HALF) / (2 * WORLD_HALF)) * this.size };
  }

  /** Small heading-up circular map in the bottom-right corner. */
  drawMini(ctx: CanvasRenderingContext2D, w: number, h: number, m: FlightModel, target: Vector3 | null, lower: boolean, touch: boolean): void {
    const R = touch ? Math.min(58, Math.min(w, h) * 0.13) : Math.min(95, Math.max(60, Math.min(w, h) * 0.12));
    const cx = w - R - (touch ? 70 : 18);
    const cy = touch ? R + 12 : h - R - 18;
    void lower;
    const scale = R / this.rangeMeters; // px per metre
    const pxPerCell = this.size / (2 * WORLD_HALF);
    const hdg = m.telemetry.heading * DEG;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = '#123';
    ctx.fill();
    ctx.clip();
    ctx.translate(cx, cy);
    ctx.rotate(-hdg);
    const p = this.toPx(m.position.x, m.position.z);
    const k = scale / pxPerCell;
    ctx.scale(k, k);
    ctx.drawImage(this.image, -p.x, -p.y);
    ctx.restore();
    // Target bearing marker.
    if (target) {
      const dx = target.x - m.position.x;
      const dz = target.z - m.position.z;
      const dist = Math.hypot(dx, dz);
      const brg = Math.atan2(dx, -dz) - hdg;
      const rr = Math.min(R - 8, dist * scale);
      ctx.beginPath();
      ctx.arc(cx + Math.sin(brg) * rr, cy - Math.cos(brg) * rr, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#fde047';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fill();
    }
    // Ring + north marker.
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(200,225,255,0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();
    const na = -hdg;
    ctx.font = '700 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ff6b6b';
    ctx.fillText('N', cx + Math.sin(na) * (R - 10), cy - Math.cos(na) * (R - 10));
    // Aircraft symbol.
    ctx.beginPath();
    ctx.moveTo(cx, cy - 9);
    ctx.lineTo(cx + 6, cy + 7);
    ctx.lineTo(cx, cy + 3);
    ctx.lineTo(cx - 6, cy + 7);
    ctx.closePath();
    ctx.fillStyle = '#fde047';
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /** Full-screen north-up chart. */
  drawBig(ctx: CanvasRenderingContext2D, w: number, h: number, m: FlightModel, mission: MissionHud | null): void {
    ctx.fillStyle = 'rgba(4,10,18,0.85)';
    ctx.fillRect(0, 0, w, h);
    const size = Math.min(w, h) * 0.9;
    const x0 = (w - size) / 2;
    const y0 = (h - size) / 2;
    const s = size / this.size;
    ctx.drawImage(this.image, x0, y0, size, size);
    ctx.strokeStyle = 'rgba(200,225,255,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x0, y0, size, size);
    const to = (x: number, z: number) => {
      const p = this.toPx(x, z);
      return { x: x0 + p.x * s, y: y0 + p.y * s };
    };
    ctx.font = '700 13px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const ap of this.world.airports) {
      const p = to(ap.runway.x, ap.runway.z);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      const label = `${ap.code} ${ap.name}`;
      const tw = ctx.measureText(label).width;
      ctx.fillRect(p.x + 10, p.y - 10, tw + 10, 20);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, p.x + 15, p.y);
      ctx.font = '500 11px system-ui, sans-serif';
      ctx.fillStyle = '#93c5fd';
      ctx.fillText(`RWY ${ap.runway.name} · ${Math.round(ap.elevation * 3.28)} ft`, p.x + 15, p.y + 18);
      ctx.font = '700 13px system-ui, sans-serif';
    }
    const cp = to(this.world.city.x, this.world.city.z);
    ctx.fillStyle = '#e5e7eb';
    ctx.textAlign = 'center';
    ctx.fillText(this.world.city.name, cp.x, cp.y + 26);
    ctx.textAlign = 'left';
    if (mission?.rings) {
      for (const r of mission.rings) {
        const p = to(r.pos.x, r.pos.z);
        ctx.beginPath();
        ctx.arc(p.x, p.y, r.next ? 6 : 4, 0, Math.PI * 2);
        ctx.fillStyle = r.next ? '#fde047' : 'rgba(253,224,71,0.45)';
        ctx.fill();
      }
    }
    if (mission?.target) {
      const p = to(mission.target.x, mission.target.z);
      ctx.strokeStyle = '#fde047';
      ctx.lineWidth = 2;
      ctx.strokeRect(p.x - 8, p.y - 8, 16, 16);
    }
    // Aircraft.
    const ap = to(m.position.x, m.position.z);
    ctx.save();
    ctx.translate(ap.x, ap.y);
    ctx.rotate(m.telemetry.heading * DEG);
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(8, 9);
    ctx.lineTo(0, 4);
    ctx.lineTo(-8, 9);
    ctx.closePath();
    ctx.fillStyle = '#fde047';
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.stroke();
    ctx.restore();
    // Scale bar (10 km).
    const km10 = (10000 / (2 * WORLD_HALF)) * size;
    ctx.fillStyle = '#fff';
    ctx.fillRect(x0 + 20, y0 + size - 30, km10, 4);
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.fillText('10 km', x0 + 20, y0 + size - 42);
    ctx.textAlign = 'center';
    ctx.font = '800 16px system-ui, sans-serif';
    ctx.fillText('NAVIGATION CHART  ·  press M to close', w / 2, y0 - 14 > 10 ? y0 - 14 : 20);
  }
}
