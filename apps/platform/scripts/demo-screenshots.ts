/**
 * Captures every admin dashboard screen of a running local demo (`npm run demo`) in a real headless
 * Chromium: signs in with password + TOTP from the demo's credentials file, visits each page and
 * saves full-page PNGs to <out>/screenshots/. Pages that fail to load are listed at the end.
 *
 *   npm run demo:screenshots -- [--out <the demo's --out directory>]
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { totpAt } from '../src/lib/totp.js';

const i = process.argv.indexOf('--out');
const out = resolve(i >= 0 ? process.argv[i + 1]! : join(tmpdir(), 'golden-demo'));
const state = JSON.parse(readFileSync(join(out, 'demo-state.json'), 'utf8')) as { base: string; credentials: string; influencerId: string; novaId?: string; mia: string; pendingApproval: string; cloneSlug: string };
const creds = readFileSync(state.credentials, 'utf8');
const field = (label: string) => new RegExp(`^${label}:\\s*(.+)$`, 'm').exec(creds)?.[1]?.trim() ?? '';
const email = field('Email');
const password = field('Password');
const totpSecret = field('TOTP secret \\(add to an authenticator app\\)');
const dir = join(out, 'screenshots');
mkdirSync(dir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const problems: string[] = [];
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('401')) problems.push(`console: ${m.text()}`);
});

const shot = async (name: string) => {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
  console.log(`saved ${name}.png`);
};

await page.goto(`${state.base}/admin/`);
await page.waitForSelector('input[name=email]');
await shot('01-sign-in');
await page.fill('input[name=email]', email);
await page.fill('input[name=password]', password);
await page.fill('input[name=totp]', totpAt(totpSecret, Math.floor(Date.now() / 1000)));
await page.click('button[type=submit]');
await page.waitForSelector('h1:has-text("Overview")');

const influencers = (await page.evaluate(async () => (await fetch('/v1/influencers')).json())) as { id: string; slug: string }[];
const clone = influencers.find((x) => x.slug === state.cloneSlug);
const L = state.influencerId;
const screens: [string, string][] = [
  ['02-overview', '#/'],
  ['03-influencers', '#/influencers'],
  ['04-influencer', `#/influencer/${L}`],
  ['05-setup', `#/setup/${L}`],
  ['06-approvals', '#/approvals'],
  ['07-approval-detail', `#/approval/${state.pendingApproval}`],
  ['08-inbox', '#/inbox'],
  ['09-conversation', `#/conversation/${state.mia}`],
  ['10-escalations', '#/escalations'],
  ['11-calendar', `#/calendar/${L}`],
  ['12-media', `#/media/${L}`],
  ['13-agents', '#/agents'],
  ['14-money', `#/money/${L}`],
  ['15-analytics', `#/analytics/${L}`],
  ['16-engines', '#/engines'],
  ['17-ops', '#/ops'],
  ['18-users', '#/users'],
  ...(clone ? ([['19-setup-cloned-influencer', `#/setup/${clone.id}`], ['21-second-influencer', `#/influencer/${clone.id}`], ['22-second-influencer-money', `#/money/${clone.id}`]] as [string, string][]) : []),
];
for (const [name, hash] of screens) {
  await page.goto(`${state.base}/admin/${hash}`);
  await page.waitForSelector('#view h1');
  const notice = await page.locator('#view .notice:has-text("Could not load"), #view .notice:has-text("permission")').count();
  if (notice) problems.push(`${name}: ${await page.locator('#view .notice').first().textContent()}`);
  await shot(name);
}
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${state.base}/admin/#/`);
await page.waitForSelector('#view h1');
await shot('20-overview-phone-width');
await browser.close();

console.log(problems.length ? `\nProblems:\n- ${problems.join('\n- ')}` : '\nNo page errors.');
