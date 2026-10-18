import type pg from 'pg';
import type { Db } from '../../db/tx.js';
import { uuidv7 } from '../../lib/ids.js';
import type { LlmGateway } from '../llm/gateway.js';
import { recordLlmUsage } from '../llm/usage.js';

/**
 * Persistent fan memory, per influencer, bound to the fan's
 * memory_personalization consent. Special-category data is never stored
 * (schema CHECK sensitivity='normal' plus the filter below).
 */
export const MEMORY_CATEGORIES = ['preference', 'interest', 'personal_detail', 'boundary', 'content_feedback', 'other'] as const;

const SENSITIVE = /\b(health|illness|disease|diagnos|medicat|therap|depress|anxiety|pregnan|religio|church|mosque|synagogue|god\b|faith|pray|sexual|gay|lesbian|bisexual|trans(gender)?|orientation|politic|vote[ds]?|party member|ethnic|race\b|racial|immigra|criminal|arrest|union member|salary|debt|bank|password|address|phone|email|passport|social security|minor|school|grade\b|under ?18|\bage\b|years old)\b/i;

export function isSensitiveStatement(statement: string): boolean {
  return SENSITIVE.test(statement);
}

const EXTRACTION_SCHEMA = {
  type: 'object',
  required: ['memories'],
  properties: {
    memories: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        required: ['category', 'statement', 'confidence'],
        properties: {
          category: { type: 'string', enum: [...MEMORY_CATEGORIES] },
          statement: { type: 'string', minLength: 3, maxLength: 200 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  },
};

const EXTRACTION_PROMPT = `You extract durable facts that a person explicitly shared about themselves in a chat, to personalise future conversations.
Rules:
- Only facts the PERSON stated about themselves (preferences, interests, non-sensitive personal details, boundaries, feedback on content).
- NEVER include: health, mental health, religion, sexual orientation or sex life, political views, ethnicity, criminal history, finances, exact location, contact details, school, age, or anything about children.
- Write each statement in third person, short, e.g. "Loves hiking in the Alps".
- Skip greetings, jokes, and anything uncertain. Return an empty list if nothing qualifies.
Return only JSON: {"memories":[{"category":"preference|interest|personal_detail|boundary|content_feedback|other","statement":"...","confidence":0.0-1.0}]}`;

export interface ExtractedMemory {
  category: (typeof MEMORY_CATEGORIES)[number];
  statement: string;
  confidence: number;
}

/** Runs extraction on the latest fan messages and stores new, non-sensitive, non-duplicate memories. */
export async function extractAndStoreMemories(
  db: Db | pg.Pool,
  llm: LlmGateway,
  m: { workspaceId: string; influencerId: string; fanId: string; conversationId: string; consentId: string; fanMessages: { id: string; body: string }[] },
): Promise<{ stored: number; rejected: number }> {
  if (m.fanMessages.length === 0) return { stored: 0, rejected: 0 };
  const transcript = m.fanMessages.map((x) => `PERSON: ${x.body}`).join('\n');
  const { value, result } = await llm.chatJson<{ memories: ExtractedMemory[] }>(
    { purpose: 'conversation.memory_extract', priority: 'background', maxTokens: 400, messages: [{ role: 'system', content: EXTRACTION_PROMPT }, { role: 'user', content: transcript }] },
    'memory_extraction',
    EXTRACTION_SCHEMA,
  );
  await recordLlmUsage(db, { workspaceId: m.workspaceId, influencerId: m.influencerId, operation: 'conversation.memory_extract', result, conversationId: m.conversationId });
  const existing = await db.query<{ statement: string }>(
    `SELECT statement FROM conversation.fan_memories WHERE influencer_id = $1 AND fan_id = $2 AND status = 'active'`,
    [m.influencerId, m.fanId],
  );
  const known = new Set(existing.rows.map((r) => r.statement.toLowerCase().trim()));
  let stored = 0;
  let rejected = 0;
  for (const mem of value.memories) {
    const statement = mem.statement.trim();
    if (mem.confidence < 0.6 || isSensitiveStatement(statement) || known.has(statement.toLowerCase())) {
      rejected++;
      continue;
    }
    await db.query(
      `INSERT INTO conversation.fan_memories (id, workspace_id, influencer_id, fan_id, category, statement, consent_id, source_message_ids, confidence,
         created_by_type, created_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'agent', 'memory_extractor')`,
      [uuidv7(), m.workspaceId, m.influencerId, m.fanId, mem.category, statement, m.consentId, m.fanMessages.map((x) => x.id), Math.round(mem.confidence * 100) / 100],
    );
    known.add(statement.toLowerCase());
    stored++;
  }
  // Keep the active set bounded: the oldest beyond 200 are superseded.
  await db.query(
    `UPDATE conversation.fan_memories SET status = 'superseded'
      WHERE id IN (SELECT id FROM conversation.fan_memories WHERE influencer_id = $1 AND fan_id = $2 AND status = 'active'
                   ORDER BY created_at DESC OFFSET 200)`,
    [m.influencerId, m.fanId],
  );
  return { stored, rejected };
}

export async function activeMemories(db: Db | pg.Pool, influencerId: string, fanId: string, limit = 30): Promise<{ id: string; category: string; statement: string; created_at: Date }[]> {
  const { rows } = await db.query(
    `SELECT id, category, statement, created_at FROM conversation.fan_memories
      WHERE influencer_id = $1 AND fan_id = $2 AND status = 'active'
      ORDER BY (category = 'boundary') DESC, created_at DESC LIMIT $3`,
    [influencerId, fanId, limit],
  );
  return rows;
}

/** Fan-initiated (/forget) or staff deletion of all memories for one influencer relationship. */
export async function forgetAll(db: Db | pg.Pool, influencerId: string, fanId: string): Promise<number> {
  const res = await db.query(
    `UPDATE conversation.fan_memories SET status = 'deleted', deleted_at = now() WHERE influencer_id = $1 AND fan_id = $2 AND status = 'active'`,
    [influencerId, fanId],
  );
  return res.rowCount ?? 0;
}
