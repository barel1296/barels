/**
 * Time of day + weather → lighting, sky colours, fog, clouds and wind.
 */
import { Color, Vector3 } from 'three';
import { DEG, lerp } from '../core/math';
import { Simplex2 } from './noise';

export type TimeOfDay = 'dawn' | 'day' | 'sunset' | 'night';
export type WeatherKind = 'clear' | 'cloudy' | 'overcast' | 'storm';

export interface EnvOptions {
  time: TimeOfDay;
  weather: WeatherKind;
  /** Wind speed (m/s) and direction the wind blows FROM (deg). */
  windSpeed?: number;
  windFrom?: number;
}

interface TimePreset {
  sunElev: number;
  sunAz: number;
  sunColor: number;
  sunIntensity: number;
  zenith: number;
  horizon: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  night: number;
}

const TIMES: Record<TimeOfDay, TimePreset> = {
  dawn: { sunElev: 9, sunAz: 100, sunColor: 0xffbf8a, sunIntensity: 2.6, zenith: 0x4a6fa5, horizon: 0xf3c29a, hemiSky: 0xb4c4e0, hemiGround: 0x6a6050, hemiIntensity: 1.35, night: 0.12 },
  day: { sunElev: 52, sunAz: 160, sunColor: 0xfff4e2, sunIntensity: 3.0, zenith: 0x2f6fd6, horizon: 0xb9d4ee, hemiSky: 0xbfd8f5, hemiGround: 0x6b6a52, hemiIntensity: 1.15, night: 0 },
  sunset: { sunElev: 7, sunAz: 262, sunColor: 0xff9a5a, sunIntensity: 2.4, zenith: 0x31407a, horizon: 0xf79a5a, hemiSky: 0xa8a4c8, hemiGround: 0x5e4c40, hemiIntensity: 1.2, night: 0.22 },
  night: { sunElev: -25, sunAz: 300, sunColor: 0x9db6ff, sunIntensity: 0.45, zenith: 0x02050f, horizon: 0x0d1626, hemiSky: 0x2c3c5c, hemiGround: 0x0c0c12, hemiIntensity: 0.5, night: 1 },
};

interface WeatherPreset {
  coverage: number;
  cloudBase: number;
  cloudThickness: number;
  visibility: number;
  sunDim: number;
  desaturate: number;
  wind: number;
  gust: number;
  turbulence: number;
  rain: number;
}

const WEATHER: Record<WeatherKind, WeatherPreset> = {
  clear: { coverage: 0.12, cloudBase: 1900, cloudThickness: 250, visibility: 45000, sunDim: 1, desaturate: 0, wind: 3, gust: 0.5, turbulence: 0.15, rain: 0 },
  cloudy: { coverage: 0.42, cloudBase: 1300, cloudThickness: 450, visibility: 30000, sunDim: 0.85, desaturate: 0.15, wind: 6, gust: 2, turbulence: 0.45, rain: 0 },
  overcast: { coverage: 0.85, cloudBase: 900, cloudThickness: 650, visibility: 14000, sunDim: 0.45, desaturate: 0.55, wind: 9, gust: 3, turbulence: 0.7, rain: 0.2 },
  storm: { coverage: 1.0, cloudBase: 650, cloudThickness: 900, visibility: 6500, sunDim: 0.25, desaturate: 0.75, wind: 14, gust: 6, turbulence: 1.4, rain: 1 },
};

const _c = new Color();
const _g = new Color();

export class Environment {
  readonly options: EnvOptions;
  readonly sunDir = new Vector3();
  /** Direction of the main light (sun by day, moon at night). */
  readonly lightDir = new Vector3();
  readonly moonDir = new Vector3();
  readonly sunColor = new Color();
  sunIntensity = 1;
  readonly zenith = new Color();
  readonly horizon = new Color();
  readonly fogColor = new Color();
  fogDensity = 0.00005;
  readonly hemiSky = new Color();
  readonly hemiGround = new Color();
  hemiIntensity = 1;
  /** 0 = full day, 1 = full night. Drives runway lights, windows, stars. */
  night = 0;
  coverage = 0.2;
  cloudBase = 1500;
  cloudThickness = 400;
  rain = 0;
  visibility = 30000;
  readonly cloudColor = new Color();
  /** Mean wind vector (m/s, world frame: direction the air moves toward). */
  readonly wind = new Vector3();
  windSpeed = 0;
  windFrom = 0;
  gust = 0;
  turbulence = 0;
  private noise = new Simplex2(4242);

  constructor(options: EnvOptions) {
    this.options = options;
    const tp = TIMES[options.time];
    const wp = WEATHER[options.weather];
    const elev = tp.sunElev * DEG;
    const az = tp.sunAz * DEG;
    // Azimuth measured clockwise from north (-Z).
    this.sunDir.set(Math.sin(az) * Math.cos(elev), Math.sin(elev), -Math.cos(az) * Math.cos(elev)).normalize();
    const mElev = 42 * DEG;
    const mAz = 200 * DEG;
    this.moonDir.set(Math.sin(mAz) * Math.cos(mElev), Math.sin(mElev), -Math.cos(mAz) * Math.cos(mElev)).normalize();
    this.lightDir.copy(options.time === 'night' ? this.moonDir : this.sunDir);
    this.night = tp.night;

    const grey = (c: Color, amt: number) => {
      const l = c.r * 0.3 + c.g * 0.55 + c.b * 0.15;
      c.r = lerp(c.r, l, amt);
      c.g = lerp(c.g, l, amt);
      c.b = lerp(c.b, l, amt);
      return c;
    };
    const dark = 1 - wp.desaturate * 0.45;
    this.sunColor.setHex(tp.sunColor);
    this.sunIntensity = tp.sunIntensity * wp.sunDim;
    this.zenith.setHex(tp.zenith);
    grey(this.zenith, wp.desaturate).multiplyScalar(dark);
    this.horizon.setHex(tp.horizon);
    grey(this.horizon, wp.desaturate * 0.9).multiplyScalar(lerp(1, dark, 0.6));
    this.fogColor.copy(this.horizon);
    this.hemiSky.setHex(tp.hemiSky);
    grey(this.hemiSky, wp.desaturate);
    this.hemiGround.setHex(tp.hemiGround);
    this.hemiIntensity = tp.hemiIntensity * lerp(1, 0.85, wp.desaturate);

    this.coverage = wp.coverage;
    this.cloudBase = wp.cloudBase;
    this.cloudThickness = wp.cloudThickness;
    this.visibility = wp.visibility;
    this.rain = wp.rain;
    // Exponential-squared fog reaching ~98 % at the visibility distance.
    this.fogDensity = 2.0 / wp.visibility;
    // Cloud colour: lit by sun colour, greyer in bad weather, dark at night.
    _c.setHex(0xffffff).lerp(this.sunColor, options.time === 'day' ? 0.1 : 0.45);
    _g.setRGB(0.55, 0.57, 0.6);
    this.cloudColor.copy(_c).lerp(_g, wp.desaturate * 0.8);
    if (options.time === 'night') this.cloudColor.setRGB(0.07, 0.08, 0.11);

    this.windSpeed = options.windSpeed ?? wp.wind;
    this.windFrom = options.windFrom ?? 250;
    const toDir = (this.windFrom + 180) * DEG;
    this.wind.set(Math.sin(toDir), 0, -Math.cos(toDir)).multiplyScalar(this.windSpeed);
    this.gust = wp.gust * (this.windSpeed / Math.max(wp.wind, 0.1));
    this.turbulence = wp.turbulence;
  }

  /**
   * Wind at a position/time including gusts and turbulence (m/s). Turbulence is
   * stronger near the ground (mechanical) and inside clouds.
   */
  sampleWind(pos: Vector3, agl: number, time: number, out: Vector3): Vector3 {
    const n = this.noise;
    // Wind shear: weaker near the ground.
    const shear = Math.min(1, 0.55 + Math.log10(Math.max(agl, 1) + 1) * 0.25);
    out.copy(this.wind).multiplyScalar(shear);
    const gust = this.gust * Math.max(0, n.noise(time * 0.12, 3.3) * 0.8 + n.noise(time * 0.41, 7.1) * 0.4);
    if (this.windSpeed > 0.1) out.addScaledVector(this.wind, gust / this.windSpeed);
    const inCloud = pos.y > this.cloudBase && pos.y < this.cloudBase + this.cloudThickness ? this.coverage : 0;
    const lowLevel = agl < 300 ? (1 - agl / 300) * 0.6 * (this.windSpeed / 8) : 0;
    const t = this.turbulence * (0.35 + inCloud * 1.2 + lowLevel);
    if (t > 0) {
      const s = 0.015;
      out.x += t * 2.2 * n.noise(pos.x * s + time * 0.9, pos.z * s);
      out.y += t * 1.8 * n.noise(pos.z * s - time * 1.1, pos.y * s + 9);
      out.z += t * 2.2 * n.noise(pos.y * s + 5, pos.x * s + time * 0.8);
    }
    return out;
  }

  /** Headwind/crosswind components for a runway heading (deg). Positive headwind = from ahead. */
  runwayWind(headingDeg: number): { headwind: number; crosswind: number } {
    const rel = (this.windFrom - headingDeg) * DEG;
    return { headwind: Math.cos(rel) * this.windSpeed, crosswind: Math.sin(rel) * this.windSpeed };
  }
}
