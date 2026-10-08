/**
 * Airport scenery: runways with markings, taxiways, aprons, buildings, runway/approach
 * lighting (with a sequenced "rabbit"), PAPI glide-path indicators and windsocks.
 */
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Points,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
  DoubleSide,
  type Camera,
  type Texture,
} from 'three';
import { taxiwayLayout, type Airport, type WorldMap } from './WorldMap';
import type { Environment } from './Environment';
import {
  makeAsphaltTexture,
  makeGlowTexture,
  makeRunwayEndTexture,
  makeRunwayMidTexture,
  makeTaxiLineTexture,
  makeTextTexture,
  makeWindsockTexture,
} from './textures';
import { DEG } from '../core/math';

const MARK_LEN = 360;

const lightVert = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
attribute vec3 color;
attribute float aSize;
attribute float aFlash;
uniform float uScale;
uniform float uNight;
uniform float uTime;
varying vec3 vColor;
varying float vI;
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  float dist = max(-mvPosition.z, 1.0);
  float px = aSize * uScale / dist;
  gl_PointSize = clamp(px, 1.0 + uNight * 2.0, 48.0);
  vColor = color;
  vI = mix(0.35, 1.0, uNight) * clamp(px / 1.5, mix(0.35, 0.75, uNight), 1.0);
  if (aFlash >= 0.0) {
    float ph = fract(uTime * 0.5 - aFlash);
    vI *= step(ph, 0.06) * 4.0;
    gl_PointSize *= 1.6;
  }
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const lightFrag = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uMap;
varying vec3 vColor;
varying float vI;
void main() {
  #include <logdepthbuf_fragment>
  float a = texture2D(uMap, gl_PointCoord).a * vI;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor * a, a);
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

interface PapiSet {
  base: number;
  positions: Vector3[];
  angles: number[];
}

interface Windsock {
  pivot: Group;
  sock: Mesh;
}

export class AirportScenery {
  readonly group = new Group();
  private lightMat: ShaderMaterial;
  private papiPoints: Points;
  private papis: PapiSet[] = [];
  private windsocks: Windsock[] = [];
  private textures: Texture[] = [];
  private papiColor: BufferAttribute;

  constructor(
    readonly world: WorldMap,
    env: Environment,
  ) {
    this.group.name = 'airports';
    const glow = makeGlowTexture();
    this.textures.push(glow);
    this.lightMat = new ShaderMaterial({
      vertexShader: lightVert,
      fragmentShader: lightFrag,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: true,
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        { uMap: { value: null }, uScale: { value: 500 }, uNight: { value: env.night }, uTime: { value: 0 } },
      ]),
    });
    this.lightMat.uniforms.uMap.value = glow;

    const asphalt = makeAsphaltTexture();
    this.textures.push(asphalt);
    const asphaltMat = new MeshLambertMaterial({ map: asphalt, color: 0xe2e2e2 });
    const taxiMat = new MeshLambertMaterial({ map: asphalt, color: 0xd0d0cc });
    const apronMat = new MeshLambertMaterial({ map: asphalt, color: 0xf0eee6 });
    const taxiLine = makeTaxiLineTexture();
    this.textures.push(taxiLine);
    const taxiLineMat = new MeshLambertMaterial({ map: taxiLine, transparent: true, depthWrite: false });

    const lights = { pos: [] as number[], col: [] as number[], size: [] as number[], flash: [] as number[] };
    const papiPos: number[] = [];

    for (const ap of world.airports) {
      const g = new Group();
      g.name = ap.code;
      const rw = ap.runway;
      const W = rw.width;
      const L = rw.length;
      const y = ap.elevation;
      const tl = taxiwayLayout(rw);
      const side = ap.apronSide;
      const P = (u: number, v: number, h = 0): Vector3 =>
        new Vector3(rw.x + rw.ux * u - rw.uz * v, y + h, rw.z + rw.uz * u + rw.ux * v);

      // Runway surface.
      g.add(this.rect(ap, -L / 2 - 5, L / 2 + 5, -W / 2 - 2, W / 2 + 2, 0.04, asphaltMat, 25, true));
      // Markings: both ends + repeating middle.
      for (let e = 0; e < 2; e++) {
        const end = rw.ends[e];
        const tex = makeRunwayEndTexture(end.ident, W, MARK_LEN);
        this.textures.push(tex);
        const mat = new MeshLambertMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
        g.add(this.markingQuad(ap, e, mat));
      }
      const mid = makeRunwayMidTexture(W);
      this.textures.push(mid);
      const midMat = new MeshLambertMaterial({ map: mid, transparent: true, depthWrite: false });
      const midMesh = this.rect(ap, -L / 2 + MARK_LEN, L / 2 - MARK_LEN, -W / 2, W / 2, 0.07, midMat, 0, false);
      // UVs: u across width, v repeats every 60 m.
      const uv = midMesh.geometry.getAttribute('uv') as BufferAttribute;
      const midLen = L - 2 * MARK_LEN;
      uv.setXY(0, 0, 0);
      uv.setXY(1, 1, 0);
      uv.setXY(2, 0, midLen / 60);
      uv.setXY(3, 1, midLen / 60);
      g.add(midMesh);

      // Taxiway, connectors, apron.
      const tv0 = side * (tl.offset - tl.width / 2);
      const tv1 = side * (tl.offset + tl.width / 2);
      g.add(this.rect(ap, -L / 2, L / 2, Math.min(tv0, tv1), Math.max(tv0, tv1), 0.035, taxiMat, 25, true));
      const lineMesh = this.rect(ap, -L / 2, L / 2, side * tl.offset - 0.4, side * tl.offset + 0.4, 0.06, taxiLineMat, 0, false);
      const luv = lineMesh.geometry.getAttribute('uv') as BufferAttribute;
      luv.setXY(0, 0, 0);
      luv.setXY(1, 1, 0);
      luv.setXY(2, 0, L / 8);
      luv.setXY(3, 1, L / 8);
      g.add(lineMesh);
      for (const cu of [-L / 2 + 15, 0, L / 2 - 15, tl.apronU]) {
        const a = side * (W / 2);
        const b = side * tl.offset;
        g.add(this.rect(ap, cu - 11, cu + 11, Math.min(a, b), Math.max(a, b), 0.03, taxiMat, 25, true));
      }
      const av0 = side * tl.offset;
      const av1 = side * (tl.offset + tl.apronDepth);
      g.add(this.rect(ap, tl.apronU - tl.apronLength / 2, tl.apronU + tl.apronLength / 2, Math.min(av0, av1), Math.max(av0, av1), 0.032, apronMat, 25, true));

      // Buildings.
      this.buildings(ap, g, P, tl);

      // Runway edge lights every 60 m, threshold (green) and end (red) bars.
      for (let u = -L / 2; u <= L / 2 + 0.1; u += 60) {
        for (const s of [-1, 1]) {
          const p = P(u, s * (W / 2 + 1.5), 0.4);
          lights.pos.push(p.x, p.y, p.z);
          lights.col.push(1, 0.92, 0.7);
          lights.size.push(1.1);
          lights.flash.push(-1);
        }
      }
      for (const s of [-1, 1]) {
        for (let v = -W / 2 - 4; v <= W / 2 + 4.01; v += 3) {
          const pg = P(s * (L / 2 + 2), v, 0.4);
          lights.pos.push(pg.x, pg.y, pg.z);
          lights.col.push(0.2, 1, 0.35);
          lights.size.push(1.2);
          lights.flash.push(-1);
          const pr = P(s * (L / 2 - 1), v, 0.4);
          lights.pos.push(pr.x, pr.y, pr.z);
          lights.col.push(1, 0.15, 0.1);
          lights.size.push(0.9);
          lights.flash.push(-1);
        }
      }
      // Taxiway edge lights (blue).
      for (let u = -L / 2; u <= L / 2; u += 50) {
        for (const s of [-1, 1]) {
          const p = P(u, side * tl.offset + s * (tl.width / 2 + 1), 0.3);
          lights.pos.push(p.x, p.y, p.z);
          lights.col.push(0.2, 0.35, 1);
          lights.size.push(0.7);
          lights.flash.push(-1);
        }
      }
      // Approach lights for the larger airports.
      if (L >= 1700) {
        for (let e = 0; e < 2; e++) {
          const dir = e === 0 ? -1 : 1;
          const th = dir * (L / 2);
          const count = 24;
          for (let k = 1; k <= count; k++) {
            const u = th + dir * k * 30;
            for (let x = -2; x <= 2; x++) {
              const p = P(u, x * 1.2, 0.8);
              lights.pos.push(p.x, p.y, p.z);
              lights.col.push(1, 0.95, 0.85);
              lights.size.push(1.2);
              lights.flash.push(-1);
            }
            // Sequenced flasher ("rabbit") toward the runway.
            const pf = P(u, 0, 1.5);
            lights.pos.push(pf.x, pf.y, pf.z);
            lights.col.push(1, 1, 1);
            lights.size.push(2.2);
            lights.flash.push(1 - k / count);
            if (k === 10) {
              for (let x = -7; x <= 7; x++) {
                if (Math.abs(x) < 3) continue;
                const pc = P(u, x * 2, 0.8);
                lights.pos.push(pc.x, pc.y, pc.z);
                lights.col.push(1, 0.95, 0.85);
                lights.size.push(1.2);
                lights.flash.push(-1);
              }
            }
          }
        }
      }
      // PAPI on the left of each touchdown zone.
      for (let e = 0; e < 2; e++) {
        const end = rw.ends[e];
        const along = e === 0 ? 1 : -1; // landing direction in u
        const thU = e === 0 ? -L / 2 : L / 2;
        const u = thU + along * 300;
        // Pilot's left is -v when landing toward +u, +v when landing toward -u.
        const leftSign = e === 0 ? -1 : 1;
        const set: PapiSet = { base: papiPos.length / 3, positions: [], angles: [] };
        for (let k = 0; k < 4; k++) {
          const v = leftSign * (W / 2 + 15 + k * 9);
          const p = P(u, v, 1.0);
          papiPos.push(p.x, p.y, p.z);
          set.positions.push(p);
          set.angles.push((3.5 - k * 0.33) * DEG);
        }
        void end;
        this.papis.push(set);
      }

      // Windsock near the apron side of the runway's first third.
      this.windsocks.push(this.makeWindsock(g, P(-L / 2 + 250, side * (W / 2 + 45))));
      this.group.add(g);
    }

    const lg = new BufferGeometry();
    lg.setAttribute('position', new BufferAttribute(new Float32Array(lights.pos), 3));
    lg.setAttribute('color', new BufferAttribute(new Float32Array(lights.col), 3));
    lg.setAttribute('aSize', new BufferAttribute(new Float32Array(lights.size), 1));
    lg.setAttribute('aFlash', new BufferAttribute(new Float32Array(lights.flash), 1));
    const lp = new Points(lg, this.lightMat);
    lp.frustumCulled = false;
    lp.renderOrder = 20;
    lp.name = 'runway-lights';
    this.group.add(lp);

    const pg = new BufferGeometry();
    pg.setAttribute('position', new BufferAttribute(new Float32Array(papiPos), 3));
    this.papiColor = new BufferAttribute(new Float32Array(papiPos.length), 3);
    pg.setAttribute('color', this.papiColor);
    pg.setAttribute('aSize', new BufferAttribute(new Float32Array(papiPos.length / 3).fill(2.2), 1));
    pg.setAttribute('aFlash', new BufferAttribute(new Float32Array(papiPos.length / 3).fill(-1), 1));
    this.papiPoints = new Points(pg, this.lightMat);
    this.papiPoints.frustumCulled = false;
    this.papiPoints.renderOrder = 21;
    this.papiPoints.name = 'papi';
    this.group.add(this.papiPoints);
  }

  /** Flat rectangle in runway-local (u along, v across) coordinates. */
  private rect(ap: Airport, u0: number, u1: number, v0: number, v1: number, h: number, mat: MeshLambertMaterial, uvScale: number, shadow: boolean): Mesh {
    const rw = ap.runway;
    const y = ap.elevation + h;
    const pt = (u: number, v: number) => [rw.x + rw.ux * u - rw.uz * v, y, rw.z + rw.uz * u + rw.ux * v];
    const pos = new Float32Array([...pt(u0, v0), ...pt(u0, v1), ...pt(u1, v0), ...pt(u1, v1)]);
    const s = uvScale || 1;
    const uv = new Float32Array([v0 / s, u0 / s, v1 / s, u0 / s, v0 / s, u1 / s, v1 / s, u1 / s]);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('uv', new BufferAttribute(uv, 2));
    geo.setAttribute('normal', new BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
    // Winding chosen so the face points up for either sign of the perpendicular.
    const up = (u1 - u0) * (v1 - v0) > 0;
    geo.setIndex(up ? [0, 1, 2, 2, 1, 3] : [0, 2, 1, 2, 3, 1]);
    const m = new Mesh(geo, mat);
    m.receiveShadow = shadow;
    return m;
  }

  /** Marking quad for runway end `e` covering MARK_LEN metres from its threshold. */
  private markingQuad(ap: Airport, e: number, mat: MeshLambertMaterial): Mesh {
    const rw = ap.runway;
    const L = rw.length;
    const W = rw.width;
    const y = ap.elevation + 0.08;
    const dir = e === 0 ? 1 : -1; // landing direction along u
    const th = e === 0 ? -L / 2 : L / 2;
    const pt = (u: number, v: number) => [rw.x + rw.ux * u - rw.uz * v, y, rw.z + rw.uz * u + rw.ux * v];
    // Pilot's left/right: for e=0 right = +v; for e=1 right = -v.
    const left = -dir * (W / 2);
    const right = dir * (W / 2);
    const far = th + dir * MARK_LEN;
    const pos = new Float32Array([...pt(th, left), ...pt(th, right), ...pt(far, left), ...pt(far, right)]);
    const uv = new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('uv', new BufferAttribute(uv, 2));
    geo.setAttribute('normal', new BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
    geo.setIndex([0, 2, 1, 1, 2, 3]);
    // Ensure upward winding: compute the normal and flip if needed.
    const a = new Vector3(pos[0], pos[1], pos[2]);
    const b = new Vector3(pos[6], pos[7], pos[8]);
    const c = new Vector3(pos[3], pos[4], pos[5]);
    const n = b.clone().sub(a).cross(c.clone().sub(a));
    if (n.y < 0) geo.setIndex([0, 1, 2, 1, 3, 2]);
    const m = new Mesh(geo, mat);
    m.renderOrder = 2;
    return m;
  }

  private buildings(ap: Airport, g: Group, P: (u: number, v: number, h?: number) => Vector3, tl: ReturnType<typeof taxiwayLayout>): void {
    const rw = ap.runway;
    const side = ap.apronSide;
    const W = rw.width;
    const yaw = Math.atan2(rw.ux, rw.uz);
    const big = rw.length >= 1700;
    const wall = new MeshLambertMaterial({ color: 0xd8d4c8 });
    const glass = new MeshStandardMaterial({ color: 0x2a4258, metalness: 0.6, roughness: 0.2 });
    const roof = new MeshLambertMaterial({ color: 0x7c8187 });
    const hangarMat = new MeshLambertMaterial({ color: 0xa9b2b8, side: DoubleSide });
    const addBox = (u: number, v: number, w: number, d: number, h: number, mat: MeshLambertMaterial | MeshStandardMaterial) => {
      const m = new Mesh(new BoxGeometry(w, h, d), mat);
      const p = P(u, v, h / 2);
      m.position.copy(p);
      m.rotation.y = yaw;
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
      const cs = Math.abs(Math.cos(yaw));
      const sn = Math.abs(Math.sin(yaw));
      const hx = (w / 2) * cs + (d / 2) * sn;
      const hz = (w / 2) * sn + (d / 2) * cs;
      this.world.obstacles.add({ x: p.x, z: p.z, hx, hz, y0: ap.elevation - 1, y1: ap.elevation + h, kind: 'building' });
      return m;
    };
    const vBack = side * (W / 2 + 212);
    // Terminal.
    const termLen = big ? tl.apronLength * 0.7 : tl.apronLength * 0.45;
    // Box local axes: x across (w), z along runway (d) because rotation aligns +z with the runway.
    addBox(tl.apronU, vBack, 30, termLen, big ? 16 : 9, wall);
    addBox(tl.apronU, vBack - side * 15.5, 1, termLen * 0.96, big ? 6 : 3.5, glass).position.y = ap.elevation + (big ? 9 : 5);
    const sign = makeTextTexture(ap.name.toUpperCase(), { w: 1024, h: 96, bg: '#1d2a3a', fg: '#ffffff' });
    this.textures.push(sign);
    const signMesh = new Mesh(new BoxGeometry(0.4, 3, Math.min(termLen * 0.6, 60)), new MeshLambertMaterial({ map: sign }));
    signMesh.position.copy(P(tl.apronU, vBack - side * 15.3, (big ? 16 : 9) + 2));
    signMesh.rotation.y = yaw + (side > 0 ? 0 : Math.PI);
    g.add(signMesh);
    // Control tower.
    const tu = tl.apronU + tl.apronLength / 2 + 45;
    const towerH = big ? 34 : 18;
    const shaft = new Mesh(new CylinderGeometry(3, 4, towerH, 12), wall);
    shaft.position.copy(P(tu, vBack, towerH / 2));
    shaft.castShadow = true;
    g.add(shaft);
    const cab = new Mesh(new CylinderGeometry(6.5, 5.5, 5, 8), glass);
    cab.position.copy(P(tu, vBack, towerH + 2.5));
    g.add(cab);
    const cap = new Mesh(new CylinderGeometry(7.2, 7.2, 1, 8), roof);
    cap.position.copy(P(tu, vBack, towerH + 5.5));
    g.add(cap);
    const beacon = P(tu, vBack, towerH + 9);
    const mast = new Mesh(new CylinderGeometry(0.15, 0.15, 3, 4), roof);
    mast.position.copy(P(tu, vBack, towerH + 7.5));
    g.add(mast);
    void beacon;
    this.world.obstacles.add({ x: shaft.position.x, z: shaft.position.z, hx: 7, hz: 7, y0: ap.elevation, y1: ap.elevation + towerH + 9, kind: 'building' });
    // Hangars with curved roofs.
    const hangars = big ? 3 : 2;
    for (let k = 0; k < hangars; k++) {
      const hu = tl.apronU - tl.apronLength / 2 - 45 - k * 62;
      const hw = 46;
      const hd = 50;
      const h = 9;
      addBox(hu, vBack + side * 2, hd, hw, h, hangarMat);
      const arc = new Mesh(new CylinderGeometry(hw / 2, hw / 2, hd, 18, 1, false, 0, Math.PI), hangarMat);
      arc.scale.set(0.35, 1, 1);
      arc.rotation.set(0, yaw, Math.PI / 2, 'YXZ');
      arc.position.copy(P(hu, vBack + side * 2, h));
      arc.castShadow = true;
      g.add(arc);
    }
    // Fuel tanks.
    for (let k = 0; k < 2; k++) {
      const tank = new Mesh(new CylinderGeometry(6, 6, 9, 16), new MeshLambertMaterial({ color: 0xe8e8e2 }));
      const p = P(tu + 40 + k * 16, vBack + side * 6, 4.5);
      tank.position.copy(p);
      tank.castShadow = true;
      g.add(tank);
      this.world.obstacles.add({ x: p.x, z: p.z, hx: 6, hz: 6, y0: ap.elevation, y1: ap.elevation + 9, kind: 'building' });
    }
  }

  private makeWindsock(g: Group, base: Vector3): Windsock {
    const poleMat = new MeshLambertMaterial({ color: 0xdddddd });
    const pole = new Mesh(new CylinderGeometry(0.12, 0.15, 8, 6), poleMat);
    pole.position.copy(base).add(new Vector3(0, 4, 0));
    g.add(pole);
    const pivot = new Group();
    pivot.position.copy(base).add(new Vector3(0, 7.8, 0));
    const tex = makeWindsockTexture();
    this.textures.push(tex);
    const sockGeo = new ConeGeometry(0.55, 4, 12, 1, true);
    sockGeo.rotateX(Math.PI / 2);
    sockGeo.translate(0, 0, 2);
    const sock = new Mesh(sockGeo, new MeshLambertMaterial({ map: tex, side: DoubleSide }));
    pivot.add(sock);
    g.add(pivot);
    return { pivot, sock };
  }

  update(camera: Camera, env: Environment, time: number, viewportHeight: number, fovDeg: number): void {
    const u = this.lightMat.uniforms;
    u.uTime.value = time;
    u.uNight.value = Math.max(env.night, env.coverage > 0.8 ? 0.45 : 0);
    u.uScale.value = viewportHeight / (2 * Math.tan((fovDeg * DEG) / 2));
    // PAPI colours from the camera position.
    const cp = camera.position;
    const col = this.papiColor;
    for (const set of this.papis) {
      for (let k = 0; k < 4; k++) {
        const p = set.positions[k];
        const ang = Math.atan2(cp.y - p.y, Math.hypot(cp.x - p.x, cp.z - p.z));
        const white = ang > set.angles[k];
        const i = set.base + k;
        if (white) col.setXYZ(i, 1, 1, 1);
        else col.setXYZ(i, 1, 0.08, 0.05);
      }
    }
    col.needsUpdate = true;
    // Windsocks point downwind; droop when calm.
    const w = env.windSpeed;
    const yaw = Math.atan2(env.wind.x, env.wind.z);
    const flutter = Math.sin(time * 7) * 0.05 * Math.min(1, w / 5);
    for (const s of this.windsocks) {
      s.pivot.rotation.set(0, yaw + flutter, 0);
      s.sock.rotation.x = (1 - Math.min(1, w / 12)) * 1.2;
    }
  }

  /** Brightness of everything lit at night is handled by the light shader; nothing else to do. */
  dispose(): void {
    this.textures.forEach((t) => t.dispose());
    this.lightMat.dispose();
  }
}

