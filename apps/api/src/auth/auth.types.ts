import type { PermissionKey } from '@gros/shared';

export interface AuthContext {
  kind: 'user' | 'service' | 'api_key';
  userId: string;
  tenantId: string;
  roleName: string;
  permissions: ReadonlySet<string>;
}

export interface RequestWithAuth extends Express.Request {
  auth?: AuthContext;
  requestId?: string;
  auditEvent?: string;
  auditObject?: { type: string; id: string; before?: unknown; after?: unknown };
}

export const SERVICE_PERMISSIONS: PermissionKey[] = [
  'metrics:read',
  'health:read',
  'health:manage',
  'warroom:read',
  'warroom:create',
  'recs:read',
  'actions:read',
  'costs:read',
];
