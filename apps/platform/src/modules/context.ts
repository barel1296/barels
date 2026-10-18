import { forbidden } from '../lib/errors.js';

export type ActorType = 'user' | 'agent' | 'system' | 'external';

export interface Actor {
  type: ActorType;
  id: string;
}

/** Who is acting, in which workspace, with which permissions. One per API request or worker step. */
export interface Ctx {
  workspaceId: string;
  actor: Actor;
  userId: string | null;
  permissions: ReadonlySet<string>;
  isPlatformAdmin: boolean;
  /** null = every influencer in the workspace; otherwise the membership's influencer scope. */
  influencerScope: ReadonlySet<string> | null;
  requestId: string;
  traceId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export function requirePermission(ctx: Ctx, permission: string): void {
  if (ctx.actor.type === 'system') return;
  if (!ctx.permissions.has(permission)) throw forbidden(`Missing permission ${permission}`, { permission });
}

export function requireInfluencerAccess(ctx: Ctx, influencerId: string): void {
  if (ctx.influencerScope && !ctx.influencerScope.has(influencerId)) {
    throw forbidden('Influencer is outside your access scope', { influencer_id: influencerId });
  }
}

export function requirePlatformAdmin(ctx: Ctx): void {
  if (ctx.actor.type === 'system') return;
  if (!ctx.isPlatformAdmin) throw forbidden('Platform administrator required');
}

/** Context for background workers acting on behalf of the platform. */
export function systemCtx(workspaceId: string, job: string): Ctx {
  return {
    workspaceId,
    actor: { type: 'system', id: job },
    userId: null,
    permissions: new Set(),
    isPlatformAdmin: false,
    influencerScope: null,
    requestId: `${job}:${Date.now()}`,
  };
}

export function actorRef(actor: Actor): string {
  return `${actor.type}:${actor.id}`;
}
