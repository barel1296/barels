import type pg from 'pg';
import type { Db } from '../../db/tx.js';
import type { ChatResult } from './gateway.js';

/**
 * Records one local LLM call in analytics.usage_events. Local inference has no
 * per-call fee (cost_usd = 0); energy and amortisation are attributed later from
 * measured GPU time (docs/12).
 */
export async function recordLlmUsage(
  db: Db | pg.Pool,
  e: { workspaceId: string; influencerId: string | null; operation: string; result: ChatResult; agentRunId?: string | null; conversationId?: string | null; messageId?: string | null },
): Promise<void> {
  await db.query(
    `INSERT INTO analytics.usage_events (occurred_at, workspace_id, influencer_id, category, provider, model, operation, quantities, cost_usd,
       agent_run_id, conversation_id, message_id)
     VALUES (now(), $1, $2, 'llm', 'local', $3, $4, $5, 0, $6, $7, $8)`,
    [
      e.workspaceId,
      e.influencerId,
      e.result.model,
      e.operation,
      JSON.stringify({ prompt_tokens: e.result.usage.prompt_tokens, completion_tokens: e.result.usage.completion_tokens, latency_ms: e.result.latencyMs }),
      e.agentRunId ?? null,
      e.conversationId ?? null,
      e.messageId ?? null,
    ],
  );
}
