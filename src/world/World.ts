/**
 * Assembles the world scene (terrain, sea, sky, clouds, city, airports, lights) and
 * implements the physics WorldQuery on top of the analytic WorldMap.
 */
import { DirectionalLight, FogExp2, HemisphereLight, Mesh, PMREMGenerator, Scene, Vector3, type PerspectiveCamera, type Texture, type WebGLRenderer } from 'three';
import { WorldMap, type SurfaceType } from './WorldMap';
import { Environment, type EnvOptions } from './Environment';
import { Terrain, type TerrainQuality } from './Terrain';
import { Sky } from './Sky';
import { Water } from './Water';
import { Clouds } from './Clouds';
import { City } from './City';
import { AirportScenery } from './Airports';
import type { WorldQuery } from '../physics/FlightModel';

export type QualityLevel = 'low' | 'medium' | 'high';

export interface GraphicsQuality {
  level: QualityLevel;
  pixelRatio: number;
  shadows: boolean;
  shadowMapSize: number;
  terrain: TerrainQuality;
  clouds: number;
  city: number;
  antialias: boolean;
}

export const QUALITY: Record<QualityLevel, GraphicsQuality> = {
  low: {
    level: 'low',
    pixelRatio: 0.85,
    shadows: false,
    shadowMapSize: 1024,
    terrain: { lodScale: 0.6, maxSegments: 64, treeCandidates: 700, treeDistance: 2500 },
    clouds: 0.5,
    city: 0.6,
    antialias: false,
  },
  medium: {
    level: 'medium',
    pixelRatio: 1,
    shadows: true,
    shadowMapSize: 1024,
    terrain: { lodScale: 0.85, maxSegments: 128, treeCandidates: 1500, treeDistance: 3500 },
    clouds: 0.8,
    city: 0.85,
    antialias: true,
  },
  high: {
    level: 'high',
    pixelRatio: 1.5,
    shadows: true,
    shadowMapSize: 2048,
    terrain: { lodScale: 1.15, maxSegments: 128, treeCandidates: 2600, treeDistance: 5000 },
    clouds: 1,
    city: 1,
    antialias: true,
  },
};

export const HEIGHTMAP_SIZE = 512;

export class World implements WorldQuery {
  readonly map: WorldMap;
  env: Environment;
  readonly terrain: Terrain;
  readonly sky: Sky;
  readonly water: Water;
  clouds: Clouds;
  city: City | null = null;
  airports: AirportScenery | null = null;
  readonly sun: DirectionalLight;
  readonly hemi: HemisphereLight;
  readonly fog: FogExp2;
  heightmap: Float32Array | null = null;
  private time = 0;
  private _n = { x: 0, y: 1, z: 0 };

  constructor(
    readonly scene: Scene,
    public quality: GraphicsQuality,
    envOptions: EnvOptions,
  ) {
    this.map = new WorldMap();
    this.env = new Environment(envOptions);
    this.fog = new FogExp2(this.env.fogColor.getHex(), this.env.fogDensity);
    scene.fog = this.fog;
    this.terrain = new Terrain(this.map, quality.terrain);
    scene.add(this.terrain.group);
    this.sky = new Sky(this.env);
    scene.add(this.sky.mesh);
    this.water = new Water(this.env);
    scene.add(this.water.mesh);
    this.clouds = new Clouds(this.env, quality.clouds);
    scene.add(this.clouds.mesh);

    this.hemi = new HemisphereLight(0xffffff, 0x444444, 1);
    scene.add(this.hemi);
    this.sun = new DirectionalLight(0xffffff, 2);
    this.sun.castShadow = quality.shadows;
    this.sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    const sc = this.sun.shadow.camera;
    sc.left = -70;
    sc.right = 70;
    sc.top = 70;
    sc.bottom = -70;
    sc.near = 10;
    sc.far = 2500;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.05;
    scene.add(this.sun);
    scene.add(this.sun.target);
    this.applyEnvironment();
  }

  async init(onProgress?: (p: number, label: string) => void): Promise<void> {
    onProgress?.(0.02, 'Shaping the island');
    await this.terrain.init((p) => onProgress?.(0.05 + p * 0.55, 'Generating terrain'));
    onProgress?.(0.62, 'Surveying the coastline');
    this.heightmap = await this.terrain.heightmap(HEIGHTMAP_SIZE);
    this.water.setHeightmap(this.heightmap, HEIGHTMAP_SIZE);
    onProgress?.(0.75, 'Building airports');
    this.airports = new AirportScenery(this.map, this.env);
    this.scene.add(this.airports.group);
    onProgress?.(0.85, 'Building the city');
    this.city = new City(this.map, this.terrain.group, this.quality.city);
    this.city.setNight(this.env.night);
    onProgress?.(0.95, 'Final checks');
  }

  setEnvironment(opts: EnvOptions): void {
    this.env = new Environment(opts);
    this.scene.remove(this.clouds.mesh);
    this.clouds.dispose();
    this.clouds = new Clouds(this.env, this.quality.clouds);
    this.scene.add(this.clouds.mesh);
    this.applyEnvironment();
  }

  private applyEnvironment(): void {
    const env = this.env;
    this.fog.color.copy(env.fogColor);
    this.fog.density = env.fogDensity;
    this.sky.setEnvironment(env);
    this.water.setEnvironment(env);
    this.hemi.color.copy(env.hemiSky);
    this.hemi.groundColor.copy(env.hemiGround);
    this.hemi.intensity = env.hemiIntensity;
    this.sun.color.copy(env.sunColor);
    this.sun.intensity = env.sunIntensity;
    this.city?.setNight(env.night);
  }

  private envTexture: Texture | null = null;

  /** Image-based lighting from the current sky (gives aircraft paint/metal believable reflections). */
  buildEnvMap(renderer: WebGLRenderer): void {
    const pmrem = new PMREMGenerator(renderer);
    const envScene = new Scene();
    const sky = new Mesh(this.sky.mesh.geometry, this.sky.material);
    sky.scale.setScalar(1);
    envScene.add(sky);
    const rt = pmrem.fromScene(envScene, 0.02, 0.1, 2000);
    this.envTexture?.dispose();
    this.envTexture = rt.texture;
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = this.env.night > 0.5 ? 0.25 : 0.8;
    pmrem.dispose();
  }

  setQuality(q: GraphicsQuality): void {
    this.quality = q;
    this.terrain.setQuality(q.terrain);
    this.sun.castShadow = q.shadows;
    if (this.sun.shadow.mapSize.x !== q.shadowMapSize) {
      this.sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null as never;
    }
  }

  /** Per-frame update. `focus` is where shadows are centred (usually the aircraft). */
  update(camera: PerspectiveCamera, dt: number, focus: Vector3, viewportHeight: number): void {
    this.time += dt;
    this.terrain.update(camera.position);
    this.sky.update(camera);
    this.water.update(camera, this.time);
    this.clouds.update(camera, this.env, dt);
    this.airports?.update(camera, this.env, this.time, viewportHeight, camera.fov);
    // Shadow camera follows the focus point.
    this.sun.position.copy(focus).addScaledVector(this.env.lightDir, 1200);
    this.sun.target.position.copy(focus);
  }

  // ---------------------------------------------------------------- WorldQuery
  groundHeight(x: number, z: number): number {
    return this.map.groundHeight(x, z);
  }
  isWater(x: number, z: number): boolean {
    return this.map.isWater(x, z);
  }
  surfaceType(x: number, z: number): SurfaceType {
    return this.map.surfaceType(x, z);
  }
  normal(x: number, z: number, out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    if (this.map.runwayAt(x, z, 30) || this.map.isPavedArea(x, z)) {
      out.x = 0;
      out.y = 1;
      out.z = 0;
      return out;
    }
    return this.map.normal(x, z, out);
  }
  obstacle(x: number, y: number, z: number, r: number): string | null {
    const o = this.map.obstacles.query(x, y, z, r);
    if (!o) return null;
    return o.kind === 'tree' ? 'trees' : 'a building';
  }

  /** Height above ground at a point (for cameras, etc.). */
  agl(p: Vector3): number {
    return p.y - this.map.groundHeight(p.x, p.z);
  }

  /** Terrain normal helper (allocation-free). */
  normalAt(x: number, z: number): { x: number; y: number; z: number } {
    return this.map.normal(x, z, this._n);
  }

  get elapsed(): number {
    return this.time;
  }
}
