import { z } from 'zod';

/**
 * Agent message protocol (docs/05 §5.0).
 *
 * The protocol is the anti-hallucination spine: claim-bearing message types
 * REQUIRE evidence references, hypotheses REQUIRE a falsification statement.
 * The Python worker enforces this at write time (workers/py protocol module);
 * these schemas are the read-side contract for API and web.
 */

export const AGENTS = [
  'growth_director',
  'intelligence',
  'operations',
  'creative',
  'tracking',
] as const;
export type AgentName = (typeof AGENTS)[number];

export const MESSAGE_TYPES = [
  'finding',
  'hypothesis',
  'challenge',
  'concession',
  'proposal',
  'vote',
  'request',
  'directive',
  'resolution',
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/** Message types that assert facts and therefore must carry evidence. */
export const EVIDENCE_REQUIRED_TYPES: readonly MessageType[] = [
  'finding',
  'hypothesis',
  'challenge',
];

export const SESSION_PHASES = [
  'triage',
  'health_gate',
  'investigation',
  'debate',
  'synthesis',
  'action_prep',
  'review',
  'published',
  'monitoring',
  'closed',
  'parked',
  'failed',
] as const;
export type SessionPhase = (typeof SESSION_PHASES)[number];

export const SESSION_STATUSES = [
  'running',
  'published',
  'monitoring',
  'closed',
  'failed',
  'parked',
  'budget_exceeded',
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const agentMessageSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  agent: z.union([z.enum(AGENTS), z.literal('user'), z.literal('orchestrator')]),
  type: z.enum(MESSAGE_TYPES),
  claim: z.string().min(1),
  payload: z.record(z.unknown()).default({}),
  evidenceIds: z.array(z.string().uuid()).default([]),
  confidence: z.number().min(0).max(1).nullable().optional(),
  directedTo: z.array(z.string()).default([]),
  inReplyTo: z.string().uuid().nullable().optional(),
  seq: z.number().int(),
  createdAt: z.string(),
});
export type AgentMessage = z.infer<typeof agentMessageSchema>;

export const evidenceDigestSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['metric_query', 'recon_report', 'external', 'computation']),
  metricKey: z.string().nullable().optional(),
  metricVersion: z.number().int().nullable().optional(),
  params: z.record(z.unknown()),
  sqlHash: z.string(),
  /** Small inline summary used by the UI for number binding. */
  resultDigest: z.record(z.unknown()),
  freshnessAt: z.string(),
  executedAt: z.string(),
});
export type EvidenceDigest = z.infer<typeof evidenceDigestSchema>;

export const decisionSchema = z.object({
  outcome: z.enum(['action_proposed', 'monitor', 'escalated']),
  chosenOption: z.string(),
  rejectedAlternatives: z.array(
    z.object({ option: z.string(), reason: z.string() }),
  ),
  confidence: z.number().min(0).max(1),
  predictedImpact: z
    .object({
      metric: z.string(),
      low: z.number(),
      mid: z.number(),
      high: z.number(),
      horizonDays: z.number().int(),
      basisEvidenceIds: z.array(z.string().uuid()),
    })
    .nullable(),
  riskStatement: z.string(),
  reEvaluationConditions: z.array(z.string()),
  unresolvedContentions: z
    .array(z.object({ topic: z.string(), positions: z.array(z.string()) }))
    .default([]),
});
export type Decision = z.infer<typeof decisionSchema>;
