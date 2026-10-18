import type pg from 'pg';
import { withTx } from '../db/tx.js';
import { enqueue } from './jobs-queue.js';

/**
 * Outbox → job fan-out. Domain events are written transactionally to
 * core.outbox_events; this dispatcher turns each event into one idempotent job
 * per subscribed consumer (job_key = consumer:event_id) and marks it dispatched.
 * Consumers are ordinary job handlers, so retries and dead-lettering are shared.
 */
export interface EventSubscription {
  /** Exact event_type or a prefix ending in '.*'. */
  event: string;
  job: string;
  queue: string;
  priority: number;
}

export function matches(pattern: string, eventType: string): boolean {
  return pattern.endsWith('.*') ? eventType.startsWith(pattern.slice(0, -1)) : pattern === eventType;
}

export interface OutboxEvent {
  id: string;
  workspace_id: string | null;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
}

export async function dispatchOutbox(pool: pg.Pool, subscriptions: EventSubscription[], batch = 200): Promise<number> {
  return withTx(pool, async (db) => {
    const { rows } = await db.query<OutboxEvent>(
      `SELECT id, workspace_id, event_type, aggregate_type, aggregate_id, payload, occurred_at
         FROM core.outbox_events WHERE dispatched_at IS NULL
        ORDER BY occurred_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [batch],
    );
    for (const ev of rows) {
      for (const sub of subscriptions.filter((s) => matches(s.event, ev.event_type))) {
        await enqueue(db, {
          workspaceId: ev.workspace_id,
          queue: sub.queue,
          name: sub.job,
          key: `${sub.job}:${ev.id}`,
          priority: sub.priority,
          payload: { event_id: ev.id, event_type: ev.event_type, aggregate_type: ev.aggregate_type, aggregate_id: ev.aggregate_id, payload: ev.payload },
        });
      }
      await db.query('UPDATE core.outbox_events SET dispatched_at = now(), dispatch_attempts = dispatch_attempts + 1 WHERE id = $1', [ev.id]);
    }
    return rows.length;
  });
}

/** Exactly-once guard for consumers: returns false if this consumer already processed the event. */
export async function claimEvent(db: pg.PoolClient | pg.Pool, consumer: string, eventId: string): Promise<boolean> {
  const res = await db.query('INSERT INTO core.processed_events (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [consumer, eventId]);
  return (res.rowCount ?? 0) > 0;
}
