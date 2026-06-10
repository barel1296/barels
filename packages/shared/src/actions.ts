import { z } from 'zod';

/** Action kinds the preparation layer supports (docs/10 §10.4). */
export const ACTION_KINDS = [
  'budget_change',
  'pause_entity',
  'create_campaign',
  'audience_sync',
  'creative_rotation',
  'crm_journey_change',
  'aso_change',
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export const ACTION_STATUSES = [
  'draft',
  'awaiting_approval',
  'approved',
  'executing',
  'executed',
  'verify_failed',
  'rolled_back',
  'rejected',
  'expired',
  'cancelled',
] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export const REJECTION_REASON_CODES = [
  'wrong_diagnosis',
  'right_diagnosis_wrong_action',
  'timing',
  'business_context_missing',
  'dont_trust_data',
  'other',
] as const;
export type RejectionReasonCode = (typeof REJECTION_REASON_CODES)[number];

export const guardrailResultSchema = z.object({
  key: z.string(),
  description: z.string(),
  passed: z.boolean(),
  observed: z.record(z.unknown()),
  limit: z.record(z.unknown()),
});
export type GuardrailResult = z.infer<typeof guardrailResultSchema>;

export const actionDiffSchema = z.object({
  summary: z.string(),
  entries: z.array(
    z.object({
      field: z.string(),
      entity: z.string(),
      before: z.unknown(),
      after: z.unknown(),
    }),
  ),
});
export type ActionDiff = z.infer<typeof actionDiffSchema>;

/**
 * Canonical JSON serialization for diff hashing: stable key order, no
 * insignificant whitespace. Both API (verify) and web (echo) must agree.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

export const AUTONOMY_LEVELS = [0, 1, 2, 3, 4] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];
