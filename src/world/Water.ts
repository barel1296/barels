/** Ocean surface: animated wave normals, fresnel sky reflection, sun glint, depth tint and shore foam. */
import {
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  LinearFilter,
  Mesh,
  PlaneGeometry,
  RGBAFormat,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
  type Camera,
} from 'three';
import type { Environment } from './Environment';
import { WORLD_HALF } from './WorldMap';

const vert = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const frag = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform float uTime;
uniform float uRough;
uniform sampler2D uDepth;
uniform float uHalf;
uniform float uAmbient;
varying vec3 vWorld;

// Fade a wave once its wavelength approaches the pixel footprint (prevents moiré).
float aa(float f, float dist) {
  return clamp(1.0 - (f * dist - 250.0) / 500.0, 0.0, 1.0);
}

vec2 waveGrad(vec2 p, float t, float dist) {
  vec2 g = vec2(0.0);
  // Sum of directional waves (analytic gradient).
  vec2 d1 = normalize(vec2(1.0, 0.35)); float f1 = 0.045; float a1 = 0.55;
  vec2 d2 = normalize(vec2(-0.6, 1.0)); float f2 = 0.083; float a2 = 0.3;
  vec2 d3 = normalize(vec2(0.2, -1.0)); float f3 = 0.17;  float a3 = 0.14;
  vec2 d4 = normalize(vec2(-1.0, -0.4)); float f4 = 0.37; float a4 = 0.06;
  vec2 d5 = normalize(vec2(0.7, 0.7)); float f5 = 0.81;  float a5 = 0.025;
  g += d1 * cos(dot(d1, p) * f1 + t * 0.9) * f1 * a1 * aa(f1, dist);
  g += d2 * cos(dot(d2, p) * f2 + t * 1.3) * f2 * a2 * aa(f2, dist);
  g += d3 * cos(dot(d3, p) * f3 + t * 1.9) * f3 * a3 * aa(f3, dist);
  g += d4 * cos(dot(d4, p) * f4 + t * 2.7) * f4 * a4 * aa(f4, dist);
  g += d5 * cos(dot(d5, p) * f5 + t * 4.1) * f5 * a5 * aa(f5, dist);
  return g * uRough;
}

void main() {
  #include <logdepthbuf_fragment>
  vec2 p = vWorld.xz;
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 v = toCam / dist;
  vec2 g = waveGrad(p, uTime, dist) + waveGrad(p * 0.21 + 37.0, uTime * 0.6, dist * 0.21) * 0.8;
  vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
  n = normalize(mix(n, vec3(0.0, 1.0, 0.0), smoothstep(400.0, 9000.0, dist) * 0.85));
  float ndv = max(dot(n, v), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  vec3 r = reflect(-v, n);
  vec3 sky = mix(uHorizon, uZenith, pow(clamp(r.y, 0.0, 1.0), 0.45));

  vec2 uv = (p + uHalf) / (2.0 * uHalf);
  float depth = texture2D(uDepth, uv).r * 60.0;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) depth = 60.0;
  vec3 body = mix(uShallow, uDeep, smoothstep(0.5, 22.0, depth));
  float diffuse = max(dot(vec3(0.0, 1.0, 0.0), uSunDir), 0.0) * uSunIntensity * 0.3 + uAmbient;
  vec3 col = mix(body * diffuse, sky, fres * 0.85);

  float sd = max(dot(r, uSunDir), 0.0);
  col += uSunColor * (pow(sd, 600.0) * 8.0 + pow(sd, 60.0) * 0.25) * uSunIntensity * 0.35 * step(0.0, uSunDir.y + 0.02);

  // Shore foam.
  float shore = smoothstep(3.0, 0.2, depth);
  float band = 0.5 + 0.5 * sin(depth * 4.0 - uTime * 1.6 + sin(p.x * 0.05) * 2.0 + sin(p.y * 0.043));
  col = mix(col, vec3(0.92) * min(1.0, diffuse * 1.2), shore * band * 0.55 * (1.0 - smoothstep(1500.0, 4000.0, dist)));

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export class Water {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  private depthTex: DataTexture;

  constructor(env: Environment) {
    const data = new Uint8Array(4 * 4).fill(255);
    this.depthTex = new DataTexture(data, 2, 2, RGBAFormat);
    this.depthTex.needsUpdate = true;
    this.material = new ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      fog: true,
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        {
          uSunDir: { value: new Vector3() },
          uSunColor: { value: new Color() },
          uSunIntensity: { value: 1 },
          uZenith: { value: new Color() },
          uHorizon: { value: new Color() },
          uDeep: { value: new Color(0x0b3550) },
          uShallow: { value: new Color(0x2a9a9a) },
          uTime: { value: 0 },
          uRough: { value: 1 },
          uDepth: { value: null },
          uHalf: { value: WORLD_HALF },
          uAmbient: { value: 0.3 },
        },
      ]),
    });
    this.material.uniforms.uDepth.value = this.depthTex;
    const geo = new PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new Mesh(geo, this.material);
    this.mesh.scale.set(140000, 1, 140000);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'water';
    this.setEnvironment(env);
  }

  /** Build the depth texture from a world heightmap (row-major, z rows). */
  setHeightmap(heights: Float32Array, size: number): void {
    const data = new Uint8Array(size * size * 4);
    for (let k = 0; k < size * size; k++) {
      const depth = Math.max(0, Math.min(60, -heights[k]));
      const v = Math.round((depth / 60) * 255);
      data[k * 4] = v;
      data[k * 4 + 1] = v;
      data[k * 4 + 2] = v;
      data[k * 4 + 3] = 255;
    }
    this.depthTex.dispose();
    this.depthTex = new DataTexture(data, size, size, RGBAFormat);
    this.depthTex.wrapS = this.depthTex.wrapT = ClampToEdgeWrapping;
    this.depthTex.magFilter = LinearFilter;
    this.depthTex.minFilter = LinearFilter;
    this.depthTex.flipY = false;
    this.depthTex.needsUpdate = true;
    this.material.uniforms.uDepth.value = this.depthTex;
  }

  setEnvironment(env: Environment): void {
    const u = this.material.uniforms;
    u.uSunDir.value.copy(env.lightDir);
    u.uSunColor.value.copy(env.sunColor);
    u.uSunIntensity.value = env.sunIntensity;
    u.uZenith.value.copy(env.zenith);
    u.uHorizon.value.copy(env.horizon);
    u.uAmbient.value = env.hemiIntensity * 0.22;
    u.uRough.value = 0.6 + env.windSpeed / 10;
    const night = env.night;
    u.uDeep.value.setHex(0x0b3550).multiplyScalar(1 - night * 0.7);
    u.uShallow.value.setHex(0x2a9a9a).multiplyScalar(1 - night * 0.75);
  }

  update(camera: Camera, time: number): void {
    // Snap to a grid so the plane never drifts relative to the wave pattern.
    this.mesh.position.set(Math.round(camera.position.x / 100) * 100, 0, Math.round(camera.position.z / 100) * 100);
    this.material.uniforms.uTime.value = time;
  }
}
