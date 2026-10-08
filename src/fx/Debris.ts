/** Ballistic crash debris with terrain bounce. */
import { Euler, Group, Mesh, Vector3 } from 'three';
import type { WorldQuery } from '../physics/FlightModel';

interface Piece {
  mesh: Mesh;
  vel: Vector3;
  spin: Vector3;
  resting: boolean;
}

export class Debris {
  readonly group = new Group();
  private pieces: Piece[] = [];
  private _e = new Euler();

  spawn(meshes: Mesh[], baseVel: Vector3, energy: number): void {
    this.clear();
    const limit = 70;
    const list = meshes.length > limit ? meshes.filter((_, i) => i % Math.ceil(meshes.length / limit) === 0) : meshes;
    for (const m of list) {
      const vel = baseVel.clone().multiplyScalar(0.35);
      vel.x += (Math.random() - 0.5) * energy;
      vel.y += Math.random() * energy * 0.8 + 3;
      vel.z += (Math.random() - 0.5) * energy;
      const spin = new Vector3((Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10);
      m.castShadow = true;
      this.group.add(m);
      this.pieces.push({ mesh: m, vel, spin, resting: false });
    }
  }

  update(dt: number, world: WorldQuery): void {
    for (const p of this.pieces) {
      if (p.resting) continue;
      p.vel.y -= 9.81 * dt;
      p.vel.multiplyScalar(Math.exp(-0.15 * dt));
      p.mesh.position.addScaledVector(p.vel, dt);
      this._e.set(p.spin.x * dt, p.spin.y * dt, p.spin.z * dt);
      p.mesh.rotation.x += this._e.x;
      p.mesh.rotation.y += this._e.y;
      p.mesh.rotation.z += this._e.z;
      const gy = world.groundHeight(p.mesh.position.x, p.mesh.position.z) + 0.3;
      if (p.mesh.position.y < gy) {
        p.mesh.position.y = gy;
        if (world.isWater(p.mesh.position.x, p.mesh.position.z)) {
          p.vel.multiplyScalar(0.3);
          p.mesh.position.y = gy - 0.4;
          if (p.vel.length() < 1) p.resting = true;
          continue;
        }
        p.vel.y = Math.abs(p.vel.y) * 0.35;
        p.vel.x *= 0.6;
        p.vel.z *= 0.6;
        p.spin.multiplyScalar(0.6);
        if (p.vel.length() < 1.2) p.resting = true;
      }
    }
  }

  clear(): void {
    for (const p of this.pieces) this.group.remove(p.mesh);
    this.pieces = [];
  }

  get active(): number {
    return this.pieces.length;
  }
}
