/**
 * Procedural geometry builders for aircraft: lofted fuselages and airfoil surfaces.
 * Body frame: +X right, +Y up, -Z forward (nose toward -Z).
 */
import { BufferAttribute, BufferGeometry, Vector3 } from 'three';

export interface Section {
  /** Station along the body (m, -Z forward). */
  z: number;
  /** Half width and half height (m). */
  w: number;
  h: number;
  /** Vertical centre offset. */
  y: number;
  /** Superellipse exponent: 2 = ellipse, larger = boxier. */
  e?: number;
}

/** Loft a closed body through elliptical/superelliptical sections. */
export function loft(sections: Section[], radial = 22, capStart = true, capEnd = true): BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const zMin = sections[0].z;
  const zMax = sections[sections.length - 1].z;
  const ring = radial + 1;
  sections.forEach((s, si) => {
    const e = s.e ?? 2;
    for (let k = 0; k <= radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const px = Math.sign(c) * Math.pow(Math.abs(c), 2 / e) * s.w;
      const py = Math.sign(sn) * Math.pow(Math.abs(sn), 2 / e) * s.h;
      pos.push(px, s.y + py, s.z);
      uv.push(k / radial, (s.z - zMin) / (zMax - zMin || 1));
    }
    if (si > 0) {
      const b0 = (si - 1) * ring;
      const b1 = si * ring;
      for (let k = 0; k < radial; k++) {
        // Outward-facing winding (sections advance toward +Z).
        idx.push(b0 + k, b0 + k + 1, b1 + k);
        idx.push(b0 + k + 1, b1 + k + 1, b1 + k);
      }
    }
  });
  const cap = (si: number, reverse: boolean) => {
    const s = sections[si];
    if (s.w < 1e-4 && s.h < 1e-4) return;
    const center = pos.length / 3;
    pos.push(0, s.y, s.z);
    uv.push(0.5, si === 0 ? 0 : 1);
    const start = pos.length / 3;
    const e = s.e ?? 2;
    for (let k = 0; k <= radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      pos.push(Math.sign(c) * Math.pow(Math.abs(c), 2 / e) * s.w, s.y + Math.sign(sn) * Math.pow(Math.abs(sn), 2 / e) * s.h, s.z);
      uv.push(0.5 + c * 0.5, 0.5 + sn * 0.5);
    }
    for (let k = 0; k < radial; k++) {
      if (reverse) idx.push(center, start + k + 1, start + k);
      else idx.push(center, start + k, start + k + 1);
    }
  };
  if (capStart) cap(0, true);
  if (capEnd) cap(sections.length - 1, false);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export interface SurfaceDef {
  /** Root leading-edge position. */
  root: [number, number, number];
  rootChord: number;
  tipChord: number;
  /** Semi-span (m) along the span direction. */
  span: number;
  /** Leading-edge set-back at the tip (m, +Z = aft). */
  sweep: number;
  /** Dihedral (deg) for horizontal surfaces. */
  dihedral?: number;
  /** Thickness ratio. */
  thickness?: number;
  /** 'right' | 'left' horizontal surface, or 'vertical' fin. */
  kind: 'right' | 'left' | 'vertical';
  /** Portion of the chord / span to build (fractions). */
  chord?: [number, number];
  spanRange?: [number, number];
}

function naca(xc: number, t: number): number {
  return 5 * t * (0.2969 * Math.sqrt(xc) - 0.126 * xc - 0.3516 * xc * xc + 0.2843 * xc ** 3 - 0.1036 * xc ** 4);
}

/** Frame vectors for a surface. */
export function surfaceFrame(d: SurfaceDef): { span: Vector3; thick: Vector3; chord: Vector3 } {
  const dih = ((d.dihedral ?? 0) * Math.PI) / 180;
  const chord = new Vector3(0, 0, 1);
  if (d.kind === 'vertical') return { span: new Vector3(0, 1, 0), thick: new Vector3(-1, 0, 0), chord };
  const sx = d.kind === 'right' ? 1 : -1;
  const span = new Vector3(sx * Math.cos(dih), Math.sin(dih), 0);
  const thick = new Vector3(-sx * Math.sin(dih), Math.cos(dih), 0);
  return { span, thick, chord };
}

/** Point on the surface at span fraction f, chord fraction xc, signed thickness fraction (0 = mean line). */
export function surfacePoint(d: SurfaceDef, f: number, xc: number, th = 0): Vector3 {
  const { span, thick, chord } = surfaceFrame(d);
  const c = d.rootChord + (d.tipChord - d.rootChord) * f;
  const le = d.sweep * f;
  return new Vector3(...d.root)
    .addScaledVector(span, d.span * f)
    .addScaledVector(chord, le + xc * c)
    .addScaledVector(thick, th * c);
}

/** Build an airfoil surface (wing, tail, fin) or a portion of it (control surface). */
export function surface(d: SurfaceDef, segments = 14): BufferGeometry {
  const t = d.thickness ?? 0.12;
  const [c0, c1] = d.chord ?? [0, 1];
  const [s0, s1] = d.spanRange ?? [0, 1];
  // Profile loop: top TE->LE, bottom LE->TE.
  const xs: number[] = [];
  for (let k = 0; k <= segments; k++) {
    const u = k / segments;
    // Cosine spacing clusters points at the leading edge.
    xs.push(c0 + (c1 - c0) * (0.5 - 0.5 * Math.cos(u * Math.PI)));
  }
  const profile: [number, number][] = [];
  for (let k = xs.length - 1; k >= 0; k--) profile.push([xs[k], Math.max(naca(xs[k], t), 0.002)]);
  for (let k = 0; k < xs.length; k++) profile.push([xs[k], -Math.max(naca(xs[k], t), 0.002)]);
  const n = profile.length;
  const { span, thick, chord } = surfaceFrame(d);
  const flip = new Vector3().crossVectors(span, thick).dot(chord) < 0;
  const pos: number[] = [];
  const idx: number[] = [];
  const stations = [s0, s1];
  for (const f of stations) {
    for (const [xc, y] of profile) {
      const p = surfacePoint(d, f, xc, y);
      pos.push(p.x, p.y, p.z);
    }
  }
  const tri = (a: number, b: number, c: number) => (flip ? idx.push(a, c, b) : idx.push(a, b, c));
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n;
    const a = k;
    const b = k2;
    const c = n + k;
    const dd = n + k2;
    tri(a, c, b);
    tri(b, c, dd);
  }
  // Caps with their own vertices for crisp edges.
  for (let st = 0; st < 2; st++) {
    const f = stations[st];
    const base = pos.length / 3;
    const ctr = surfacePoint(d, f, (c0 + c1) / 2, 0);
    pos.push(ctr.x, ctr.y, ctr.z);
    for (const [xc, y] of profile) {
      const p = surfacePoint(d, f, xc, y);
      pos.push(p.x, p.y, p.z);
    }
    for (let k = 0; k < n; k++) {
      const k2 = (k + 1) % n;
      if (st === 0) tri(base, base + 1 + k2, base + 1 + k);
      else tri(base, base + 1 + k, base + 1 + k2);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
