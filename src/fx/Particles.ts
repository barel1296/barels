/** CPU-simulated, GPU-drawn particle system (one draw call per system). */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  NormalBlending,
  Points,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
  type Blending,
  type Texture,
} from 'three';

const vert = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uScale;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = clamp(aSize * uScale / max(-mvPosition.z, 0.1), 0.0, 512.0);
  vAlpha = aAlpha;
  vColor = aColor;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const frag = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uMap;
varying float vAlpha;
varying vec3 vColor;
void main() {
  #include <logdepthbuf_fragment>
  vec4 t = texture2D(uMap, gl_PointCoord);
  float a = t.a * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor * t.rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export interface EmitOptions {
  life: number;
  size0: number;
  size1: number;
  alpha: number;
  color: Color | number;
  /** Upward acceleration (buoyancy) m/s². */
  rise?: number;
  /** Velocity damping per second. */
  drag?: number;
  /** Fade-in fraction of life. */
  fadeIn?: number;
}

export class ParticleSystem {
  readonly points: Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private age: Float32Array;
  private life: Float32Array;
  private s0: Float32Array;
  private s1: Float32Array;
  private a0: Float32Array;
  private rise: Float32Array;
  private drag: Float32Array;
  private fadeIn: Float32Array;
  private sizeAttr: BufferAttribute;
  private alphaAttr: BufferAttribute;
  private colorAttr: BufferAttribute;
  private posAttr: BufferAttribute;
  private next = 0;
  private alive = 0;
  readonly material: ShaderMaterial;
  private _c = new Color();

  constructor(
    readonly max: number,
    texture: Texture,
    blending: Blending = NormalBlending,
  ) {
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.age = new Float32Array(max).fill(1e9);
    this.life = new Float32Array(max).fill(1);
    this.s0 = new Float32Array(max);
    this.s1 = new Float32Array(max);
    this.a0 = new Float32Array(max);
    this.rise = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.fadeIn = new Float32Array(max);
    const geo = new BufferGeometry();
    this.posAttr = new BufferAttribute(this.pos, 3);
    this.sizeAttr = new BufferAttribute(new Float32Array(max), 1);
    this.alphaAttr = new BufferAttribute(new Float32Array(max), 1);
    this.colorAttr = new BufferAttribute(new Float32Array(max * 3), 3);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('aSize', this.sizeAttr);
    geo.setAttribute('aAlpha', this.alphaAttr);
    geo.setAttribute('aColor', this.colorAttr);
    this.material = new ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      blending,
      fog: true,
      uniforms: UniformsUtils.merge([UniformsLib.fog, { uMap: { value: null }, uScale: { value: 500 } }]),
    });
    this.material.uniforms.uMap.value = texture;
    this.points = new Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = blending === AdditiveBlending ? 31 : 30;
  }

  emit(p: Vector3, v: Vector3, o: EmitOptions): void {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.pos[i * 3] = p.x;
    this.pos[i * 3 + 1] = p.y;
    this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = v.x;
    this.vel[i * 3 + 1] = v.y;
    this.vel[i * 3 + 2] = v.z;
    this.age[i] = 0;
    this.life[i] = o.life;
    this.s0[i] = o.size0;
    this.s1[i] = o.size1;
    this.a0[i] = o.alpha;
    this.rise[i] = o.rise ?? 0;
    this.drag[i] = o.drag ?? 0.5;
    this.fadeIn[i] = o.fadeIn ?? 0.05;
    const c = typeof o.color === 'number' ? this._c.setHex(o.color) : o.color;
    this.colorAttr.setXYZ(i, c.r, c.g, c.b);
    this.colorAttr.needsUpdate = true;
  }

  update(dt: number, wind: Vector3, viewportHeight: number, fovDeg: number): void {
    this.material.uniforms.uScale.value = viewportHeight / (2 * Math.tan((fovDeg * Math.PI) / 360));
    let alive = 0;
    const sizes = this.sizeAttr.array as Float32Array;
    const alphas = this.alphaAttr.array as Float32Array;
    for (let i = 0; i < this.max; i++) {
      const age = (this.age[i] += dt);
      const life = this.life[i];
      if (age >= life) {
        alphas[i] = 0;
        sizes[i] = 0;
        continue;
      }
      alive++;
      const t = age / life;
      const dr = Math.exp(-this.drag[i] * dt);
      const k = i * 3;
      // Relax toward the wind velocity.
      this.vel[k] = wind.x + (this.vel[k] - wind.x) * dr;
      this.vel[k + 1] = (this.vel[k + 1] + this.rise[i] * dt) * dr;
      this.vel[k + 2] = wind.z + (this.vel[k + 2] - wind.z) * dr;
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      sizes[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * Math.sqrt(t);
      const fin = this.fadeIn[i] > 0 ? Math.min(1, t / this.fadeIn[i]) : 1;
      alphas[i] = this.a0[i] * fin * (1 - t) * (1 - t);
    }
    this.alive = alive;
    this.posAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
  }

  clear(): void {
    this.age.fill(1e9);
    (this.alphaAttr.array as Float32Array).fill(0);
    this.alphaAttr.needsUpdate = true;
  }

  get count(): number {
    return this.alive;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

export { AdditiveBlending, NormalBlending };
