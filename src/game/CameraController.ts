/**
 * Camera modes: chase, cockpit, orbit and fly-by, with mouse look, zoom,
 * terrain avoidance and camera shake.
 */
import { MathUtils, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import type { FlightModel } from '../physics/FlightModel';
import type { WorldQuery } from '../physics/FlightModel';
import { clamp, damp } from '../core/math';
import { Simplex2 } from '../world/noise';

export type CameraMode = 'chase' | 'cockpit' | 'orbit' | 'flyby';
export const CAMERA_MODES: CameraMode[] = ['chase', 'cockpit', 'orbit', 'flyby'];
export const CAMERA_LABELS: Record<CameraMode, string> = {
  chase: 'Chase camera',
  cockpit: 'Cockpit view',
  orbit: 'Orbit camera',
  flyby: 'Fly-by camera',
};

const _v = new Vector3();
const _v2 = new Vector3();
const _q = new Quaternion();
const _fwd = new Vector3();
const _up = new Vector3();
const _right = new Vector3();

export class CameraController {
  mode: CameraMode = 'chase';
  /** User look offsets (radians) from mouse drag / right stick. */
  lookYaw = 0;
  lookPitch = 0;
  zoom = 1;
  private dragging = false;
  private releaseTime = 0;
  private offset = new Vector3();
  private initialized = false;
  private flybyPos = new Vector3();
  private flybyTime = 0;
  private shakeAmp = 0;
  private noise = new Simplex2(17);
  private time = 0;
  private smoothUp = new Vector3(0, 1, 0);
  private orbitYaw = 0.6;
  private orbitPitch = 0.25;

  constructor(readonly camera: PerspectiveCamera) {}

  setMode(mode: CameraMode): void {
    this.mode = mode;
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.initialized = false;
    this.flybyTime = 0;
    this.camera.near = mode === 'cockpit' ? 0.08 : 0.5;
    this.camera.updateProjectionMatrix();
  }

  cycle(): CameraMode {
    const i = CAMERA_MODES.indexOf(this.mode);
    this.setMode(CAMERA_MODES[(i + 1) % CAMERA_MODES.length]);
    return this.mode;
  }

  beginDrag(): void {
    this.dragging = true;
  }
  endDrag(): void {
    this.dragging = false;
    this.releaseTime = 0;
  }
  drag(dx: number, dy: number, sensitivity = 1): void {
    const k = 0.005 * sensitivity;
    if (this.mode === 'orbit') {
      this.orbitYaw -= dx * k;
      this.orbitPitch = clamp(this.orbitPitch + dy * k, -0.2, 1.4);
      return;
    }
    this.lookYaw = clamp(this.lookYaw - dx * k, -Math.PI * 0.95, Math.PI * 0.95);
    this.lookPitch = clamp(this.lookPitch - dy * k, -1.2, 1.2);
  }
  /** Analog look (gamepad right stick), values -1..1. */
  look(x: number, y: number, dt: number): void {
    if (Math.abs(x) < 0.15 && Math.abs(y) < 0.15) return;
    this.dragging = true;
    this.releaseTime = 0;
    this.drag(-x * 400 * dt, -y * 300 * dt);
    this.dragging = false;
  }
  wheel(delta: number): void {
    this.zoom = clamp(this.zoom * (delta > 0 ? 1.1 : 0.9), 0.35, 4);
  }
  shake(amount: number): void {
    this.shakeAmp = Math.max(this.shakeAmp, amount);
  }

  update(dt: number, m: FlightModel, world: WorldQuery): void {
    this.time += dt;
    const cam = this.camera;
    const pos = m.position;
    const spec = m.spec;
    _fwd.set(0, 0, -1).applyQuaternion(m.quaternion);
    _up.set(0, 1, 0).applyQuaternion(m.quaternion);
    _right.set(1, 0, 0).applyQuaternion(m.quaternion);
    if (!this.dragging) {
      this.releaseTime += dt;
      if (this.releaseTime > 1.5 && this.mode !== 'cockpit') {
        this.lookYaw = damp(this.lookYaw, 0, 2.5, dt);
        this.lookPitch = damp(this.lookPitch, 0, 2.5, dt);
      }
    }
    let fov = 60;
    switch (this.mode) {
      case 'chase': {
        const dist = spec.camera.distance * this.zoom;
        const height = spec.camera.height * Math.sqrt(this.zoom);
        // Follow heading fully, pitch partially, roll a little (keeps the horizon readable).
        const flatFwd = _v.copy(_fwd);
        const speed = m.velocity.length();
        if (speed > 15) flatFwd.lerp(_v2.copy(m.velocity).normalize(), 0.35).normalize();
        this.smoothUp.lerp(_v2.set(0, 1, 0).lerp(_up, 0.3), 1 - Math.exp(-3 * dt)).normalize();
        const back = _v2.copy(flatFwd).multiplyScalar(-dist);
        // Apply user look rotation around the aircraft.
        _q.setFromAxisAngle(this.smoothUp, this.lookYaw);
        back.applyQuaternion(_q);
        const side = new Vector3().crossVectors(back, this.smoothUp).normalize();
        _q.setFromAxisAngle(side, this.lookPitch);
        back.applyQuaternion(_q);
        const desired = back.addScaledVector(this.smoothUp, height);
        if (!this.initialized) {
          this.offset.copy(desired);
          this.initialized = true;
        }
        const k = 1 - Math.exp(-(this.dragging ? 20 : 6) * dt);
        this.offset.lerp(desired, k);
        cam.position.copy(pos).add(this.offset);
        cam.up.copy(this.smoothUp);
        cam.lookAt(_v.copy(pos).addScaledVector(this.smoothUp, height * 0.35));
        fov = 60 + clamp((speed - 60) / 8, 0, 12);
        break;
      }
      case 'cockpit': {
        const c = spec.camera.cockpit;
        const g = m.telemetry.gLoad;
        // Head moves slightly with G.
        _v.set(c[0], c[1] - clamp((g - 1) * 0.012, -0.05, 0.08), c[2]).applyQuaternion(m.quaternion);
        cam.position.copy(pos).add(_v);
        cam.quaternion.copy(m.quaternion);
        _q.setFromAxisAngle(_v2.set(0, 1, 0), this.lookYaw);
        cam.quaternion.multiply(_q);
        _q.setFromAxisAngle(_v2.set(1, 0, 0), this.lookPitch - 0.06);
        cam.quaternion.multiply(_q);
        cam.up.set(0, 1, 0);
        fov = 68 / Math.sqrt(this.zoom);
        break;
      }
      case 'orbit': {
        const dist = spec.camera.distance * 1.4 * this.zoom;
        _v.set(Math.sin(this.orbitYaw) * Math.cos(this.orbitPitch), Math.sin(this.orbitPitch), Math.cos(this.orbitYaw) * Math.cos(this.orbitPitch)).multiplyScalar(dist);
        cam.position.copy(pos).add(_v);
        cam.up.set(0, 1, 0);
        cam.lookAt(pos);
        break;
      }
      case 'flyby': {
        const speed = m.velocity.length();
        const d = cam.position.distanceTo(pos);
        if (!this.initialized || this.flybyTime > 14 || d > Math.max(600, speed * 9)) {
          // Place the camera ahead and to the side of the flight path.
          const lead = Math.max(speed * 4.5, spec.camera.distance * 3);
          this.flybyPos.copy(pos).addScaledVector(speed > 5 ? _v.copy(m.velocity).normalize() : _fwd, lead);
          this.flybyPos.addScaledVector(_right, spec.camera.distance * 1.4 * (Math.random() > 0.5 ? 1 : -1));
          this.flybyPos.y += spec.camera.height * 1.5;
          this.flybyTime = 0;
          this.initialized = true;
        }
        this.flybyTime += dt;
        cam.position.copy(this.flybyPos);
        cam.up.set(0, 1, 0);
        cam.lookAt(pos);
        // Zoom to keep the aircraft a sensible size.
        const wantSize = spec.wingSpan * 3.2;
        fov = clamp(MathUtils.radToDeg(2 * Math.atan(wantSize / 2 / Math.max(d, 1))), 8, 65) / this.zoom;
        break;
      }
    }
    // Keep the camera above ground.
    const gh = world.groundHeight(cam.position.x, cam.position.z);
    const minY = gh + (this.mode === 'cockpit' ? 0.2 : 1.5);
    if (cam.position.y < minY) {
      cam.position.y = minY;
      if (this.mode === 'chase' || this.mode === 'orbit') cam.lookAt(pos);
    }
    // Shake.
    if (this.shakeAmp > 0.001) {
      const n = this.noise;
      const s = this.shakeAmp;
      cam.rotateX(n.noise(this.time * 25, 1) * s * 0.02);
      cam.rotateY(n.noise(this.time * 25, 7) * s * 0.02);
      cam.rotateZ(n.noise(this.time * 25, 13) * s * 0.01);
      this.shakeAmp *= Math.exp(-3 * dt);
    }
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = damp(cam.fov, fov, 4, dt);
      cam.updateProjectionMatrix();
    }
  }

  /** Free camera around a wreck after a crash. */
  updateCrash(dt: number, target: Vector3, world: WorldQuery): void {
    this.time += dt;
    this.orbitYaw += dt * 0.15;
    const cam = this.camera;
    const dist = 60 * this.zoom;
    cam.position.set(target.x + Math.sin(this.orbitYaw) * dist, target.y + 22, target.z + Math.cos(this.orbitYaw) * dist);
    const gh = world.groundHeight(cam.position.x, cam.position.z);
    cam.position.y = Math.max(cam.position.y, gh + 5);
    cam.up.set(0, 1, 0);
    cam.lookAt(target);
    if (this.shakeAmp > 0.001) {
      cam.rotateX(this.noise.noise(this.time * 25, 1) * this.shakeAmp * 0.03);
      cam.rotateZ(this.noise.noise(this.time * 25, 9) * this.shakeAmp * 0.02);
      this.shakeAmp *= Math.exp(-2 * dt);
    }
    if (cam.fov !== 60) {
      cam.fov = 60;
      cam.updateProjectionMatrix();
    }
  }
}
