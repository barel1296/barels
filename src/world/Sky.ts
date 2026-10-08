/** Gradient sky dome with sun, moon and stars; horizon matches the scene fog colour. */
import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry, Vector3, type Camera } from 'three';
import type { Environment } from './Environment';

const vert = /* glsl */ `
varying vec3 vDir;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vDir = wp.xyz - cameraPosition;
  vec4 p = projectionMatrix * viewMatrix * wp;
  gl_Position = vec4(p.xy, p.w * 0.99999, p.w);
}
`;

const frag = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uMoonDir;
uniform float uSunVis;
uniform float uNight;
uniform float uCoverage;
varying vec3 vDir;

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  float t = pow(clamp(h, 0.0, 1.0), 0.42);
  vec3 col = mix(uHorizon, uZenith, t);
  if (h < 0.0) col = mix(uHorizon, uGround, smoothstep(0.0, -0.25, h));

  float sd = max(dot(d, uSunDir), 0.0);
  // Broad glow + tight halo around the sun; stronger near the horizon (low sun).
  float lowSun = 1.0 - smoothstep(0.0, 0.5, uSunDir.y);
  col += uSunColor * (pow(sd, 5.0) * (0.12 + 0.35 * lowSun) + pow(sd, 90.0) * 0.55) * uSunVis;
  float disk = smoothstep(0.99955, 0.99975, sd);
  col = mix(col, uSunColor * 1.6 + 0.4, disk * uSunVis * (1.0 - uCoverage * 0.85));

  if (uNight > 0.01) {
    float md = dot(d, uMoonDir);
    col += vec3(0.86, 0.9, 1.0) * smoothstep(0.99945, 0.9996, md) * uNight * (1.0 - uCoverage * 0.7);
    col += vec3(0.2, 0.25, 0.4) * pow(max(md, 0.0), 120.0) * 0.5 * uNight;
    if (h > 0.0) {
      vec3 sp = d * 380.0;
      vec3 cell = floor(sp);
      float r = hash13(cell);
      if (r > 0.9965) {
        vec3 c = cell + 0.5 + (vec3(hash13(cell + 1.7), hash13(cell + 3.1), hash13(cell + 7.9)) - 0.5) * 0.6;
        float dist = length(sp - c);
        float tw = 0.6 + 0.4 * hash13(cell + 11.0);
        float star = smoothstep(0.32, 0.0, dist) * tw;
        col += vec3(star) * uNight * smoothstep(0.0, 0.2, h) * (1.0 - uCoverage * 0.95);
      }
    }
  }
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

export class Sky {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;

  constructor(env: Environment) {
    this.material = new ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      side: BackSide,
      depthWrite: false,
      toneMapped: false,
      fog: false,
      uniforms: {
        uZenith: { value: new Color() },
        uHorizon: { value: new Color() },
        uGround: { value: new Color() },
        uSunDir: { value: new Vector3() },
        uSunColor: { value: new Color() },
        uMoonDir: { value: new Vector3() },
        uSunVis: { value: 1 },
        uNight: { value: 0 },
        uCoverage: { value: 0 },
      },
    });
    this.mesh = new Mesh(new SphereGeometry(1000, 48, 24), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.name = 'sky';
    this.setEnvironment(env);
  }

  setEnvironment(env: Environment): void {
    const u = this.material.uniforms;
    u.uZenith.value.copy(env.zenith);
    u.uHorizon.value.copy(env.horizon);
    u.uGround.value.copy(env.horizon).multiplyScalar(0.8);
    u.uSunDir.value.copy(env.sunDir);
    u.uSunColor.value.copy(env.sunColor);
    u.uMoonDir.value.copy(env.moonDir);
    u.uSunVis.value = env.sunDir.y > -0.05 ? 1 : 0;
    u.uNight.value = env.night;
    u.uCoverage.value = env.coverage;
  }

  update(camera: Camera): void {
    this.mesh.position.copy(camera.position);
  }
}
