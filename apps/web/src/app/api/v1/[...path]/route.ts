import type { NextRequest } from 'next/server';

/**
 * Runtime API proxy: forwards /api/v1/* to the API service using the
 * API_INTERNAL_URL env var read at REQUEST time (not build time), so one web
 * image works in any environment (local, compose, Render, k8s). Streams
 * bodies both ways — SSE works through it.
 */
export const dynamic = 'force-dynamic';

function apiBase(): string {
  const raw = process.env.API_INTERNAL_URL ?? 'http://localhost:3001';
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
  const upstream = await fetch(url, {
    method: req.method,
    headers,
    body: hasBody ? req.body : undefined,
    redirect: 'manual',
    // Node fetch requires half-duplex for streamed request bodies.
    // @ts-expect-error -- duplex is a Node fetch extension
    duplex: hasBody ? 'half' : undefined,
  });

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
