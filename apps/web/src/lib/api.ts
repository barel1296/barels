'use client';

export class ApiError extends Error {
  constructor(
    public status: number,
    public title: string,
    public detail?: unknown,
  ) {
    super(`${status}: ${title}`);
  }
}

export async function api<T>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    ...rest,
    headers: {
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...rest.headers,
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (res.status === 401 && typeof window !== 'undefined') {
    if (!window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
  }
  if (!res.ok) {
    let title = res.statusText;
    let detail: unknown;
    try {
      const body = (await res.json()) as { title?: string; detail?: unknown };
      title = body.title ?? title;
      detail = body.detail;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, title, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const detail = Array.isArray(err.detail) ? err.detail.join('; ') : err.detail;
    return detail ? `${err.title}: ${String(detail)}` : err.title;
  }
  return err instanceof Error ? err.message : String(err);
}
