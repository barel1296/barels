/**
 * SIMULATED Instagram Graph API (subset used by the platform) for automated
 * tests. It fetches container media URLs like Instagram does (so signed public
 * URLs and JPEG conversion are exercised), models container processing,
 * media_publish, publishing quota, comments, replies, hiding and insights.
 * It is NOT Instagram: real API behaviour, review requirements and limits
 * must be verified against Meta before launch.
 */
import Fastify, { type FastifyInstance } from 'fastify';

interface SimContainer {
  id: string;
  owner: string;
  params: Record<string, string>;
  status_code: 'IN_PROGRESS' | 'FINISHED' | 'ERROR' | 'EXPIRED' | 'PUBLISHED';
  status: string;
  polls: number;
  fetched: { url: string; contentType: string | null; bytes: number; jpeg: boolean }[];
}

interface SimMedia {
  id: string;
  owner: string;
  container: SimContainer;
  permalink: string;
  caption: string;
}

export interface InstagramSimulator {
  app: FastifyInstance;
  baseUrl: string;
  addAccount(username: string): { token: string; igUserId: string };
  containers: Map<string, SimContainer>;
  media: Map<string, SimMedia>;
  replies: { commentId: string; message: string }[];
  hidden: Map<string, boolean>;
  /** Metric names the simulated API rejects with code 100 (like a renamed metric). */
  unsupportedMetrics: string[];
  /** Follower count reported for every simulated account. */
  followers: number;
  /** Containers stay IN_PROGRESS for this many status polls. */
  processingPolls: number;
  quotaTotal: number;
  addComment(mediaId: string, c: { text: string; fromId: string; username: string; parentId?: string }): string;
  setInsights(mediaId: string, metrics: Record<string, number>): void;
  failNext(match: string, status: number, code: number, message?: string): void;
  close(): Promise<void>;
}

export async function startInstagramSimulator(): Promise<InstagramSimulator> {
  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));
  const accounts = new Map<string, { igUserId: string; username: string }>();
  const containers = new Map<string, SimContainer>();
  const media = new Map<string, SimMedia>();
  const comments = new Map<string, { id: string; text: string; timestamp: string; username: string; from: { id: string; username: string }; parent_id?: string }[]>();
  const insights = new Map<string, Record<string, number>>();
  const replies: { commentId: string; message: string }[] = [];
  const hidden = new Map<string, boolean>();
  const failures: { match: string; status: number; code: number; message: string }[] = [];
  let seq = 17_900_000_000_000_000n; // Graph ids exceed Number.MAX_SAFE_INTEGER
  const nextId = () => String(++seq);
  let quotaUsage = 0;

  const graphError = (status: number, code: number, message: string) => ({ status, body: { error: { message, type: code === 190 ? 'OAuthException' : 'GraphMethodException', code, fbtrace_id: 'SIM' } } });

  async function fetchMedia(url: string): Promise<SimContainer['fetched'][number]> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const buf = Buffer.from(await res.arrayBuffer());
      if (!res.ok) return { url, contentType: null, bytes: 0, jpeg: false };
      return { url, contentType: res.headers.get('content-type'), bytes: buf.length, jpeg: buf[0] === 0xff && buf[1] === 0xd8 };
    } catch {
      return { url, contentType: null, bytes: 0, jpeg: false };
    }
  }

  app.route({
    method: ['GET', 'POST'],
    url: '/:version/*',
    handler: async (req, reply) => {
      const path = (req.params as { '*': string })['*'];
      const params = { ...(req.query as Record<string, string>), ...((req.body as Record<string, string>) ?? {}) };
      const fail = failures.findIndex((f) => `${req.method} ${path}`.includes(f.match));
      if (fail >= 0) {
        const f = failures.splice(fail, 1)[0]!;
        const e = graphError(f.status, f.code, f.message);
        return reply.status(e.status).send(e.body);
      }
      const account = accounts.get(params.access_token ?? '');
      if (!account) {
        const e = graphError(400, 190, 'Invalid OAuth access token.');
        return reply.status(e.status).send(e.body);
      }
      const parts = path.split('/');
      const [first, second] = parts;
      if (req.method === 'GET' && first === 'me') return { id: account.igUserId, user_id: account.igUserId, username: account.username };
      if (req.method === 'POST' && second === 'media' && first === account.igUserId) {
        const c: SimContainer = { id: nextId(), owner: first, params, status_code: 'IN_PROGRESS', status: 'In Progress', polls: 0, fetched: [] };
        const url = params.image_url ?? params.video_url;
        if (params.media_type === 'CAROUSEL') {
          const kids = (params.children ?? '').split(',');
          if (kids.length < 2 || kids.some((k) => containers.get(k)?.status_code !== 'FINISHED')) {
            const e = graphError(400, 100, 'Invalid children');
            return reply.status(e.status).send(e.body);
          }
        } else if (url) {
          const f = await fetchMedia(url);
          c.fetched.push(f);
          if (!f.bytes) Object.assign(c, { status_code: 'ERROR', status: 'ERROR: media could not be fetched from URI' });
          else if (params.image_url && !f.jpeg) Object.assign(c, { status_code: 'ERROR', status: 'ERROR: only JPEG images are supported' });
        } else {
          const e = graphError(400, 100, 'image_url or video_url is required');
          return reply.status(e.status).send(e.body);
        }
        containers.set(c.id, c);
        return { id: c.id };
      }
      if (req.method === 'POST' && second === 'media_publish' && first === account.igUserId) {
        const c = containers.get(params.creation_id ?? '');
        if (!c || c.status_code !== 'FINISHED') {
          const e = graphError(400, 9007, 'Media ID is not available');
          return reply.status(e.status).send(e.body);
        }
        c.status_code = 'PUBLISHED';
        const m: SimMedia = { id: nextId(), owner: first, container: c, permalink: '', caption: c.params.caption ?? '' };
        m.permalink = `https://www.instagram.com/p/SIM${m.id.slice(-8)}/`;
        media.set(m.id, m);
        quotaUsage++;
        return { id: m.id };
      }
      if (req.method === 'GET' && second === 'content_publishing_limit') return { data: [{ quota_usage: quotaUsage, config: { quota_total: sim.quotaTotal, quota_duration: 86400 } }] };
      if (req.method === 'GET' && second === 'comments') {
        const list = (comments.get(first!) ?? []).filter((c) => !c.parent_id);
        return { data: list.map((c) => ({ ...c, replies: { data: (comments.get(first!) ?? []).filter((r) => r.parent_id === c.id) } })) };
      }
      if (req.method === 'GET' && second === 'insights') {
        const values = insights.get(first!) ?? {};
        const wanted = String(params.metric ?? '').split(',').filter(Boolean);
        const unsupported = wanted.filter((w) => sim.unsupportedMetrics.includes(w));
        if (unsupported.length) {
          const e = graphError(400, 100, `(#100) metric[0] must be one of the following values: ... (${unsupported.join(',')} not supported)`);
          return reply.status(e.status).send(e.body);
        }
        return { data: wanted.filter((w) => w in values).map((name) => ({ name, period: 'lifetime', values: [{ value: values[name] }] })) };
      }
      if (req.method === 'POST' && second === 'replies') {
        replies.push({ commentId: first!, message: params.message ?? '' });
        return { id: nextId() };
      }
      if (req.method === 'POST' && !second && params.hide !== undefined) {
        hidden.set(first!, params.hide === 'true');
        return { success: true };
      }
      if (req.method === 'GET' && !second && first === account.igUserId) {
        return { id: account.igUserId, username: account.username, followers_count: sim.followers, media_count: media.size };
      }
      if (req.method === 'GET' && !second) {
        const c = containers.get(first!);
        if (c) {
          c.polls++;
          if (c.status_code === 'IN_PROGRESS' && c.polls > sim.processingPolls) Object.assign(c, { status_code: 'FINISHED', status: 'Finished' });
          return { id: c.id, status_code: c.status_code, status: c.status };
        }
        const m = media.get(first!);
        if (m) return { id: m.id, permalink: m.permalink, caption: m.caption, media_type: m.container.params.media_type ?? 'IMAGE' };
      }
      const e = graphError(400, 100, `Unsupported request: ${req.method} ${path}`);
      return reply.status(e.status).send(e.body);
    },
  });

  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const sim: InstagramSimulator = {
    app,
    baseUrl: address,
    containers,
    media,
    replies,
    hidden,
    processingPolls: 1,
    followers: 1200,
    unsupportedMetrics: [],
    quotaTotal: 100,
    addAccount(username) {
      const igUserId = nextId();
      const token = `IGSIM${Math.random().toString(36).slice(2)}${igUserId}`;
      accounts.set(token, { igUserId, username });
      return { token, igUserId };
    },
    addComment(mediaId, c) {
      const id = nextId();
      const list = comments.get(mediaId) ?? [];
      list.push({ id, text: c.text, timestamp: new Date().toISOString(), username: c.username, from: { id: c.fromId, username: c.username }, ...(c.parentId ? { parent_id: c.parentId } : {}) });
      comments.set(mediaId, list);
      return id;
    },
    setInsights(mediaId, metrics) {
      insights.set(mediaId, metrics);
    },
    failNext(match, status, code, message = 'simulated failure') {
      failures.push({ match, status, code, message });
    },
    close: () => app.close(),
  };
  return sim;
}
