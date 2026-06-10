import type { NextRequest } from 'next/server';

/**
 * Runtime API proxy: forwards /api/v1/* to the API service using the
 * API_INTERNAL_URL env var read at REQUEST time (not build time), so one web
 * image works in any environment (local, compose, Render, k8s). Streams
 * bodies both ways — SSE works through it.
 */
export const dynamic = 'force-dynamic';

function apiBase(): string {
  // 127.0.0.1 (not "localhost") avoids IPv6-first resolution surprises.
  const raw = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:3001';
  return raw.includes('://') ? raw.replace(/\/$/, '') : `http://${raw}`;
}

async function proxy(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await params;
  const url = `${apiBase()}/v1/${path.join('/')}${req.nextUrl.search}`;

  const headers = new Headers(req.headers);
  headers.delete('host');
  headers.delete('connection');

  const hasBody = !['GET', 'HEAD'].includes(req.method);
  // SSE streams legitimately stay open; everything else must answer fast.
  const isStream = path[path.length - 1] === 'stream';
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      redirect: 'manual',
      signal: isStream ? undefined : AbortSignal.timeout(25_000),
      // Node fetch requires half-duplex for streamed request bodies.
      // @ts-expect-error -- duplex is a Node fetch extension
      duplex: hasBody ? 'half' : undefined,
    });
  } catch (err) {
    // A hang or refused connection becomes a visible, diagnosable error
    // instead of an infinite spinner.
    return Response.json(
      {
        type: 'about:blank',
        title: 'API unreachable',
        status: 502,
        detail: `proxy could not reach ${apiBase()}: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502, headers: { 'content-type': 'application/problem+json' } },
    );
  }

  const resHeaders = new Headers(upstream.headers);
  resHeaders.delete('content-encoding');
  resHeaders.delete('content-length');
  resHeaders.delete('transfer-encoding');

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: resHeaders,
  });
}

export {
  proxy as GET,
  proxy as POST,
  proxy as PUT,
  proxy as PATCH,
  proxy as DELETE,
  proxy as HEAD,
  proxy as OPTIONS,
};
