/**
 * Procedural city of instanced buildings. Windows are generated in the shader from
 * world-space coordinates (constant size regardless of building scale) and glow at night.
 */
import {
  BoxGeometry,
  Color,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
  type Group,
} from 'three';
import type { WorldMap } from './WorldMap';
import { mulberry32, smoothstep } from '../core/math';

const PALETTE = [0xb9b5ac, 0xc9c2b2, 0x8f99a3, 0xa4a8ab, 0xd6cfc0, 0x7f8790, 0xbfae97, 0x9aa6b0, 0xe0d8c8, 0x6f7a86];

export class City {
  readonly mesh: InstancedMesh;
  readonly material: MeshLambertMaterial;
  private uniforms = { uNight: { value: 0 } };
  readonly count: number;

  constructor(world: WorldMap, parent: Group, density = 1) {
    const rnd = mulberry32(4711);
    const city = world.city;
    const block = 150;
    const street = 24;
    type B = { x: number; z: number; w: number; d: number; h: number; base: number; color: number };
    const list: B[] = [];
    const R = city.radius;
    for (let bx = -R; bx < R; bx += block + street) {
      for (let bz = -R; bz < R; bz += block + street) {
        const cx = city.x + bx + block / 2;
        const cz = city.z + bz + block / 2;
        const dist = Math.hypot(cx - city.x, cz - city.z);
        if (dist > R) continue;
        const core = 1 - smoothstep(0, R * 0.35, dist);
        const mid = 1 - smoothstep(R * 0.2, R * 0.75, dist);
        // Subdivide the block into lots.
        const lots = core > 0.3 ? 2 : mid > 0.3 ? 3 : 4;
        const lot = block / lots;
        for (let li = 0; li < lots; li++) {
          for (let lj = 0; lj < lots; lj++) {
            if (rnd() > 0.55 + 0.4 * mid * density) continue;
            const x = cx - block / 2 + lot * (li + 0.5) + (rnd() - 0.5) * lot * 0.15;
            const z = cz - block / 2 + lot * (lj + 0.5) + (rnd() - 0.5) * lot * 0.15;
            const w = lot * (0.55 + rnd() * 0.35);
            const d = lot * (0.55 + rnd() * 0.35);
            let h: number;
            if (core > 0.3) h = 40 + rnd() * rnd() * 190 * core + 20;
            else if (mid > 0.3) h = 14 + rnd() * 45 * mid;
            else h = 6 + rnd() * 9;
            // Terrain checks.
            const hs = [
              world.surfaceHeight(x - w / 2, z - d / 2),
              world.surfaceHeight(x + w / 2, z - d / 2),
              world.surfaceHeight(x - w / 2, z + d / 2),
              world.surfaceHeight(x + w / 2, z + d / 2),
            ];
            const lo = Math.min(...hs);
            const hi = Math.max(...hs);
            if (lo < 2 || hi - lo > 10) continue;
            if (world.airportMask(x, z) > 0.01) continue;
            list.push({ x, z, w, d, h, base: lo - 1.5, color: PALETTE[Math.floor(rnd() * PALETTE.length)] });
          }
        }
      }
    }
    // Lighthouse and a radio mast as landmarks (just tall thin buildings).
    this.count = list.length;

    const geo = new BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    this.material = new MeshLambertMaterial({ color: 0xffffff });
    const uniforms = this.uniforms;
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uNight = uniforms.uNight;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying vec3 vBWorld;\nvarying vec3 vBNormal;\nvarying float vBTop;\nvarying float vBBase;',
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          #ifdef USE_INSTANCING
            mat4 bm = modelMatrix * instanceMatrix;
          #else
            mat4 bm = modelMatrix;
          #endif
          vBWorld = (bm * vec4(transformed, 1.0)).xyz;
          vBNormal = normalize(mat3(bm) * objectNormal);
          vBTop = (bm * vec4(0.0, 1.0, 0.0, 1.0)).y;
          vBBase = (bm * vec4(0.0, 0.0, 0.0, 1.0)).y;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform float uNight;
          varying vec3 vBWorld;
          varying vec3 vBNormal;
          varying float vBTop;
          varying float vBBase;
          float bHash(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          float bWin = 0.0;
          float bLit = 0.0;
          if (abs(vBNormal.y) < 0.5) {
            float along = abs(vBNormal.x) > 0.5 ? vBWorld.z : vBWorld.x;
            vec2 g = vec2(along / 3.4, vBWorld.y / 3.6);
            vec2 f = fract(g);
            bWin = step(0.22, f.x) * step(f.x, 0.78) * step(0.28, f.y) * step(f.y, 0.82);
            bWin *= step(vBBase + 4.0, vBWorld.y) * step(vBWorld.y, vBTop - 1.2);
            float r = bHash(vec3(floor(g), floor((abs(vBNormal.x) > 0.5 ? vBWorld.x : vBWorld.z) / 7.0)));
            bLit = step(0.52, r);
            diffuseColor.rgb *= mix(1.0, 0.42 + 0.2 * r, bWin);
          } else {
            diffuseColor.rgb *= 0.72;
          }`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          totalEmissiveRadiance += vec3(1.0, 0.78, 0.45) * bWin * bLit * uNight * 1.4;`,
        );
    };

    this.mesh = new InstancedMesh(geo, this.material, Math.max(1, list.length));
    const m = new Matrix4();
    const q = new Quaternion();
    const s = new Vector3();
    const p = new Vector3();
    const c = new Color();
    list.forEach((b, k) => {
      const height = b.h + 1.5;
      p.set(b.x, b.base, b.z);
      s.set(b.w, height, b.d);
      m.compose(p, q, s);
      this.mesh.setMatrixAt(k, m);
      this.mesh.setColorAt(k, c.setHex(b.color));
      world.obstacles.add({ x: b.x, z: b.z, hx: b.w / 2, hz: b.d / 2, y0: b.base, y1: b.base + height, kind: 'building' });
    });
    this.mesh.count = list.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.mesh.computeBoundingSphere();
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'city';
    parent.add(this.mesh);
  }

  setNight(night: number): void {
    this.uniforms.uNight.value = night;
  }
}
