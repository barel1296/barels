/** DOM menu screens. */
import { AIRCRAFT, getAircraft, type AircraftSpec } from '../aircraft/specs';
import type { MissionDef, MissionResult } from '../game/Missions';
import type { Settings, Store } from '../game/Settings';
import type { TimeOfDay, WeatherKind } from '../world/Environment';
import { KTS_PER_MS } from '../core/math';

export interface FreeFlightConfig {
  aircraft: string;
  location: string;
  time: TimeOfDay;
  weather: WeatherKind;
  windSpeed: number;
  windFrom: number;
}

export const LOCATIONS: { id: string; label: string }[] = [
  { id: 'HBR-09', label: 'Harbor International — Runway 09' },
  { id: 'HBR-27', label: 'Harbor International — Runway 27' },
  { id: 'NFD-36', label: 'North Field — Runway 36' },
  { id: 'EGL-05', label: 'Eagle Peak Strip — Runway 05' },
  { id: 'GUL-14', label: 'Gull Island — Runway 14' },
  { id: 'AIR-ISLAND', label: 'In flight — over the island (5000 ft)' },
  { id: 'AIR-CITY', label: 'In flight — over Port Harbor (2000 ft)' },
  { id: 'AIR-FINAL', label: 'Final approach — Harbor Intl RWY 27' },
];

export interface MenuCallbacks {
  startFreeFlight(cfg: FreeFlightConfig): void;
  startMission(id: string, aircraft: string): void;
  resume(): void;
  restart(): void;
  exitToMenu(): void;
  applySettings(s: Settings): void;
  previewAircraft(id: string): void;
  resetProgress(): void;
  click(): void;
  nextMission(currentId: string): void;
}

const ICONS = { free: '✈', missions: '◎', hangar: '⛭', settings: '⚙', controls: '⌨', back: '←' };

function stars(n: number, max = 3): string {
  let s = '';
  for (let i = 0; i < max; i++) s += i < n ? '★' : '<span class="off">★</span>';
  return `<span class="stars">${s}</span>`;
}

function fmtTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function bars(spec: AircraftSpec): string {
  const row = (k: string, v: number) => `<div class="stat">${k}<div class="bar"><i style="width:${v * 20}%"></i></div></div>`;
  return row('Speed', spec.stats.speed) + row('Agility', spec.stats.agility) + row('Handling', spec.stats.handling) + row('Range', spec.stats.range);
}

export class Menus {
  private el: HTMLDivElement;
  private ff: FreeFlightConfig;
  current = '';
  private backStack: (() => void)[] = [];

  constructor(
    private root: HTMLElement,
    private store: Store,
    private missions: MissionDef[],
    private cb: MenuCallbacks,
  ) {
    this.el = document.createElement('div');
    this.root.appendChild(this.el);
    this.ff = {
      aircraft: store.data.lastAircraft,
      location: 'HBR-09',
      time: 'day',
      weather: 'clear',
      windSpeed: 4,
      windFrom: 250,
    };
  }

  get visible(): boolean {
    return this.el.innerHTML !== '';
  }

  hide(): void {
    this.el.innerHTML = '';
    this.current = '';
  }

  private set(html: string, name: string): HTMLElement {
    this.el.innerHTML = html;
    this.current = name;
    const first = this.el.querySelector<HTMLButtonElement>('button.primary, .menu-main button');
    first?.focus({ preventScroll: true });
    this.el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => this.cb.click()));
    return this.el.firstElementChild as HTMLElement;
  }

  private on(sel: string, fn: (el: HTMLElement) => void): void {
    this.el.querySelectorAll<HTMLElement>(sel).forEach((e) => e.addEventListener('click', () => fn(e)));
  }

  /** Escape / back navigation. Returns true if handled. */
  back(): boolean {
    const f = this.backStack.pop();
    if (f) {
      f();
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------- loading

  showLoading(p: number, label: string): void {
    if (this.current !== 'loading') {
      this.set(
        `<div class="screen loading">
          <div class="logo"><div class="t1">AEROPLANE<br/>SIMULATOR</div><div class="t2">FLIGHT · EXPLORE · LAND</div></div>
          <div class="progress"><i id="lp"></i></div>
          <div class="label" id="ll"></div>
        </div>`,
        'loading',
      );
    }
    (this.el.querySelector('#lp') as HTMLElement).style.width = `${Math.round(p * 100)}%`;
    (this.el.querySelector('#ll') as HTMLElement).textContent = label;
  }

  // ------------------------------------------------------------- main

  showMain(): void {
    this.backStack = [];
    const c = this.store.data.career;
    const hrs = c.flightTime / 3600;
    this.set(
      `<div class="screen transparent">
        <div class="menu-main">
          <div class="logo"><div class="t1">AEROPLANE<br/>SIMULATOR</div><div class="t2">FLIGHT · EXPLORE · LAND</div></div>
          <button class="primary" data-go="free"><span class="ico">${ICONS.free}</span>Free Flight</button>
          <button data-go="missions"><span class="ico">${ICONS.missions}</span>Missions</button>
          <button data-go="hangar"><span class="ico">${ICONS.hangar}</span>Hangar</button>
          <button data-go="settings"><span class="ico">${ICONS.settings}</span>Settings</button>
          <button data-go="controls"><span class="ico">${ICONS.controls}</span>Controls</button>
          <div class="career">
            <div><b>${hrs >= 1 ? hrs.toFixed(1) + ' h' : Math.round(c.flightTime / 60) + ' min'}</b><span>Flight time</span></div>
            <div><b>${c.landings}</b><span>Landings</span></div>
            <div><b>${Math.round(c.distance / 1852)} NM</b><span>Distance</span></div>
          </div>
          <div class="footer-note">Tip: press <kbd>F1</kbd> in flight for the controls. Gamepads and touch screens are supported.</div>
        </div>
      </div>`,
      'main',
    );
    this.on('[data-go]', (e) => {
      const go = e.dataset.go;
      if (go === 'free') this.showFreeFlight();
      if (go === 'missions') this.showMissions();
      if (go === 'hangar') this.showHangar();
      if (go === 'settings') this.showSettings(() => this.showMain());
      if (go === 'controls') this.showControls(() => this.showMain());
    });
    this.cb.previewAircraft(this.ff.aircraft);
  }

  // ------------------------------------------------------------- free flight

  showFreeFlight(): void {
    this.backStack = [() => this.showMain()];
    const ff = this.ff;
    const seg = (name: string, opts: [string, string][], val: string) =>
      `<div class="seg" data-seg="${name}">${opts.map(([v, l]) => `<button data-v="${v}" class="${v === val ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    this.set(
      `<div class="screen"><div class="panel">
        <div class="row"><h2>Free Flight</h2><div class="spacer"></div><button data-back>${ICONS.back} Back</button></div>
        <p class="subtitle">Choose your aircraft, where to start and the conditions. The island is yours.</p>
        <div class="section-title">Aircraft</div>
        <div class="cards" id="acards">
          ${AIRCRAFT.map((a) => `<div class="card ${a.id === ff.aircraft ? 'on' : ''}" data-ac="${a.id}"><div class="role">${a.role}</div><h3>${a.name}</h3>${bars(a)}</div>`).join('')}
        </div>
        <div class="grid2">
          <div>
            <div class="section-title">Starting position</div>
            <label class="field"><select id="loc">${LOCATIONS.map((l) => `<option value="${l.id}" ${l.id === ff.location ? 'selected' : ''}>${l.label}</option>`).join('')}</select></label>
            <div class="section-title">Time of day</div>
            ${seg('time', [['dawn', 'Dawn'], ['day', 'Day'], ['sunset', 'Sunset'], ['night', 'Night']], ff.time)}
          </div>
          <div>
            <div class="section-title">Weather</div>
            ${seg('weather', [['clear', 'Clear'], ['cloudy', 'Cloudy'], ['overcast', 'Overcast'], ['storm', 'Storm']], ff.weather)}
            <div class="section-title">Wind</div>
            <label class="field">Speed: <b id="wsv">${Math.round(ff.windSpeed * KTS_PER_MS)} kt</b><input type="range" id="ws" min="0" max="15" step="1" value="${ff.windSpeed}"></label>
            <label class="field">From: <b id="wdv">${ff.windFrom}°</b><input type="range" id="wd" min="0" max="350" step="10" value="${ff.windFrom}"></label>
          </div>
        </div>
        <div class="row" style="margin-top:8px"><div class="spacer"></div><button class="primary" id="go">Take off ✈</button></div>
      </div></div>`,
      'free',
    );
    this.on('[data-back]', () => this.showMain());
    this.on('[data-ac]', (e) => {
      ff.aircraft = e.dataset.ac!;
      this.el.querySelectorAll('[data-ac]').forEach((c) => c.classList.toggle('on', c === e));
      this.cb.previewAircraft(ff.aircraft);
    });
    this.el.querySelectorAll<HTMLElement>('[data-seg]').forEach((s) => {
      s.querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
        b.addEventListener('click', () => {
          s.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
          (ff as unknown as Record<string, string>)[s.dataset.seg!] = b.dataset.v!;
        }),
      );
    });
    const loc = this.el.querySelector<HTMLSelectElement>('#loc')!;
    loc.addEventListener('change', () => (ff.location = loc.value));
    const ws = this.el.querySelector<HTMLInputElement>('#ws')!;
    ws.addEventListener('input', () => {
      ff.windSpeed = Number(ws.value);
      this.el.querySelector('#wsv')!.textContent = `${Math.round(ff.windSpeed * KTS_PER_MS)} kt`;
    });
    const wd = this.el.querySelector<HTMLInputElement>('#wd')!;
    wd.addEventListener('input', () => {
      ff.windFrom = Number(wd.value);
      this.el.querySelector('#wdv')!.textContent = `${ff.windFrom}°`;
    });
    this.on('#go', () => {
      this.store.data.lastAircraft = ff.aircraft;
      this.store.save();
      this.cb.startFreeFlight({ ...ff });
    });
    this.cb.previewAircraft(ff.aircraft);
  }

  // ------------------------------------------------------------- missions

  showMissions(): void {
    this.backStack = [() => this.showMain()];
    const diff = (d: number) => '●'.repeat(d) + '○'.repeat(3 - d);
    this.set(
      `<div class="screen"><div class="panel">
        <div class="row"><h2>Missions</h2><div class="spacer"></div><button data-back>${ICONS.back} Back</button></div>
        <p class="subtitle">Training, races, precision landings and challenges. Earn up to three stars on each.</p>
        <div class="cards">
          ${this.missions
            .map((m) => {
              const r = this.store.record(m.id);
              return `<div class="card" data-m="${m.id}">
                <div class="row"><span class="badge">${m.category}</span><span class="badge" title="Difficulty">${diff(m.difficulty)}</span></div>
                <h3 style="margin-top:8px">${m.title}</h3>
                <p>${m.description}</p>
                <div class="row"><span>${stars(r.stars)}</span><div class="spacer"></div><span style="font-size:12px;color:var(--muted)">${r.bestScore ? 'Best ' + r.bestScore : getAircraft(m.aircraft).name}</span></div>
              </div>`;
            })
            .join('')}
        </div>
      </div></div>`,
      'missions',
    );
    this.on('[data-back]', () => this.showMain());
    this.on('[data-m]', (e) => this.showBriefing(e.dataset.m!));
  }

  showBriefing(id: string): void {
    const m = this.missions.find((x) => x.id === id)!;
    this.backStack = [() => this.showMissions()];
    const r = this.store.record(id);
    const allowed = m.allowedAircraft ?? [m.aircraft];
    let chosen = m.aircraft;
    const cond = `${m.time[0].toUpperCase() + m.time.slice(1)} · ${m.weather[0].toUpperCase() + m.weather.slice(1)}${m.wind ? ` · Wind ${String(m.wind.from).padStart(3, '0')}° at ${Math.round(m.wind.speed * KTS_PER_MS)} kt` : ''}`;
    this.set(
      `<div class="screen"><div class="panel">
        <div class="row"><div><span class="badge">${m.category}</span></div><div class="spacer"></div><button data-back>${ICONS.back} Missions</button></div>
        <h2 style="margin-top:10px">${m.title}</h2>
        <p class="subtitle">${cond}</p>
        <p style="line-height:1.5">${m.description}</p>
        <div class="grid2">
          <div>
            <div class="section-title">Objectives</div>
            <ol style="margin:0;padding-left:20px;line-height:1.7;color:var(--muted)">
              ${m.stages.map((s) => `<li>${s.type === 'takeoff' ? 'Take off' : s.type === 'altitude' ? `Climb to ${Math.round(s.agl * 3.28)} ft AGL` : s.type === 'rings' ? `Fly through ${s.rings.length} rings` : s.type === 'waypoint' ? `Reach ${s.label}` : `Land at ${s.airport}${s.end !== undefined ? '' : ' (any runway)'} and stop`}</li>`).join('')}
            </ol>
            <div class="section-title">Tips</div>
            <ul style="margin:0;padding-left:20px;line-height:1.6;color:var(--muted)">${m.tips.map((t) => `<li>${t}</li>`).join('')}</ul>
          </div>
          <div>
            <div class="section-title">Aircraft</div>
            <div class="cards" style="grid-template-columns:1fr">
              ${allowed.map((a) => `<div class="card ${a === chosen ? 'on' : ''}" data-ac="${a}"><div class="role">${getAircraft(a).role}</div><h3>${getAircraft(a).name}</h3></div>`).join('')}
            </div>
            <div class="section-title">Your record</div>
            <div class="kv"><span>Stars</span><span>${stars(r.stars)}</span><span>Best score</span><span>${r.bestScore || '—'}</span><span>Best time</span><span>${r.bestTime ? fmtTime(r.bestTime) : '—'}</span></div>
          </div>
        </div>
        <div class="row" style="margin-top:18px"><div class="spacer"></div><button class="primary" id="go">Start mission</button></div>
      </div></div>`,
      'briefing',
    );
    this.on('[data-back]', () => this.showMissions());
    this.on('[data-ac]', (e) => {
      chosen = e.dataset.ac!;
      this.el.querySelectorAll('[data-ac]').forEach((c) => c.classList.toggle('on', c === e));
      this.cb.previewAircraft(chosen);
    });
    this.on('#go', () => this.cb.startMission(id, chosen));
    this.cb.previewAircraft(chosen);
  }

  // ------------------------------------------------------------- hangar

  showHangar(selected = this.ff.aircraft): void {
    this.backStack = [() => this.showMain()];
    const a = getAircraft(selected);
    const kt = (v: number) => `${Math.round(v * KTS_PER_MS)} kt`;
    this.set(
      `<div class="screen transparent"><div class="panel" style="width:min(520px,100%);margin-left:max(0px,4vw)">
        <div class="row"><h2>Hangar</h2><div class="spacer"></div><button data-back>${ICONS.back} Back</button></div>
        <div class="seg" style="margin:10px 0 14px">${AIRCRAFT.map((x) => `<button data-ac="${x.id}" class="${x.id === a.id ? 'on' : ''}">${x.name.split(' ')[0]}</button>`).join('')}</div>
        <div class="role" style="color:var(--accent);font-weight:700;font-size:12px;letter-spacing:.08em;text-transform:uppercase">${a.role}</div>
        <h3 style="margin:4px 0 6px;font-size:22px">${a.name}</h3>
        <p style="color:var(--muted);line-height:1.5;margin-top:0">${a.description}</p>
        ${bars(a)}
        <div class="section-title">Specifications</div>
        <div class="kv">
          <span>Max weight</span><span>${(a.emptyMass + a.fuelCapacity).toLocaleString()} kg</span>
          <span>Wingspan</span><span>${a.wingSpan.toFixed(1)} m</span>
          <span>Engine</span><span>${a.engine.type === 'piston' ? `${Math.round(a.engine.maxPower / 745.7)} hp piston` : `${a.engine.count}× ${Math.round(a.engine.staticThrust / a.engine.count / 1000)} kN jet${a.engine.afterburnerThrust ? ' + AB' : ''}`}</span>
          <span>Stall speed</span><span>${kt(a.speeds.stall)}</span>
          <span>Cruise</span><span>${kt(a.speeds.cruise)}</span>
          <span>Never exceed</span><span>${kt(a.limits.vne)}</span>
          <span>G limits</span><span>+${a.limits.gMax} / ${a.limits.gMin}</span>
          <span>Landing gear</span><span>${a.gear.retractable ? 'Retractable' : 'Fixed'}</span>
          <span>Extras</span><span>${[a.hasSmoke ? 'Smoke' : '', a.speedbrake ? (a.speedbrake.groundSpoilers ? 'Spoilers' : 'Speedbrake') : '', a.engine.afterburnerThrust ? 'Afterburner' : ''].filter(Boolean).join(', ') || '—'}</span>
        </div>
        <div class="row" style="margin-top:16px"><div class="spacer"></div><button class="primary" id="fly">Fly this aircraft</button></div>
      </div></div>`,
      'hangar',
    );
    this.on('[data-back]', () => this.showMain());
    this.on('[data-ac]', (e) => this.showHangar(e.dataset.ac!));
    this.on('#fly', () => {
      this.ff.aircraft = a.id;
      this.showFreeFlight();
    });
    this.cb.previewAircraft(a.id);
  }

  // ------------------------------------------------------------- settings

  showSettings(onBack: () => void): void {
    this.backStack = [onBack];
    const s = { ...this.store.settings };
    const seg = (name: keyof Settings, opts: [string, string][]) =>
      `<div class="seg" data-set="${name}">${opts.map(([v, l]) => `<button data-v="${v}" class="${String(s[name]) === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    this.set(
      `<div class="screen"><div class="panel" style="width:min(640px,100%)">
        <div class="row"><h2>Settings</h2><div class="spacer"></div><button data-back>${ICONS.back} Back</button></div>
        <div class="section-title">Graphics</div>
        <div class="toggle"><span>Quality</span>${seg('quality', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']])}</div>
        <div class="toggle"><span>Show FPS</span>${seg('showFps', [['false', 'Off'], ['true', 'On']])}</div>
        <div class="section-title">Flight</div>
        <div class="toggle"><span>Flight model<br/><small style="color:var(--muted)">Easy: fly-by-wire with stall &amp; G protection</small></span>${seg('assist', [['easy', 'Easy'], ['realistic', 'Realistic']])}</div>
        <div class="toggle"><span>Invert pitch</span>${seg('invertPitch', [['false', 'Off'], ['true', 'On']])}</div>
        <div class="toggle"><span>Control sensitivity</span><input type="range" id="sens" min="0.5" max="1.6" step="0.1" value="${s.sensitivity}" style="width:180px"></div>
        <div class="toggle"><span>Units</span>${seg('units', [['imperial', 'kt / ft'], ['metric', 'km/h / m']])}</div>
        <div class="toggle"><span>HUD style</span>${seg('hud', [['full', 'HUD'], ['instruments', 'Gauges'], ['minimal', 'Minimal']])}</div>
        <div class="toggle"><span>Touch controls</span>${seg('touchControls', [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']])}</div>
        <div class="section-title">Audio</div>
        <div class="toggle"><span>Master volume</span><input type="range" id="vol" min="0" max="1" step="0.05" value="${s.volume}" style="width:180px"></div>
        <div class="toggle"><span>Mute</span>${seg('muted', [['false', 'Off'], ['true', 'On']])}</div>
        <div class="section-title">Progress</div>
        <div class="row"><button class="danger" id="reset">Reset all progress</button></div>
      </div></div>`,
      'settings',
    );
    const commit = () => {
      Object.assign(this.store.data.settings, s);
      this.store.save();
      this.cb.applySettings(this.store.settings);
    };
    this.el.querySelectorAll<HTMLElement>('[data-set]').forEach((g) => {
      g.querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
        b.addEventListener('click', () => {
          g.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
          const key = g.dataset.set as keyof Settings;
          const v = b.dataset.v!;
          (s as unknown as Record<string, unknown>)[key] = v === 'true' ? true : v === 'false' ? false : v;
          commit();
        }),
      );
    });
    const vol = this.el.querySelector<HTMLInputElement>('#vol')!;
    vol.addEventListener('input', () => {
      s.volume = Number(vol.value);
      commit();
    });
    const sens = this.el.querySelector<HTMLInputElement>('#sens')!;
    sens.addEventListener('input', () => {
      s.sensitivity = Number(sens.value);
      commit();
    });
    this.on('[data-back]', () => onBack());
    this.on('#reset', (b) => {
      if (b.dataset.confirm) {
        this.cb.resetProgress();
        b.textContent = 'Progress reset';
      } else {
        b.dataset.confirm = '1';
        b.textContent = 'Click again to confirm';
      }
    });
  }

  // ------------------------------------------------------------- controls

  showControls(onBack: () => void): void {
    this.backStack = [onBack];
    const k = (...keys: string[]) => keys.map((x) => `<kbd>${x}</kbd>`).join(' ');
    const rows: [string, string][] = [
      ['Pitch (nose down / up)', k('W', 'S') + ' or ' + k('↑', '↓')],
      ['Roll left / right', k('A', 'D') + ' or ' + k('←', '→')],
      ['Rudder / nose-wheel steering', k('Q', 'E')],
      ['Throttle up / down', k('R', 'F') + ' or ' + k('Shift') + ' / ' + k('PgUp', 'PgDn')],
      ['Set throttle 0–100 %', k('0') + '–' + k('9')],
      ['Wheel brakes (hold)', k('Space')],
      ['Parking brake', k('N')],
      ['Landing gear', k('G')],
      ['Flaps up / down / cycle', k('[', ']') + ' / ' + k('V')],
      ['Speedbrake / spoilers', k('X')],
      ['Autopilot (heading, altitude, speed)', k('Z')],
      ['Elevator trim (realistic model)', k(',', '.')],
      ['Engine start / stop', k('I')],
      ['Lights', k('L')],
      ['Smoke system', k('K')],
      ['Change camera', k('C') + ' · drag mouse to look · wheel to zoom'],
      ['Look back (hold)', k('B')],
      ['HUD style', k('H')],
      ['Navigation map', k('M')],
      ['Mute', k('U')],
      ['Pause / menu', k('P') + ' or ' + k('Esc')],
      ['Restart flight', k('Backspace')],
    ];
    this.set(
      `<div class="screen"><div class="panel" style="width:min(760px,100%)">
        <div class="row"><h2>Controls</h2><div class="spacer"></div><button data-back>${ICONS.back} Back</button></div>
        <div class="grid2">
          <div><div class="section-title">Keyboard</div><table class="keys">${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table></div>
          <div>
            <div class="section-title">Gamepad</div>
            <table class="keys">
              <tr><td>Pitch &amp; roll</td><td>Left stick</td></tr>
              <tr><td>Look around</td><td>Right stick</td></tr>
              <tr><td>Throttle up / down</td><td>RT / LT</td></tr>
              <tr><td>Rudder</td><td>LB / RB</td></tr>
              <tr><td>Gear / Flaps</td><td>A / B</td></tr>
              <tr><td>Brakes (hold)</td><td>X</td></tr>
              <tr><td>Camera</td><td>Y</td></tr>
              <tr><td>Autopilot / Lights</td><td>D-pad ↑ / ↓</td></tr>
              <tr><td>HUD / Smoke</td><td>D-pad ← / →</td></tr>
              <tr><td>Map / Pause</td><td>Back / Start</td></tr>
              <tr><td>Speedbrake</td><td>Left stick click</td></tr>
            </table>
            <div class="section-title">Touch</div>
            <p style="color:var(--muted);line-height:1.5;margin:0">Left stick flies the aircraft, the lever on the right sets the throttle, and the buttons handle gear, flaps, autopilot, camera and brakes.</p>
            <div class="section-title">Flying tips</div>
            <ul style="color:var(--muted);line-height:1.6;margin:0;padding-left:18px">
              <li>Take off: full power, keep straight with Q/E, pull back gently at rotation speed.</li>
              <li>The <b>Easy</b> model holds your attitude when you let go of the stick.</li>
              <li>Land: slow down, flaps and gear down, follow the PAPI lights (2 white / 2 red).</li>
              <li>Watch the stall warning — lower the nose and add power to recover.</li>
            </ul>
          </div>
        </div>
      </div></div>`,
      'controls',
    );
    this.on('[data-back]', () => onBack());
  }

  // ------------------------------------------------------------- in flight

  showPause(isMission: boolean, title: string): void {
    this.backStack = [() => this.cb.resume()];
    this.set(
      `<div class="screen"><div class="panel narrow">
        <h2>Paused</h2><p class="subtitle">${title}</p>
        <div style="display:flex;flex-direction:column;gap:10px">
          <button class="primary" data-a="resume">Resume</button>
          <button data-a="restart">${isMission ? 'Restart mission' : 'Restart flight'}</button>
          <button data-a="settings">Settings</button>
          <button data-a="controls">Controls</button>
          <button data-a="exit">Exit to main menu</button>
        </div>
      </div></div>`,
      'pause',
    );
    this.on('[data-a]', (e) => {
      const a = e.dataset.a;
      if (a === 'resume') this.cb.resume();
      if (a === 'restart') this.cb.restart();
      if (a === 'settings') this.showSettings(() => this.showPause(isMission, title));
      if (a === 'controls') this.showControls(() => this.showPause(isMission, title));
      if (a === 'exit') this.cb.exitToMenu();
    });
  }

  showResult(opts: {
    title: string;
    success: boolean;
    reason: string;
    missionId: string | null;
    result: MissionResult | null;
    newBest: boolean;
    stats: { label: string; value: string }[];
    hasNext: boolean;
  }): void {
    this.backStack = [() => this.cb.exitToMenu()];
    const r = opts.result;
    this.set(
      `<div class="screen"><div class="panel narrow" style="width:min(520px,100%)">
        <p class="subtitle" style="margin:0 0 6px">${opts.title}</p>
        <h2 class="result-title ${opts.success ? 'good' : 'bad'}">${opts.success ? (opts.missionId ? 'Mission complete' : 'Flight complete') : opts.missionId ? 'Mission failed' : 'Crashed!'}</h2>
        <p style="color:var(--muted);margin:6px 0 10px">${opts.reason}</p>
        ${r && opts.success ? `<div class="big-stars">${stars(r.stars)}</div><div class="score">${r.score} pts ${opts.newBest ? '<span class="badge" style="color:#fbbf24;border-color:#fbbf24">NEW BEST</span>' : ''}</div>` : ''}
        ${r && r.breakdown.length ? `<div class="section-title">Score breakdown</div><div class="kv">${r.breakdown.map((b) => `<span>${b.label} <small style="opacity:.7">(${b.value})</small></span><span>${b.points >= 0 ? '+' : ''}${b.points}</span>`).join('')}</div>` : ''}
        ${opts.stats.length ? `<div class="section-title">Flight</div><div class="kv">${opts.stats.map((s) => `<span>${s.label}</span><span>${s.value}</span>`).join('')}</div>` : ''}
        <div class="row" style="margin-top:18px">
          <button data-a="menu">Main menu</button>
          <div class="spacer"></div>
          <button data-a="retry" class="${opts.success ? '' : 'primary'}">${opts.missionId ? 'Retry' : 'Fly again'}</button>
          ${opts.success && opts.hasNext ? '<button class="primary" data-a="next">Next mission</button>' : ''}
        </div>
      </div></div>`,
      'result',
    );
    this.on('[data-a]', (e) => {
      const a = e.dataset.a;
      if (a === 'menu') this.cb.exitToMenu();
      if (a === 'retry') this.cb.restart();
      if (a === 'next' && opts.missionId) this.cb.nextMission(opts.missionId);
    });
  }
}
