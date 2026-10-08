/**
 * Fully procedural Web Audio sound: engines, wind, warnings and one-shot effects.
 * No audio files are required.
 */
import type { EngineType } from '../aircraft/specs';
import { clamp } from '../core/math';

export type Sfx =
  | 'click'
  | 'gear'
  | 'flaps'
  | 'touchdown'
  | 'crash'
  | 'splash'
  | 'chime'
  | 'success'
  | 'fail'
  | 'apOn'
  | 'apOff'
  | 'toggle'
  | 'countdown';

export interface AudioParams {
  /** Engine spool 0..1. */
  spool: number;
  rpm: number;
  throttle: number;
  afterburner: boolean;
  running: boolean;
  airspeed: number;
  stallWarning: boolean;
  pullUp: boolean;
  overspeed: boolean;
  gearWarning: boolean;
  cockpit: boolean;
  /** Camera distance from the aircraft (m). */
  distance: number;
  paused: boolean;
}

interface EngineVoice {
  type: EngineType;
  out: GainNode;
  filter: BiquadFilterNode;
  update(p: AudioParams, t: number): void;
  stop(): void;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private env!: GainNode;
  private noise!: AudioBuffer;
  private engine: EngineVoice | null = null;
  private wind: { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode } | null = null;
  private stall: { osc: OscillatorNode; gain: GainNode } | null = null;
  private warn: { osc: OscillatorNode; gain: GainNode } | null = null;
  private clack: { osc: OscillatorNode; gain: GainNode } | null = null;
  private volume = 0.8;
  private muted = false;
  private engineType: EngineType = 'piston';
  private engineCount = 1;

  get ready(): boolean {
    return !!this.ctx;
  }

  /** Must be called from a user gesture. */
  init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    this.sfxBus = ctx.createGain();
    this.sfxBus.connect(this.master);
    this.env = ctx.createGain();
    this.env.connect(this.master);
    // Shared white-noise buffer.
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.buildWind();
    this.buildWarnings();
    this.setEngine(this.engineType, this.engineCount);
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) void this.ctx.suspend();
      else void this.ctx.resume();
    });
  }

  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1);
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.setVolume(this.volume);
  }

  get isMuted(): boolean {
    return this.muted;
  }

  private noiseSource(): AudioBufferSourceNode {
    const s = this.ctx!.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.loopStart = Math.random();
    return s;
  }

  private buildWind(): void {
    const ctx = this.ctx!;
    const src = this.noiseSource();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 400;
    filter.Q.value = 0.7;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(this.env);
    src.start();
    this.wind = { src, filter, gain };
  }

  private buildWarnings(): void {
    const ctx = this.ctx!;
    const mk = (type: OscillatorType, f: number) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = f;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(this.master);
      osc.start();
      return { osc, gain };
    };
    this.stall = mk('square', 420);
    this.warn = mk('sine', 760);
    this.clack = mk('square', 1400);
  }

  setEngine(type: EngineType, count: number): void {
    this.engineType = type;
    this.engineCount = count;
    if (!this.ctx) return;
    this.engine?.stop();
    this.engine = type === 'piston' ? this.pistonVoice() : this.jetVoice(count);
  }

  private pistonVoice(): EngineVoice {
    const ctx = this.ctx!;
    const out = ctx.createGain();
    out.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 800;
    out.connect(filter).connect(this.env);
    const mix = ctx.createGain();
    mix.connect(out);
    const o1 = ctx.createOscillator();
    o1.type = 'sawtooth';
    const o2 = ctx.createOscillator();
    o2.type = 'square';
    const g1 = ctx.createGain();
    g1.gain.value = 0.32;
    const g2 = ctx.createGain();
    g2.gain.value = 0.16;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 600;
    tone.Q.value = 2;
    o1.connect(g1).connect(tone);
    o2.connect(g2).connect(tone);
    // Chug: amplitude modulation at half the firing frequency.
    const am = ctx.createGain();
    am.gain.value = 0.7;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.3;
    lfo.connect(lfoDepth).connect(am.gain);
    tone.connect(am).connect(mix);
    // Prop wash noise.
    const n = this.noiseSource();
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.Q.value = 0.8;
    const ng = ctx.createGain();
    ng.gain.value = 0.15;
    n.connect(nf).connect(ng).connect(mix);
    o1.start();
    o2.start();
    lfo.start();
    n.start();
    return {
      type: 'piston',
      out,
      filter,
      update: (p, t) => {
        const f = Math.max(8, (p.rpm / 60) * 2);
        o1.frequency.setTargetAtTime(f, t, 0.05);
        o2.frequency.setTargetAtTime(f * 0.5, t, 0.05);
        lfo.frequency.setTargetAtTime(f * 0.5, t, 0.05);
        tone.frequency.setTargetAtTime(250 + 1400 * p.throttle * p.spool + f * 2, t, 0.08);
        nf.frequency.setTargetAtTime(300 + p.rpm * 0.4, t, 0.08);
        ng.gain.setTargetAtTime(0.06 + 0.22 * p.throttle, t, 0.1);
        const level = p.running ? 0.18 + 0.32 * p.spool : clamp(p.rpm / 2000, 0, 0.12);
        out.gain.setTargetAtTime(level, t, 0.08);
      },
      stop: () => {
        [o1, o2, lfo].forEach((o) => o.stop());
        n.stop();
        out.disconnect();
      },
    };
  }

  private jetVoice(count: number): EngineVoice {
    const ctx = this.ctx!;
    const out = ctx.createGain();
    out.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 6000;
    out.connect(filter).connect(this.env);
    // Rumble.
    const n1 = this.noiseSource();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 500;
    const rg = ctx.createGain();
    n1.connect(lp).connect(rg).connect(out);
    // Hiss.
    const n2 = this.noiseSource();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2500;
    bp.Q.value = 0.9;
    const hg = ctx.createGain();
    n2.connect(bp).connect(hg).connect(out);
    // Turbine whine.
    const w = ctx.createOscillator();
    w.type = 'sine';
    const w2 = ctx.createOscillator();
    w2.type = 'triangle';
    const wg = ctx.createGain();
    w.connect(wg);
    w2.connect(wg);
    wg.connect(out);
    // Afterburner roar.
    const n3 = this.noiseSource();
    const ab = ctx.createBiquadFilter();
    ab.type = 'lowpass';
    ab.frequency.value = 220;
    const ag = ctx.createGain();
    ag.gain.value = 0;
    n3.connect(ab).connect(ag).connect(out);
    [n1, n2, n3].forEach((s) => s.start());
    w.start();
    w2.start();
    const twin = count > 1;
    return {
      type: 'jet',
      out,
      filter,
      update: (p, t) => {
        const s = p.spool;
        lp.frequency.setTargetAtTime(180 + 900 * s * s, t, 0.1);
        rg.gain.setTargetAtTime(0.25 + 0.6 * s * s, t, 0.1);
        bp.frequency.setTargetAtTime(1200 + 3000 * s, t, 0.1);
        hg.gain.setTargetAtTime(0.05 + 0.22 * s * s, t, 0.1);
        w.frequency.setTargetAtTime(900 + 3800 * s, t, 0.1);
        w2.frequency.setTargetAtTime((900 + 3800 * s) * (twin ? 1.012 : 1.5), t, 0.1);
        wg.gain.setTargetAtTime((twin ? 0.035 : 0.022) * s, t, 0.1);
        ag.gain.setTargetAtTime(p.afterburner ? 1.4 : 0, t, 0.15);
        out.gain.setTargetAtTime(p.running || s > 0.05 ? 0.12 + 0.4 * s : 0, t, 0.1);
      },
      stop: () => {
        [n1, n2, n3].forEach((s) => s.stop());
        [w, w2].forEach((o) => o.stop());
        out.disconnect();
      },
    };
  }

  update(p: AudioParams): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    if (p.paused) {
      this.env.gain.setTargetAtTime(0, t, 0.05);
      this.stall!.gain.gain.setTargetAtTime(0, t, 0.02);
      this.warn!.gain.gain.setTargetAtTime(0, t, 0.02);
      this.clack!.gain.gain.setTargetAtTime(0, t, 0.02);
      return;
    }
    // Distance attenuation and muffling in external views; cockpit is muffled differently.
    const dist = Math.max(p.distance, 1);
    const att = p.cockpit ? 0.85 : clamp(30 / (dist + 10), 0.05, 1);
    this.env.gain.setTargetAtTime(att, t, 0.08);
    if (this.engine) {
      this.engine.update(p, t);
      const cut = p.cockpit ? (this.engine.type === 'piston' ? 900 : 1600) : clamp(9000 - dist * 25, 600, 9000);
      this.engine.filter.frequency.setTargetAtTime(cut, t, 0.1);
    }
    if (this.wind) {
      const v = p.airspeed;
      this.wind.filter.frequency.setTargetAtTime(200 + v * 12, t, 0.1);
      this.wind.gain.gain.setTargetAtTime(clamp((v / 110) ** 2, 0, 1) * (p.cockpit ? 0.35 : 0.6), t, 0.1);
    }
    const now = performance.now() / 1000;
    const beep = (rate: number, duty: number) => (now * rate) % 1 < duty;
    this.stall!.gain.gain.setTargetAtTime(p.stallWarning ? 0.08 : 0, t, 0.02);
    const pu = p.pullUp && beep(1.6, 0.5);
    this.warn!.osc.frequency.setTargetAtTime(beep(3.2, 0.5) ? 980 : 700, t, 0.005);
    this.warn!.gain.gain.setTargetAtTime(pu || (p.gearWarning && beep(1, 0.3)) ? 0.07 : 0, t, 0.01);
    this.clack!.gain.gain.setTargetAtTime(p.overspeed && beep(8, 0.25) ? 0.04 : 0, t, 0.005);
  }

  /** Play a one-shot sound effect. */
  play(name: Sfx): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const tone = (f: number, start: number, dur: number, type: OscillatorType = 'sine', vol = 0.15, f2?: number) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f, t + start);
      if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + start + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t + start);
      g.gain.linearRampToValueAtTime(vol, t + start + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + start + dur);
      o.connect(g).connect(this.sfxBus);
      o.start(t + start);
      o.stop(t + start + dur + 0.05);
    };
    const burst = (dur: number, type: BiquadFilterType, freq: number, vol: number, q = 1, start = 0, decay = true) => {
      const s = this.noiseSource();
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol, t + start);
      if (decay) g.gain.exponentialRampToValueAtTime(0.0001, t + start + dur);
      else g.gain.setValueAtTime(0, t + start + dur);
      s.connect(f).connect(g).connect(this.sfxBus);
      s.start(t + start);
      s.stop(t + start + dur + 0.05);
    };
    switch (name) {
      case 'click':
        burst(0.03, 'highpass', 3000, 0.25);
        break;
      case 'toggle':
        tone(1200, 0, 0.05, 'square', 0.05);
        burst(0.02, 'highpass', 4000, 0.15);
        break;
      case 'gear': {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(90, t);
        o.frequency.linearRampToValueAtTime(140, t + 2.2);
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 400;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.08, t + 0.2);
        g.gain.setValueAtTime(0.08, t + 2.2);
        g.gain.linearRampToValueAtTime(0, t + 2.6);
        o.connect(f).connect(g).connect(this.sfxBus);
        o.start(t);
        o.stop(t + 2.7);
        burst(0.25, 'lowpass', 180, 0.6, 1, 2.5);
        break;
      }
      case 'flaps':
        tone(320, 0, 0.9, 'sawtooth', 0.03, 380);
        break;
      case 'touchdown':
        burst(0.35, 'bandpass', 1400, 0.5, 1.2);
        burst(0.15, 'lowpass', 120, 0.7);
        break;
      case 'crash':
        burst(2.8, 'lowpass', 900, 1.2, 0.7);
        burst(1.2, 'lowpass', 200, 1.4, 0.7);
        tone(55, 0, 1.4, 'sine', 0.6, 30);
        burst(0.6, 'highpass', 2500, 0.4, 0.5, 0.1);
        break;
      case 'splash':
        burst(1.8, 'bandpass', 700, 0.9, 0.6);
        burst(0.8, 'lowpass', 300, 0.8);
        break;
      case 'chime':
        tone(784, 0, 0.25, 'sine', 0.14);
        tone(1175, 0.08, 0.35, 'sine', 0.12);
        break;
      case 'success':
        [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.12, 0.4, 'triangle', 0.13));
        break;
      case 'fail':
        [392, 330, 262].forEach((f, i) => tone(f, i * 0.18, 0.45, 'triangle', 0.13));
        break;
      case 'apOn':
        tone(880, 0, 0.12, 'sine', 0.1);
        tone(1320, 0.12, 0.18, 'sine', 0.1);
        break;
      case 'apOff':
        [1320, 990, 1320, 990].forEach((f, i) => tone(f, i * 0.14, 0.13, 'square', 0.05));
        break;
      case 'countdown':
        tone(660, 0, 0.15, 'square', 0.06);
        break;
    }
  }

  dispose(): void {
    this.engine?.stop();
    void this.ctx?.close();
    this.ctx = null;
  }
}
