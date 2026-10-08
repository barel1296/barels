/** Rain streaks around the camera (storm weather). */
import { BufferAttribute, BufferGeometry, LineBasicMaterial, LineSegments, Vector3, type Camera } from 'three';

export class Rain {
  readonly lines: LineSegments;
  private pos: Float32Array;
  private drops: Float32Array;
  private count: number;
  private box = 60;
  intensity = 0;

  constructor(count = 2500) {
    this.count = count;
    this.drops = new Float32Array(count * 3);
    for (let i = 0; i < count * 3; i++) this.drops[i] = (Math.random() - 0.5) * this.box * 2;
    this.pos = new Float32Array(count * 6);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(this.pos, 3));
    this.lines = new LineSegments(geo, new LineBasicMaterial({ color: 0xaab7c8, transparent: true, opacity: 0.35, depthWrite: false }));
    this.lines.frustumCulled = false;
    this.lines.visible = false;
  }

  update(dt: number, camera: Camera, airVel: Vector3, wind: Vector3): void {
    this.lines.visible = this.intensity > 0.01;
    if (!this.lines.visible) return;
    const fall = 9;
    // Relative motion of rain past the camera.
    const rvx = wind.x - airVel.x;
    const rvy = -fall - airVel.y;
    const rvz = wind.z - airVel.z;
    const b = this.box;
    const n = Math.floor(this.count * this.intensity);
    const streak = 0.035;
    const cp = camera.position;
    for (let i = 0; i < this.count; i++) {
      const k = i * 3;
      this.drops[k] += rvx * dt;
      this.drops[k + 1] += rvy * dt;
      this.drops[k + 2] += rvz * dt;
      for (let a = 0; a < 3; a++) {
        if (this.drops[k + a] < -b) this.drops[k + a] += 2 * b;
        else if (this.drops[k + a] > b) this.drops[k + a] -= 2 * b;
      }
      const o = i * 6;
      if (i >= n) {
        this.pos.fill(0, o, o + 6);
        continue;
      }
      const x = cp.x + this.drops[k];
      const y = cp.y + this.drops[k + 1];
      const z = cp.z + this.drops[k + 2];
      this.pos[o] = x;
      this.pos[o + 1] = y;
      this.pos[o + 2] = z;
      this.pos[o + 3] = x - rvx * streak;
      this.pos[o + 4] = y - rvy * streak;
      this.pos[o + 5] = z - rvz * streak;
    }
    (this.lines.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
  }
}
