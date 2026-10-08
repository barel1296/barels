/** Persistent settings, best scores and career statistics (localStorage, failure-tolerant). */
import type { QualityLevel } from '../world/World';
import type { FlightAssist } from '../physics/FlightControls';

export type Units = 'imperial' | 'metric';
export type HudMode = 'full' | 'instruments' | 'minimal';

export interface Settings {
  quality: QualityLevel;
  volume: number;
  muted: boolean;
  assist: FlightAssist;
  invertPitch: boolean;
  units: Units;
  hud: HudMode;
  showFps: boolean;
  sensitivity: number;
  touchControls: 'auto' | 'on' | 'off';
}

export const DEFAULT_SETTINGS: Settings = {
  quality: 'medium',
  volume: 0.75,
  muted: false,
  assist: 'easy',
  invertPitch: false,
  units: 'imperial',
  hud: 'full',
  showFps: false,
  sensitivity: 1,
  touchControls: 'auto',
};

export interface MissionRecord {
  bestScore: number;
  bestTime: number | null;
  stars: number;
  completions: number;
}

export interface Career {
  flightTime: number;
  distance: number;
  landings: number;
  crashes: number;
  maxAltitude: number;
  maxSpeed: number;
}

const KEY = 'aeroplane-sim:v1';

interface SaveData {
  settings: Settings;
  missions: Record<string, MissionRecord>;
  career: Career;
  lastAircraft: string;
}

function fresh(): SaveData {
  return {
    settings: { ...DEFAULT_SETTINGS },
    missions: {},
    career: { flightTime: 0, distance: 0, landings: 0, crashes: 0, maxAltitude: 0, maxSpeed: 0 },
    lastAircraft: 'kestrel',
  };
}

export class Store {
  data: SaveData;

  constructor() {
    this.data = fresh();
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<SaveData>;
        this.data = {
          ...fresh(),
          ...parsed,
          settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
          career: { ...fresh().career, ...(parsed.career ?? {}) },
          missions: parsed.missions ?? {},
        };
      }
    } catch {
      /* storage unavailable — keep defaults */
    }
  }

  get settings(): Settings {
    return this.data.settings;
  }

  save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* ignore */
    }
  }

  record(id: string): MissionRecord {
    return this.data.missions[id] ?? { bestScore: 0, bestTime: null, stars: 0, completions: 0 };
  }

  /** Store a mission result. Returns true if it is a new best. */
  submit(id: string, score: number, time: number | null, stars: number): boolean {
    const r = { ...this.record(id) };
    const best = score > r.bestScore;
    r.completions++;
    r.bestScore = Math.max(r.bestScore, score);
    if (time !== null) r.bestTime = r.bestTime === null ? time : Math.min(r.bestTime, time);
    r.stars = Math.max(r.stars, stars);
    this.data.missions[id] = r;
    this.save();
    return best;
  }

  reset(): void {
    this.data = fresh();
    this.save();
  }
}
