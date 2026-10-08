/**
 * Chunked LOD terrain. Chunks are generated off-thread and swapped in when ready.
 * Every land chunk of the island is always present at some LOD (far ones are cheap),
 * so the whole island is visible from altitude; ocean-only chunks are skipped.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
  type Texture,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CHUNK_SIZE, WORLD_HALF, type WorldMap } from './WorldMap';
import { chunkIndices, type ChunkData } from './terrainGen';
import { TerrainWorkerPool } from './WorkerPool';
import { makeDetailTexture } from './textures';

export interface TerrainQuality {
  /** LOD distance multiplier. */
  lodScale: number;
  /** Highest resolution used. */
  maxSegments: number;
  /** Tree candidates per chunk (0 disables trees). */
  treeCandidates: number;
  /** Distance (m) within which trees are shown. */
  treeDistance: number;
}

interface Chunk {
  i: number;
  j: number;
  key: string;
  n: number;
  requested: number;
  mesh: Mesh | null;
  minH: number;
  maxH: number;
  treeData: Float32Array | null;
  treeMeshes: InstancedMesh[] | null;
  obstaclesAdded: boolean;
  ocean: boolean;
}


export class Terrain {
  readonly group = new Group();
  readonly material: MeshLambertMaterial;
  private chunks = new Map<string, Chunk>();
  private pool: TerrainWorkerPool;
  private indexAttr = new Map<number, BufferAttribute>();
  private treeGeos: BufferGeometry[];
  private treeMat: MeshLambertMaterial;
  private detail: Texture;
  ready = false;
  private _m = new Matrix4();
  private _q = new Quaternion();
  private _s = new Vector3();
  private _p = new Vector3();
  private _c = new Color();

  constructor(
    readonly world: WorldMap,
    public quality: TerrainQuality,
  ) {
    this.detail = makeDetailTexture();
    this.material = new MeshLambertMaterial({ vertexColors: true, map: this.detail });
    // Sample the detail map at two scales to hide tiling; fade it out with distance.
    this.material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
          vec3 d1 = texture2D(map, vMapUv).rgb;
          vec3 d2 = texture2D(map, vMapUv * 0.131 + vec2(0.37, 0.71)).rgb;
          vec3 d3 = texture2D(map, vMapUv * 0.0193 + vec2(0.11, 0.53)).rgb;
          float fade = 1.0 - smoothstep(600.0, 4000.0, vViewPosition.z);
          float fade2 = 1.0 - smoothstep(2500.0, 12000.0, vViewPosition.z);
          vec3 detail = mix(vec3(1.0), d1 * 1.1, fade * 0.9) * mix(vec3(1.0), d2 * 1.12, fade2) * mix(vec3(1.0), d3 * 1.12, 0.8);
          diffuseColor.rgb *= detail;
        #endif`,
      );
    };
    this.pool = new TerrainWorkerPool(world.seed);
    this.treeMat = new MeshLambertMaterial({ vertexColors: true });
    this.treeGeos = [makeConiferGeometry(), makeBroadleafGeometry()];
    this.group.name = 'terrain';
  }

  /** Generate a coarse version of every chunk; resolves when the island is visible. */
  async init(onProgress?: (p: number) => void): Promise<void> {
    const n0 = Math.floor(-WORLD_HALF / CHUNK_SIZE);
    const n1 = Math.ceil(WORLD_HALF / CHUNK_SIZE) - 1;
    const jobs: Promise<void>[] = [];
    let done = 0;
    const total = (n1 - n0 + 1) ** 2;
    for (let i = n0; i <= n1; i++) {
      for (let j = n0; j <= n1; j++) {
        const key = `${i},${j}`;
        const ch: Chunk = {
          i,
          j,
          key,
          n: 0,
          requested: 8,
          mesh: null,
          minH: 0,
          maxH: 0,
          treeData: null,
          treeMeshes: null,
          obstaclesAdded: false,
          ocean: false,
        };
        this.chunks.set(key, ch);
        jobs.push(
          this.pool.chunk({ i, j, n: 8, trees: 0 }).then((d) => {
            ch.minH = d.minH;
            ch.maxH = d.maxH;
            ch.ocean = d.maxH < -1.5;
            if (!ch.ocean) this.applyChunk(ch, d);
            else this.chunks.delete(key);
            ch.requested = 0;
            done++;
            onProgress?.(done / total);
          }),
        );
      }
    }
    await Promise.all(jobs);
    this.ready = true;
  }

  heightmap(size: number): Promise<Float32Array> {
    return this.pool.heightmap(size, WORLD_HALF);
  }

  private desiredLod(ch: Chunk, cam: Vector3): number {
    const cx = (ch.i + 0.5) * CHUNK_SIZE;
    const cz = (ch.j + 0.5) * CHUNK_SIZE;
    const dx = Math.max(Math.abs(cam.x - cx) - CHUNK_SIZE / 2, 0);
    const dz = Math.max(Math.abs(cam.z - cz) - CHUNK_SIZE / 2, 0);
    const dy = Math.max(0, cam.y - ch.maxH) * 0.6;
    const d = Math.sqrt(dx * dx + dz * dz + dy * dy) / this.quality.lodScale;
    let n = d < 1300 ? 128 : d < 3600 ? 64 : d < 8000 ? 32 : d < 15000 ? 16 : 8;
    n = Math.min(n, this.quality.maxSegments);
    return n;
  }

  /** Call every frame with the camera position. */
  update(cam: Vector3): void {
    if (!this.ready) return;
    // Collect chunks whose LOD should change, nearest first.
    const wants: { ch: Chunk; n: number; d: number }[] = [];
    for (const ch of this.chunks.values()) {
      const n = this.desiredLod(ch, cam);
      const needTrees = this.wantsTrees(ch, cam);
      this.updateTrees(ch, needTrees);
      if (ch.requested) continue;
      if (n !== ch.n || (needTrees && !ch.treeData)) {
        const cx = (ch.i + 0.5) * CHUNK_SIZE - cam.x;
        const cz = (ch.j + 0.5) * CHUNK_SIZE - cam.z;
        // Upgrades (more detail) first, nearest first.
        wants.push({ ch, n, d: cx * cx + cz * cz - (n > ch.n ? 1e10 : 0) });
      }
    }
    if (!wants.length) return;
    wants.sort((a, b) => a.d - b.d);
    const free = this.pool.capacity - this.pool.inFlight;
    for (let k = 0; k < Math.min(free, wants.length); k++) {
      const { ch, n } = wants[k];
      const needTrees = this.wantsTrees(ch, cam) && !ch.treeData;
      ch.requested = n;
      this.pool
        .chunk({ i: ch.i, j: ch.j, n, trees: needTrees ? this.quality.treeCandidates : 0 })
        .then((d) => {
          ch.requested = 0;
          if (d.trees && !ch.treeData) {
            ch.treeData = d.trees;
            this.registerTreeObstacles(ch);
          }
          if (d.n !== ch.n) this.applyChunk(ch, d);
        })
        .catch(() => {
          ch.requested = 0;
        });
    }
  }

  /** True once all chunks near `pos` are at full detail (used while loading). */
  isDetailedAround(pos: Vector3): boolean {
    for (const ch of this.chunks.values()) {
      const n = this.desiredLod(ch, pos);
      if (n >= 64 && ch.n < n) return false;
      if (this.wantsTrees(ch, pos) && !ch.treeData) return false;
    }
    return true;
  }

  private wantsTrees(ch: Chunk, cam: Vector3): boolean {
    if (this.quality.treeCandidates <= 0) return false;
    const cx = (ch.i + 0.5) * CHUNK_SIZE;
    const cz = (ch.j + 0.5) * CHUNK_SIZE;
    const dx = Math.max(Math.abs(cam.x - cx) - CHUNK_SIZE / 2, 0);
    const dz = Math.max(Math.abs(cam.z - cz) - CHUNK_SIZE / 2, 0);
    return Math.hypot(dx, dz) < this.quality.treeDistance && cam.y - ch.maxH < 3500;
  }

  private applyChunk(ch: Chunk, d: ChunkData): void {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(d.positions, 3));
    geo.setAttribute('normal', new BufferAttribute(d.normals, 3));
    geo.setAttribute('color', new BufferAttribute(d.colors, 3));
    geo.setAttribute('uv', new BufferAttribute(d.uvs, 2));
    let idx = this.indexAttr.get(d.n);
    if (!idx) {
      idx = new BufferAttribute(chunkIndices(d.n), 1);
      this.indexAttr.set(d.n, idx);
    }
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    if (ch.mesh) {
      ch.mesh.geometry.dispose();
      ch.mesh.geometry = geo;
    } else {
      const mesh = new Mesh(geo, this.material);
      mesh.position.set(ch.i * CHUNK_SIZE, 0, ch.j * CHUNK_SIZE);
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.name = `chunk ${ch.key}`;
      ch.mesh = mesh;
      this.group.add(mesh);
    }
    ch.n = d.n;
  }

  private registerTreeObstacles(ch: Chunk): void {
    if (ch.obstaclesAdded || !ch.treeData) return;
    const t = ch.treeData;
    for (let k = 0; k < t.length; k += 6) {
      const s = t[k + 3];
      const conifer = t[k + 4] === 0;
      const height = (conifer ? 15 : 11) * s;
      const r = (conifer ? 2.6 : 3.6) * s;
      this.world.obstacles.add({ x: t[k], z: t[k + 2], hx: r * 0.7, hz: r * 0.7, y0: t[k + 1], y1: t[k + 1] + height, kind: 'tree' });
    }
    ch.obstaclesAdded = true;
  }

  private updateTrees(ch: Chunk, show: boolean): void {
    if (!show) {
      if (ch.treeMeshes) {
        for (const m of ch.treeMeshes) {
          this.group.remove(m);
          m.dispose();
        }
        ch.treeMeshes = null;
      }
      return;
    }
    if (ch.treeMeshes || !ch.treeData) return;
    const t = ch.treeData;
    const counts = [0, 0];
    for (let k = 0; k < t.length; k += 6) counts[t[k + 4] === 0 ? 0 : 1]++;
    const meshes: InstancedMesh[] = [];
    for (let type = 0; type < 2; type++) {
      if (!counts[type]) continue;
      const im = new InstancedMesh(this.treeGeos[type], this.treeMat, counts[type]);
      im.instanceMatrix.setUsage(DynamicDrawUsage);
      let n = 0;
      for (let k = 0; k < t.length; k += 6) {
        if ((t[k + 4] === 0 ? 0 : 1) !== type) continue;
        const s = t[k + 3];
        this._q.setFromAxisAngle(this._p.set(0, 1, 0), t[k + 5] * 6.283);
        this._s.set(s, s * (0.9 + t[k + 5] * 0.25), s);
        this._p.set(t[k], t[k + 1], t[k + 2]);
        this._m.compose(this._p, this._q, this._s);
        im.setMatrixAt(n, this._m);
        const tint = t[k + 5];
        this._c.setRGB(0.85 + tint * 0.25, 0.9 + tint * 0.15, 0.85 + (1 - tint) * 0.2);
        im.setColorAt(n, this._c);
        n++;
      }
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();
      im.frustumCulled = true;
      im.name = `trees ${ch.key}`;
      meshes.push(im);
      this.group.add(im);
    }
    ch.treeMeshes = meshes;
  }

  /** Count of chunk meshes (debug). */
  get chunkCount(): number {
    return this.chunks.size;
  }

  setQuality(q: TerrainQuality): void {
    this.quality = q;
  }

  dispose(): void {
    this.pool.dispose();
    for (const ch of this.chunks.values()) {
      ch.mesh?.geometry.dispose();
      ch.treeMeshes?.forEach((m) => m.dispose());
    }
    this.material.dispose();
    this.detail.dispose();
    this.treeGeos.forEach((g) => g.dispose());
    this.treeMat.dispose();
  }
}

function colorize(geo: BufferGeometry, hex: number): BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new Color(hex);
  const n = g.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) {
    arr[k * 3] = c.r;
    arr[k * 3 + 1] = c.g;
    arr[k * 3 + 2] = c.b;
  }
  g.setAttribute('color', new BufferAttribute(arr, 3));
  g.deleteAttribute('uv');
  return g;
}

function makeConiferGeometry(): BufferGeometry {
  const trunk = colorize(new CylinderGeometry(0.25, 0.35, 3, 5).translate(0, 1.5, 0), 0x5a4030);
  const c1 = colorize(new ConeGeometry(2.6, 7, 7).translate(0, 5.5, 0), 0x2f5a2a);
  const c2 = colorize(new ConeGeometry(1.9, 6, 7).translate(0, 9.5, 0), 0x356630);
  const g = mergeGeometries([trunk, c1, c2]);
  g.computeVertexNormals();
  return g;
}

function makeBroadleafGeometry(): BufferGeometry {
  const trunk = colorize(new CylinderGeometry(0.3, 0.45, 4, 5).translate(0, 2, 0), 0x5d4632);
  const crown = colorize(new IcosahedronGeometry(3.6, 0).scale(1, 0.85, 1).translate(0, 6.6, 0), 0x4c7a32);
  const g = mergeGeometries([trunk, crown]);
  g.computeVertexNormals();
  return g;
}
