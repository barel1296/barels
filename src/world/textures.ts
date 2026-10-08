/** Procedurally generated canvas textures (no image assets needed). */
import { CanvasTexture, RepeatWrapping, SRGBColorSpace, LinearMipmapLinearFilter, type Texture } from 'three';
import { Simplex2 } from './noise';
import { mulberry32 } from '../core/math';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unsupported');
  return [c, ctx];
}

function finish(c: HTMLCanvasElement, repeat = true, srgb = true): CanvasTexture {
  const t = new CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = RepeatWrapping;
  if (srgb) t.colorSpace = SRGBColorSpace;
  t.minFilter = LinearMipmapLinearFilter;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/** Tileable value noise on a periodic lattice. */
function tileValueNoise(size: number, periods: number[], seed: number): Float32Array {
  const out = new Float32Array(size * size);
  const rnd = mulberry32(seed);
  let amp = 1;
  let norm = 0;
  for (const period of periods) {
    const lat = new Float32Array(period * period);
    for (let k = 0; k < lat.length; k++) lat[k] = rnd() * 2 - 1;
    const cell = size / period;
    for (let y = 0; y < size; y++) {
      const gy = y / cell;
      const iy = Math.floor(gy);
      let fy = gy - iy;
      fy = fy * fy * (3 - 2 * fy);
      const y0 = iy % period;
      const y1 = (iy + 1) % period;
      for (let x = 0; x < size; x++) {
        const gx = x / cell;
        const ix = Math.floor(gx);
        let fx = gx - ix;
        fx = fx * fx * (3 - 2 * fx);
        const x0 = ix % period;
        const x1 = (ix + 1) % period;
        const a = lat[y0 * period + x0];
        const b = lat[y0 * period + x1];
        const c = lat[y1 * period + x0];
        const d = lat[y1 * period + x1];
        out[y * size + x] += amp * (a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy);
      }
    }
    norm += amp;
    amp *= 0.6;
  }
  for (let k = 0; k < out.length; k++) out[k] /= norm;
  return out;
}

/** Tileable grey detail noise centred around ~0.9 brightness (grainy, no visible swirls). */
export function makeDetailTexture(size = 256): Texture {
  const [c, ctx] = canvas(size, size);
  const img = ctx.createImageData(size, size);
  const n = tileValueNoise(size, [4, 8, 16, 32, 64, 128], 99);
  const rnd = mulberry32(5);
  for (let k = 0; k < size * size; k++) {
    const v = 0.9 + n[k] * 0.28 + (rnd() - 0.5) * 0.06;
    const g = Math.round(255 * Math.min(1, Math.max(0, v)));
    img.data[k * 4] = g;
    img.data[k * 4 + 1] = g;
    img.data[k * 4 + 2] = g;
    img.data[k * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return finish(c);
}

/** Asphalt with subtle aggregate noise and tyre marks. */
export function makeAsphaltTexture(size = 256): Texture {
  const [c, ctx] = canvas(size, size);
  const rnd = mulberry32(7);
  ctx.fillStyle = '#7b7d82';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < size * size * 0.5; i++) {
    const v = 90 + rnd() * 60;
    ctx.fillStyle = `rgba(${v},${v},${v + 4},${0.25 + rnd() * 0.35})`;
    ctx.fillRect(rnd() * size, rnd() * size, 1 + rnd(), 1 + rnd());
  }
  return finish(c);
}

/** Soft cloud puff with alpha. */
export function makeCloudTexture(size = 128): Texture {
  const [c, ctx] = canvas(size, size);
  const img = ctx.createImageData(size, size);
  const n = new Simplex2(5);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x / size - 0.5) * 2;
      const dy = (y / size - 0.5) * 2;
      const r = Math.sqrt(dx * dx + dy * dy);
      const fall = Math.max(0, 1 - r);
      const nz = n.fbm(x / 22, y / 22, 4) * 0.5 + 0.5;
      const a = Math.max(0, Math.min(1, fall * fall * (0.55 + nz * 0.9) * 1.25 - 0.08));
      const i = (y * size + x) * 4;
      // Lighter at the top, darker at the bottom (self-shadowing look).
      const shade = 0.82 + 0.18 * (1 - y / size) + (nz - 0.5) * 0.12;
      const v = Math.round(255 * Math.min(1, shade));
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = finish(c, false, true);
  return t;
}

/** Radial glow for point lights. */
export function makeGlowTexture(size = 64): Texture {
  const [c, ctx] = canvas(size, size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.2, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.25)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return finish(c, false, false);
}

/** Smoke particle sprite. */
export function makeSmokeTexture(size = 64): Texture {
  const [c, ctx] = canvas(size, size);
  const img = ctx.createImageData(size, size);
  const n = new Simplex2(11);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x / size - 0.5) * 2;
      const dy = (y / size - 0.5) * 2;
      const r = Math.sqrt(dx * dx + dy * dy);
      const nz = n.fbm(x / 10, y / 10, 3) * 0.5 + 0.5;
      const a = Math.max(0, 1 - r) ** 1.5 * (0.6 + 0.6 * nz);
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(Math.min(1, a) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return finish(c, false, false);
}

/**
 * Runway end markings: piano keys, designator, touchdown-zone bars and aiming point.
 * Texture covers the full runway width and `lengthM` metres from the threshold.
 */
export function makeRunwayEndTexture(ident: string, widthM: number, lengthM: number): Texture {
  const pxPerM = 2048 / 360;
  const w = 256;
  const sx = w / widthM;
  const h = Math.min(2048, Math.round(lengthM * pxPerM));
  const sy = h / lengthM;
  const [c, ctx] = canvas(w, h);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#f2f2ee';
  // y = 0 is the threshold; markings drawn going "down" the texture = along the landing direction.
  // Threshold bar.
  ctx.fillRect(0, 1 * sy, w, 1.2 * sy);
  // Piano keys.
  const keys = widthM >= 40 ? 12 : widthM >= 30 ? 8 : 6;
  const keyW = 1.8;
  const total = keys * keyW + (keys - 2) * keyW * 0.9 + 6;
  let x = (widthM - total) / 2;
  for (let k = 0; k < keys; k++) {
    if (k === keys / 2) x += 6;
    ctx.fillRect(x * sx, 6 * sy, keyW * sx, 30 * sy);
    x += keyW + keyW * 0.9;
  }
  // Designator: the top of the digits points down the runway (readable on approach),
  // which in texture space means drawing them rotated by 180°.
  ctx.save();
  ctx.font = `bold ${Math.round(14 * sy)}px "Arial Narrow", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.translate(w / 2, (48 + 12.5) * sy);
  ctx.rotate(Math.PI);
  ctx.scale(Math.min(1.4, (widthM / 45) * 1.3), 1.8);
  ctx.fillText(ident, 0, 0);
  ctx.restore();
  // Touchdown zone bars (pairs) at 150, 300(aim), 450 ... metres.
  const bar = (dist: number, count: number, len = 22) => {
    if ((dist + len) * sy > h) return;
    const bw = 1.8;
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < count; i++) {
        const cx = widthM / 2 + side * (widthM * 0.18 + i * 3.2);
        ctx.fillRect((cx - bw / 2) * sx, dist * sy, bw * sx, len * sy);
      }
    }
  };
  bar(150, 3);
  // Aiming point: two large blocks.
  if (lengthM >= 345) {
    for (let side = -1; side <= 1; side += 2) {
      const cx = widthM / 2 + side * widthM * 0.24;
      ctx.fillRect((cx - 4.5) * sx, 300 * sy, 9 * sx, 45 * sy);
    }
  }
  bar(450, 2);
  bar(600, 2);
  bar(750, 1);
  bar(900, 1);
  // Edge stripes.
  ctx.fillRect(0, 0, 0.9 * sx, h);
  ctx.fillRect(w - 0.9 * sx, 0, 0.9 * sx, h);
  // Centreline dashes start after the designator.
  for (let d = 90; d < lengthM; d += 60) {
    ctx.fillRect((widthM / 2 - 0.45) * sx, d * sy, 0.9 * sx, 30 * sy);
  }
  return finish(c, false, true);
}

/** Repeating centreline+edge pattern for the middle part of a runway (one 60 m period). */
export function makeRunwayMidTexture(widthM: number): Texture {
  const w = 256;
  const h = 256;
  const sx = w / widthM;
  const sy = h / 60;
  const [c, ctx] = canvas(w, h);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#f2f2ee';
  ctx.fillRect((widthM / 2 - 0.45) * sx, 0, 0.9 * sx, 30 * sy);
  ctx.fillRect(0, 0, Math.max(1, 0.9 * sx), h);
  ctx.fillRect(w - Math.max(1, 0.9 * sx), 0, Math.max(1, 0.9 * sx), h);
  const t = finish(c, true, true);
  return t;
}

/** Yellow taxiway centreline (repeating). */
export function makeTaxiLineTexture(): Texture {
  const [c, ctx] = canvas(64, 64);
  ctx.clearRect(0, 0, 64, 64);
  ctx.fillStyle = '#e8c02a';
  ctx.fillRect(29, 0, 6, 64);
  return finish(c, true, true);
}

/** Simple text label texture (for signs, hangars). */
export function makeTextTexture(text: string, opts: { fg?: string; bg?: string; w?: number; h?: number; font?: string } = {}): Texture {
  const w = opts.w ?? 512;
  const h = opts.h ?? 128;
  const [c, ctx] = canvas(w, h);
  ctx.fillStyle = opts.bg ?? '#1b1b1b';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = opts.fg ?? '#f2c230';
  ctx.font = opts.font ?? `bold ${Math.round(h * 0.6)}px Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2 + h * 0.04);
  return finish(c, false, true);
}

/** Stripe texture for the windsock. */
export function makeWindsockTexture(): Texture {
  const [c, ctx] = canvas(128, 32);
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#ff5a1f' : '#f4f4f4';
    ctx.fillRect((i * 128) / 5, 0, 128 / 5 + 1, 32);
  }
  return finish(c, false, true);
}
