/** Billboarded cumulus clusters drawn as one instanced mesh, drifting with the wind. */
import {
  Color,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
  type Camera,
  type Texture,
} from 'three';
import type { Environment } from './Environment';
import { makeCloudTexture } from './textures';
import { mulberry32 } from '../core/math';

const DOMAIN = 70000;

const vert = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
attribute vec3 aOffset;
attribute vec3 aParams; // size, rotation, shade
uniform vec3 uDrift;
uniform float uDomain;
varying vec2 vUv;
varying float vShade;
varying float vFade;
void main() {
  vec3 center = aOffset + uDrift;
  center.xz = mod(center.xz - cameraPosition.xz + uDomain * 0.5, uDomain) - uDomain * 0.5 + cameraPosition.xz;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float c = cos(aParams.y);
  float s = sin(aParams.y);
  vec2 q = vec2(c * position.x - s * position.y, s * position.x + c * position.y) * aParams.x;
  vec3 world = center + right * q.x + up * q.y;
  vec4 mvPosition = viewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vUv = uv;
  vShade = aParams.z;
  float d = distance(center, cameraPosition);
  vFade = smoothstep(aParams.x * 0.25, aParams.x * 0.9, d);
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const frag = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uMap;
uniform vec3 uColor;
uniform vec3 uShadow;
uniform float uOpacity;
varying vec2 vUv;
varying float vShade;
varying float vFade;
void main() {
  #include <logdepthbuf_fragment>
  vec4 t = texture2D(uMap, vUv);
  float a = t.a * uOpacity * vFade;
  if (a < 0.01) discard;
  vec3 col = mix(uShadow, uColor, clamp(vShade * t.r, 0.0, 1.0));
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

interface Puff {
  x: number;
  y: number;
  z: number;
  r: number;
}

export class Clouds {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  private geometry: InstancedBufferGeometry;
  private texture: Texture;
  private puffs: Puff[] = [];
  private drift = new Vector3();

  constructor(env: Environment, density = 1) {
    this.texture = makeCloudTexture();
    this.geometry = new InstancedBufferGeometry();
    const base = new PlaneGeometry(1, 1);
    this.geometry.index = base.index;
    this.geometry.setAttribute('position', base.getAttribute('position'));
    this.geometry.setAttribute('uv', base.getAttribute('uv'));
    this.material = new ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      fog: true,
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        {
          uMap: { value: null },
          uColor: { value: new Color() },
          uShadow: { value: new Color() },
          uOpacity: { value: 0.9 },
          uDrift: { value: new Vector3() },
          uDomain: { value: DOMAIN },
        },
      ]),
    });
    this.material.uniforms.uMap.value = this.texture;
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.name = 'clouds';
    this.build(env, density);
  }

  build(env: Environment, density = 1): void {
    const rnd = mulberry32(31337 + Math.round(env.coverage * 100));
    const clusters = Math.round((20 + env.coverage * 330) * density);
    const offsets: number[] = [];
    const params: number[] = [];
    this.puffs = [];
    for (let c = 0; c < clusters; c++) {
      const cx = (rnd() - 0.5) * DOMAIN;
      const cz = (rnd() - 0.5) * DOMAIN;
      const base = env.cloudBase + (rnd() - 0.3) * env.cloudThickness * 0.4;
      const width = 350 + rnd() * 900 * (0.6 + env.coverage);
      const height = env.cloudThickness * (0.45 + rnd() * 0.6);
      const n = 6 + Math.floor(rnd() * 12 * (0.5 + env.coverage));
      for (let k = 0; k < n; k++) {
        const ang = rnd() * Math.PI * 2;
        const rad = Math.sqrt(rnd()) * width * 0.5;
        const h = rnd();
        const x = cx + Math.cos(ang) * rad;
        const z = cz + Math.sin(ang) * rad * 0.7;
        const y = base + h * h * height;
        const size = (180 + rnd() * 260) * (0.75 + (1 - rad / (width * 0.5 + 1)) * 0.5) * (env.coverage > 0.8 ? 1.4 : 1);
        offsets.push(x, y, z);
        params.push(size, rnd() * Math.PI * 2, 0.55 + h * 0.6);
        this.puffs.push({ x, y, z, r: size * 0.42 });
      }
    }
    this.geometry.setAttribute('aOffset', new InstancedBufferAttribute(new Float32Array(offsets), 3));
    this.geometry.setAttribute('aParams', new InstancedBufferAttribute(new Float32Array(params), 3));
    this.geometry.instanceCount = this.puffs.length;
    const u = this.material.uniforms;
    u.uColor.value.copy(env.cloudColor);
    u.uShadow.value.copy(env.cloudColor).multiplyScalar(env.coverage > 0.8 ? 0.45 : 0.62);
    u.uOpacity.value = env.coverage > 0.8 ? 0.95 : 0.88;
  }

  update(camera: Camera, env: Environment, dt: number): void {
    this.drift.addScaledVector(env.wind, dt);
    this.drift.x = ((this.drift.x % DOMAIN) + DOMAIN) % DOMAIN;
    this.drift.z = ((this.drift.z % DOMAIN) + DOMAIN) % DOMAIN;
    this.material.uniforms.uDrift.value.copy(this.drift);
    void camera;
  }

  /** 0..1 cloud density at a world position (for in-cloud white-out and turbulence). */
  densityAt(p: Vector3): number {
    let best = 0;
    for (const c of this.puffs) {
      let dx = c.x + this.drift.x - p.x;
      let dz = c.z + this.drift.z - p.z;
      dx = ((dx + DOMAIN / 2) % DOMAIN + DOMAIN) % DOMAIN - DOMAIN / 2;
      dz = ((dz + DOMAIN / 2) % DOMAIN + DOMAIN) % DOMAIN - DOMAIN / 2;
      const dy = c.y - p.y;
      const d2 = dx * dx + dy * dy * 2.2 + dz * dz;
      if (d2 < c.r * c.r) best = Math.max(best, 1 - Math.sqrt(d2) / c.r);
    }
    return best;
  }

  get count(): number {
    return this.puffs.length;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
