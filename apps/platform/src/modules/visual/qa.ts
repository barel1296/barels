import type { QaResult } from '../../contract/types.js';

/**
 * Platform QA decision (contract §11): engine QA results are advisory
 * measurements; the platform applies per-persona thresholds and decides.
 */
export interface Threshold {
  id: string;
  influencer_id: string | null;
  check_key: string;
  min_score: number | null;
  max_score: number | null;
  required: boolean;
  on_fail: 'reject' | 'flag';
}

export interface ThresholdOutcome {
  threshold_id: string;
  check_key: string;
  score: number | null;
  passed: boolean;
  on_fail: 'reject' | 'flag';
  reason: string | null;
}

export interface QaDecision {
  status: 'valid' | 'rejected';
  flagged: boolean;
  outcomes: ThresholdOutcome[];
  reasons: string[];
}

/** Influencer-specific thresholds override workspace defaults for the same check. */
export function effectiveThresholds(all: Threshold[], influencerId: string): Threshold[] {
  const byKey = new Map<string, Threshold>();
  for (const t of all.filter((t) => t.influencer_id === null)) byKey.set(t.check_key, t);
  for (const t of all.filter((t) => t.influencer_id === influencerId)) byKey.set(t.check_key, t);
  return [...byKey.values()].sort((a, b) => a.check_key.localeCompare(b.check_key));
}

export function evaluateQa(engineQa: QaResult[], thresholds: Threshold[]): QaDecision {
  const outcomes: ThresholdOutcome[] = thresholds.map((t) => {
    const result = engineQa.find((q) => q.check === t.check_key);
    const score = typeof result?.score === 'number' ? result.score : null;
    let reason: string | null = null;
    if (score === null) {
      if (t.required || t.min_score !== null || t.max_score !== null) reason = `no score reported for ${t.check_key}`;
    } else if (t.min_score !== null && score < t.min_score) {
      reason = `${t.check_key} ${score} < ${t.min_score}`;
    } else if (t.max_score !== null && score > t.max_score) {
      reason = `${t.check_key} ${score} > ${t.max_score}`;
    }
    // A threshold that only sets bounds and gets no score is a failure only if required.
    if (score === null && !t.required) reason = null;
    return { threshold_id: t.id, check_key: t.check_key, score, passed: reason === null, on_fail: t.on_fail, reason };
  });
  const rejecting = outcomes.filter((o) => !o.passed && o.on_fail === 'reject');
  const flagging = outcomes.filter((o) => !o.passed && o.on_fail === 'flag');
  return {
    status: rejecting.length > 0 ? 'rejected' : 'valid',
    flagged: flagging.length > 0,
    outcomes,
    reasons: [...rejecting, ...flagging].map((o) => o.reason!),
  };
}
