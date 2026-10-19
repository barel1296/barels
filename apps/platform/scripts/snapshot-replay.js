// Replays a recorded demo snapshot for the unchanged admin dashboard (web/admin/app.js), so it can
// be clicked through as a single static page with no platform behind it. Loaded before app.js by
// the page `npm run demo:snapshot` builds. Reads come from the recording; nothing is ever saved:
// every change is answered with a clear "read-only snapshot" error, and sign-in accepts anything.
(() => {
  const snapshot = JSON.parse(document.getElementById('gi-snapshot').textContent);
  const responses = snapshot.responses;
  // Date-based queries (for example ?from=…&to=…) differ on later days: fall back to the same path.
  const byPath = {};
  for (const key of Object.keys(responses)) byPath[key.split('?')[0]] ??= key;
  // Parsed from the text, not with new URL(): in a sandboxed frame the page address may be opaque.
  const apiPath = (url) => {
    const s = String(url);
    const i = s.indexOf('/v1/');
    if (i < 0) return null;
    const [path, query] = s.slice(i).split('#')[0].split('?');
    return { path, search: query ? `?${query}` : '' };
  };
  const lookup = ({ path, search }) => responses[path + search] ?? responses[byPath[path]];
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const readOnly = { error: { code: 'SNAPSHOT', message: 'This is a recorded snapshot of the demo, so changes are not saved.' } };
  let signedIn = true;

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const target = apiPath(typeof input === 'string' ? input : input.url);
    if (!target) return realFetch(input, init);
    const method = (init.method ?? 'GET').toUpperCase();
    if (target.path === '/v1/auth/login' || target.path === '/v1/auth/logout') {
      signedIn = target.path === '/v1/auth/login';
      return json(200, { csrf_token: 'snapshot' });
    }
    if (method !== 'GET') return json(409, readOnly);
    if (target.path === '/v1/auth/session' && !signedIn) return json(401, { error: { code: 'UNAUTHENTICATED', message: 'Sign in' } });
    const r = lookup(target);
    if (!r || r.image) return json(404, { error: { code: 'NOT_RECORDED', message: 'This was not recorded in the snapshot.' } });
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json' } });
  };

  // Images are <img src="/v1/media-assets/…/preview">: serve the recorded copy instead.
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (name === 'src' && this instanceof HTMLImageElement && typeof value === 'string') {
      const target = apiPath(value);
      if (target) value = lookup(target)?.image ?? 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
    }
    return setAttribute.call(this, name, value);
  };

  // The viewer's frame answers prompt() with null, which would make buttons that ask for a note
  // silently do nothing; answer for the reviewer so the action reaches the read-only message.
  window.prompt = () => '(snapshot)';

  // Cookies may be unavailable in the viewer's frame; the dashboard only reads one as a fallback.
  try {
    void document.cookie;
  } catch {
    Object.defineProperty(Document.prototype, 'cookie', { configurable: true, get: () => '', set: () => undefined });
  }
})();
