import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

type Api = {
  state(): string;
  menu(): string;
  telemetry(): Record<string, number | boolean | string> | null;
  mission(): { stage: number; rings: number; state: string } | null;
  simulate(s: number, inp?: Record<string, number>): string;
  startFreeFlight(cfg: Record<string, unknown>): void;
  startMission(id: string, ac?: string): void;
  missions(): string[];
};

declare global {
  interface Window {
    __game: Api;
    __autoLand(code: string, end: number, max: number): { state: string; mission: { state: string } | null };
  }
}

async function boot(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/');
  await page.waitForFunction(() => window.__game?.state() === 'menu', null, { timeout: 180_000 });
  return errors;
}

async function waitFlying(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__game.state() === 'flying', null, { timeout: 180_000 });
}

test('boots to the main menu without errors', async ({ page }) => {
  const errors = await boot(page);
  await expect(page.locator('.logo .t1').first()).toContainText('AEROPLANE');
  await expect(page.getByRole('button', { name: /Free Flight/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Missions/ })).toBeVisible();
  expect(await page.evaluate(() => window.__game.missions().length)).toBeGreaterThanOrEqual(10);
  expect(errors).toEqual([]);
});

test('free flight: configure through the UI, take off and climb', async ({ page }) => {
  const errors = await boot(page);
  await page.getByRole('button', { name: /Free Flight/ }).click();
  await page.locator('[data-ac="kestrel"]').click();
  await page.locator('#loc').selectOption('HBR-09');
  await page.getByRole('button', { name: /Take off/ }).click();
  await waitFlying(page);
  const start = await page.evaluate(() => window.__game.telemetry());
  expect(start?.onGround).toBe(true);
  // Full power down the runway, rotate, then climb hands-off.
  await page.evaluate(() => window.__game.simulate(14, { throttle: 1 }));
  await page.evaluate(() => window.__game.simulate(2.5, { throttle: 1, pitch: 0.35 }));
  await page.evaluate(() => window.__game.simulate(15, { throttle: 1 }));
  const t = await page.evaluate(() => window.__game.telemetry());
  expect(t?.crashed).toBe(false);
  expect(t?.onGround).toBe(false);
  expect(Number(t?.altitude)).toBeGreaterThan(Number(start?.altitude) + 60);
  // The HUD canvas must have drawn something.
  const drawn = await page.evaluate(() => {
    const c = document.getElementById('hud') as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 0) n++;
    return n;
  });
  expect(drawn).toBeGreaterThan(50);
  expect(errors).toEqual([]);
});

test('keyboard controls drive the aircraft systems', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__game.startFreeFlight({ aircraft: 'falcon', location: 'AIR-ISLAND' }));
  await waitFlying(page);
  const gear0 = await page.evaluate(() => window.__game.telemetry()?.gearPos);
  expect(gear0).toBe(0);
  await page.keyboard.press('KeyG');
  await page.keyboard.press('BracketRight');
  await page.evaluate(() => window.__game.simulate(4, {}));
  const t = await page.evaluate(() => window.__game.telemetry());
  expect(Number(t?.gearPos)).toBeGreaterThan(0.5);
  expect(t?.flaps).toBe(1);
  // Hold R to add throttle over real frames.
  const thr0 = Number(t?.throttle);
  await page.keyboard.down('KeyR');
  await page.waitForFunction((v) => Number(window.__game.telemetry()?.throttle) > v + 0.05, thr0, { timeout: 60_000 });
  await page.keyboard.up('KeyR');
  // Camera cycling and HUD style toggles must not break the frame loop.
  await page.keyboard.press('KeyC');
  await page.keyboard.press('KeyH');
  await page.keyboard.press('KeyM');
  await page.evaluate(() => window.__game.simulate(1, {}));
  expect(await page.evaluate(() => window.__game.state())).toBe('flying');
});

test('pause menu pauses and resumes the flight', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__game.startFreeFlight({ aircraft: 'vortex', location: 'AIR-CITY' }));
  await waitFlying(page);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__game.state() === 'paused');
  await expect(page.getByRole('heading', { name: 'Paused' })).toBeVisible();
  await page.getByRole('button', { name: 'Resume' }).click();
  await page.waitForFunction(() => window.__game.state() === 'flying');
});

test('precision landing mission can be completed for three stars', async ({ page }) => {
  await page.addInitScript({ path: path.join(here, 'pilot.js') });
  await boot(page);
  await page.evaluate(() => window.__game.startMission('precision-landing', 'kestrel'));
  await waitFlying(page);
  const r = await page.evaluate(() => window.__autoLand('HBR', 1, 260));
  expect(r.mission?.state).toBe('success');
  await page.waitForFunction(() => window.__game.state() === 'result', null, { timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Mission complete' })).toBeVisible();
  await expect(page.locator('.big-stars .stars')).toBeVisible();
});

test('crashing ends the flight with a crash report', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__game.startFreeFlight({ aircraft: 'kestrel', location: 'AIR-ISLAND' }));
  await waitFlying(page);
  await page.evaluate(() => window.__game.simulate(60, { pitch: -1, throttle: 1 }));
  await page.waitForFunction(() => window.__game.state() === 'result', null, { timeout: 120_000 });
  await expect(page.getByRole('heading', { name: 'Crashed!' })).toBeVisible();
  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.waitForFunction(() => window.__game.state() === 'menu');
});

test('menus: missions, briefing, hangar and persistent settings', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: /Missions/ }).click();
  await expect(page.getByRole('heading', { name: 'Missions' })).toBeVisible();
  await page.locator('[data-m="supersonic-sprint"]').click();
  await expect(page.getByRole('heading', { name: 'Supersonic Sprint' })).toBeVisible();
  await page.getByRole('button', { name: /Missions/ }).click();
  await page.getByRole('button', { name: /Back/ }).click();
  await page.getByRole('button', { name: /Hangar/ }).click();
  await page.locator('.seg [data-ac="skyliner"]').click();
  await expect(page.locator('h3', { hasText: 'SkyLiner 320' })).toBeVisible();
  await page.getByRole('button', { name: /Back/ }).click();
  await page.getByRole('button', { name: /Settings/ }).click();
  await page.locator('[data-set="units"] [data-v="metric"]').click();
  await page.locator('[data-set="assist"] [data-v="realistic"]').click();
  await page.reload();
  await page.waitForFunction(() => window.__game?.state() === 'menu', null, { timeout: 180_000 });
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('aeroplane-sim:v1') ?? '{}').settings);
  expect(saved.units).toBe('metric');
  expect(saved.assist).toBe('realistic');
});
