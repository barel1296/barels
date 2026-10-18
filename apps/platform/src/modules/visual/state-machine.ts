/**
 * Platform visual job state machine (contracts/visual-engine/README.md §6.2).
 * Kept free of I/O so it can be unit-tested exhaustively.
 */
export type JobState =
  | 'queued'
  | 'dispatching'
  | 'submitted'
  | 'running'
  | 'ingesting'
  | 'succeeded'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled'
  | 'timed_out';

export const TERMINAL_STATES: ReadonlySet<JobState> = new Set(['succeeded', 'failed', 'cancelled']);

/** States in which the job occupies an engine slot. */
export const SLOT_STATES: readonly JobState[] = ['dispatching', 'submitted', 'running', 'cancel_requested', 'timed_out'];

/** States the poller reconciles against the engine. */
export const POLLED_STATES: readonly JobState[] = ['submitted', 'running', 'cancel_requested', 'timed_out'];

export const TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  queued: ['dispatching', 'cancelled', 'failed'],
  // failed: terminal submit error; queued: transient submit error (same attempt) or
  // stale lease recovery; cancel_requested: cancelled while the submit was in flight.
  dispatching: ['submitted', 'queued', 'failed', 'cancel_requested'],
  submitted: ['running', 'ingesting', 'queued', 'failed', 'cancel_requested', 'timed_out'],
  running: ['ingesting', 'queued', 'failed', 'cancel_requested', 'timed_out'],
  ingesting: ['succeeded', 'queued', 'failed'],
  cancel_requested: ['cancelled'],
  timed_out: ['queued', 'failed'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(state: JobState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Retry delay after a failed attempt: exponential backoff with full jitter,
 * never earlier than the engine's retry_after_ms (contract §8).
 */
export function retryDelayMs(
  attempt: number,
  policy: { baseMs: number; maxMs: number },
  retryAfterMs: number | null | undefined,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.floor(random() * ceiling);
  return Math.max(jittered, retryAfterMs ?? 0);
}
