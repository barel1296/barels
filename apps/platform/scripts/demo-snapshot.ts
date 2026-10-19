/**
 * Records a running local demo (`npm run demo`) into ONE self-contained HTML page: the unchanged
 * admin dashboard (web/admin/app.js + styles.css) plus every API response it showed, replayed by
 * scripts/snapshot-replay.js. The page needs no platform, database or network, so it can be opened
 * anywhere (for example as a private claude.ai artifact) and clicked through. It is read-only:
 * changes are refused with a clear message.
 *
 * In a real headless Chromium it signs in with password + TOTP from the demo's credentials file,
 * visits every screen (and every screen linked from them), and keeps the GET /v1/* responses and
 * the preview images. Values under secret-looking keys (token, secret, password, csrf) are removed.
 *
 *   npm run demo:snapshot -- [--out <the demo's --out directory>] [--dest <file.html>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { totpAt } from '../src/lib/totp.js';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const out = resolve(arg('--out') ?? join(tmpdir(), 'golden-demo'));
const dest = resolve(arg('--dest') ?? join(out, 'snapshot.html'));
const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..', 'web', 'admin');
const state = JSON.parse(readFileSync(join(out, 'demo-state.json'), 'utf8')) as { base: string; credentials: string };
const creds = readFileSync(state.credentials, 'utf8');
const field = (label: string) => new RegExp(`^${label}:\\s*(.+)$`, 'm').exec(creds)?.[1]?.trim() ?? '';

type Recorded = { status: number; body?: string; image?: string };
const responses: Record<string, Recorded> = {};
const pending: Promise<void>[] = [];
const removed = new Set<string>();
const SECRET_KEY = /(^|_)(secret|password|token|csrf)(_|$)/i;
const scrub = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => {
        if (SECRET_KEY.test(k) && typeof x === 'string') {
          removed.add(k);
          return [k, '[removed]'];
        }
        return [k, scrub(x)];
      }),
    );
  }
  return v;
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const problems: string[] = [];
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
page.on('response', (resp) => {
  const req = resp.request();
  const url = new URL(resp.url());
  if (req.method() !== 'GET' || !url.pathname.startsWith('/v1/') || url.pathname.startsWith('/v1/auth/') && url.pathname !== '/v1/auth/session') return;
  pending.push(
    (async () => {
      const key = url.pathname + url.search;
      const type = resp.headers()['content-type'] ?? '';
      const body = await resp.body().catch(() => null);
      if (!body) return;
      if (type.startsWith('image/')) responses[key] = { status: resp.status(), image: `data:${type.split(';')[0]};base64,${body.toString('base64')}` };
      else responses[key] = { status: resp.status(), body: JSON.stringify(scrub(JSON.parse(body.toString('utf8') || 'null'))) };
    })(),
  );
});

await page.goto(`${state.base}/admin/#/login`);
await page.waitForSelector('input[name=email]');
await page.fill('input[name=email]', field('Email'));
await page.fill('input[name=password]', field('Password'));
await page.fill('input[name=totp]', totpAt(field('TOTP secret \\(add to an authenticator app\\)'), Math.floor(Date.now() / 1000)));
await page.click('button[type=submit]');
await page.waitForSelector('h1:has-text("Overview")');

const influencers = (await page.evaluate(async () => (await fetch('/v1/influencers')).json())) as { id: string }[];
const queue = [
  '#/',
  ...(await page.$$eval('#nav a[href^="#/"]', (as) => as.map((a) => a.getAttribute('href')!))),
  ...influencers.flatMap(({ id }) => ['influencer', 'setup', 'calendar', 'media', 'money', 'analytics'].map((p) => `#/${p}/${id}`)),
];
const seen = new Set<string>();
const images = new Set<string>();
while (queue.length && seen.size < 400) {
  const hash = queue.shift()!;
  if (seen.has(hash) || hash === '#/login') continue;
  seen.add(hash);
  await page.goto(`${state.base}/admin/${hash}`);
  await page.waitForSelector('#view h1');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
  const notice = await page.locator('#view .notice:has-text("Could not load")').count();
  if (notice) problems.push(`${hash}: ${await page.locator('#view .notice').first().textContent()}`);
  for (const href of await page.$$eval('#view a[href^="#/"]', (as) => as.map((a) => a.getAttribute('href')!))) if (!seen.has(href)) queue.push(href);
  for (const src of await page.$$eval('#view img', (is) => is.map((i) => i.getAttribute('src')!))) images.add(src);
}
await Promise.all(pending);
// Lazy images below the fold were never requested: fetch them with the same session.
for (const src of images) {
  if (responses[src] || !src.startsWith('/v1/')) continue;
  const r = await context.request.get(`${state.base}${src}`);
  if (r.ok()) responses[src] = { status: r.status(), image: `data:${(r.headers()['content-type'] ?? 'image/png').split(';')[0]};base64,${(await r.body()).toString('base64')}` };
  else problems.push(`image ${src}: HTTP ${r.status()}`);
}
await browser.close();

// The dashboard follows only the system theme; the viewer can also force one (data-theme on <html>).
const css = readFileSync(join(web, 'styles.css'), 'utf8');
const vars = (block: string) => [...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, k, v]) => `${k}: ${v};`).join(' ');
const light = vars(/:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? '');
const dark = vars(/prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? '');
const recordedOn = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const inline = (code: string) => code.replace(/<\/(script)/gi, '<\\/$1');
const html = `<title>Golden Influencer Admin Demo</title>
<style>
${css}
:root[data-theme="light"] { ${light} color-scheme: light; }
:root[data-theme="dark"] { ${dark} color-scheme: dark; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark; } }
header#top { top: env(safe-area-inset-top, 0px); }
.snapshot-bar { display: flex; flex-wrap: wrap; gap: 2px 14px; padding: 6px 16px; background: var(--bg); border-bottom: 1px solid var(--line); color: var(--muted); font-size: 12px; }
.snapshot-bar strong { color: var(--text); }
</style>
<div class="snapshot-bar" role="note"><strong>Recorded demo snapshot, ${recordedOn}</strong><span>Every screen can be opened; changes are not saved.</span><span>Telegram, Instagram, payments, the AI and image generation are all simulated.</span></div>
<header id="top">
  <strong class="brand">Golden Influencer</strong>
  <nav id="nav" aria-label="Main"></nav>
  <span id="who"></span>
</header>
<main id="view" aria-live="polite"><p>Loading…</p></main>
<div id="toast" role="status"></div>
<script type="application/json" id="gi-snapshot">${JSON.stringify({ recorded_at: new Date().toISOString(), responses }).replace(/</g, '\\u003c')}</script>
<script>
${inline(readFileSync(join(here, 'snapshot-replay.js'), 'utf8'))}
</script>
<script type="module">
${inline(readFileSync(join(web, 'app.js'), 'utf8'))}
</script>
`;
writeFileSync(dest, html);
console.log(`${seen.size} screens, ${Object.keys(responses).length} recorded responses, ${(html.length / 1024 / 1024).toFixed(2)} MB → ${dest}`);
if (removed.size) console.log(`Removed values under: ${[...removed].join(', ')}`);
console.log(problems.length ? `\nProblems:\n- ${problems.join('\n- ')}` : 'No page errors.');
