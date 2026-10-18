/**
 * Minimal Instagram Graph API client (Instagram API with Instagram Login,
 * graph.instagram.com). Only the endpoints the platform uses: content
 * publishing, publishing quota, comments and media insights. The base URL is
 * configurable so tests run against the SIMULATED Instagram server.
 */
export class InstagramApiError extends Error {
  constructor(
    readonly status: number | null,
    readonly code: number | null,
    readonly subcode: number | null,
    message: string,
    readonly network = false,
  ) {
    super(`Instagram API error${status ? ` ${status}` : ''}${code ? ` (code ${code}${subcode ? `/${subcode}` : ''})` : ''}: ${message}`);
    this.name = 'InstagramApiError';
  }

  /** Rate limits (4, 17, 32, 613) and server errors are worth retrying. */
  get rateLimited(): boolean {
    return this.code !== null && [4, 17, 32, 613].includes(this.code);
  }

  /** Invalid or expired access token. */
  get authFailure(): boolean {
    return this.code === 190;
  }
}

export interface ContainerStatus {
  id: string;
  status_code: 'EXPIRED' | 'ERROR' | 'FINISHED' | 'IN_PROGRESS' | 'PUBLISHED';
  status?: string;
}

export interface IgComment {
  id: string;
  text: string;
  timestamp: string;
  username?: string;
  from?: { id: string; username?: string };
  parent_id?: string;
  replies?: { data: IgComment[] };
}

export class InstagramClient {
  constructor(
    private readonly baseUrl: string,
    private readonly version: string,
    private readonly token: string,
    private readonly timeoutMs = 30_000,
  ) {}

  private async request<T>(method: 'GET' | 'POST', path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}/${this.version}/${path}`);
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) (method === 'GET' ? url.searchParams : form).set(k, String(v));
    (method === 'GET' ? url.searchParams : form).set('access_token', this.token);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        ...(method === 'POST' ? { body: form, headers: { 'content-type': 'application/x-www-form-urlencoded' } } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new InstagramApiError(null, null, null, (err as Error).message, true);
    }
    const body = (await res.json().catch(() => null)) as (T & { error?: { message?: string; code?: number; error_subcode?: number } }) | null;
    if (!res.ok || !body || body.error) {
      throw new InstagramApiError(res.status, body?.error?.code ?? null, body?.error?.error_subcode ?? null, body?.error?.message ?? `HTTP ${res.status}`);
    }
    return body;
  }

  me(): Promise<{ id: string; user_id?: string; username: string }> {
    return this.request('GET', 'me', { fields: 'id,user_id,username' });
  }

  async createContainer(igUserId: string, params: Record<string, string | boolean | undefined>): Promise<string> {
    return (await this.request<{ id: string }>('POST', `${igUserId}/media`, params)).id;
  }

  containerStatus(containerId: string): Promise<ContainerStatus> {
    return this.request('GET', containerId, { fields: 'id,status_code,status' });
  }

  async publish(igUserId: string, creationId: string): Promise<string> {
    return (await this.request<{ id: string }>('POST', `${igUserId}/media_publish`, { creation_id: creationId })).id;
  }

  media(mediaId: string, fields: string): Promise<Record<string, unknown>> {
    return this.request('GET', mediaId, { fields });
  }

  async publishingLimit(igUserId: string): Promise<{ quota_usage: number; quota_total: number | null }> {
    const r = await this.request<{ data: { quota_usage: number; config?: { quota_total?: number } }[] }>('GET', `${igUserId}/content_publishing_limit`, { fields: 'quota_usage,config' });
    const d = r.data[0];
    return { quota_usage: d?.quota_usage ?? 0, quota_total: d?.config?.quota_total ?? null };
  }

  comments(mediaId: string, after?: string): Promise<{ data: IgComment[]; paging?: { cursors?: { after?: string }; next?: string } }> {
    return this.request('GET', `${mediaId}/comments`, { fields: 'id,text,timestamp,username,from,replies{id,text,timestamp,username,from}', limit: 50, after });
  }

  async replyToComment(commentId: string, message: string): Promise<string> {
    return (await this.request<{ id: string }>('POST', `${commentId}/replies`, { message })).id;
  }

  async hideComment(commentId: string, hide: boolean): Promise<boolean> {
    return (await this.request<{ success: boolean }>('POST', commentId, { hide })).success;
  }

  insights(mediaId: string, metrics: string[]): Promise<{ data: { name: string; values?: { value: number }[]; total_value?: { value: number } }[] }> {
    return this.request('GET', `${mediaId}/insights`, { metric: metrics.join(',') });
  }
}
