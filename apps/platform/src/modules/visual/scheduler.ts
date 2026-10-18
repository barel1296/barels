/**
 * GPU-aware media scheduling policy (docs/13 §6, contract §9). Pure functions:
 * the dispatcher loads candidates and in-flight jobs, these functions decide.
 *
 * Priority classes reaching the engine: P2 time_sensitive, P3 scheduled_image,
 * P4 video, P5 maintenance. P0 (payments) never touches the GPU and P1 (chat)
 * runs on the local LLM, which the scheduler protects by never dispatching
 * beyond the engine's slots and the measured media-lane VRAM budget.
 */
export interface Candidate {
  id: string;
  influencerId: string;
  priority: number; // 2..5
  createdAt: Date;
  /** When the job entered `queued` for its current attempt (aging basis). */
  queuedSince: Date;
  deadlineAt: Date | null;
  gpuRequired: boolean;
  /** Measured peak VRAM of the workflow; null = unmeasured (needs the whole lane). */
  vramMbPeak: number | null;
  /** GPU-seconds this influencer consumed today and its daily fair-share quota. */
  usedGpuSecondsToday: number;
  quotaGpuSecondsPerDay: number | null;
}

export interface InFlight {
  gpuRequired: boolean;
  vramMbPeak: number | null;
}

export interface SchedulingPolicy {
  /** A queued job gains one priority class after this many seconds (max one class, never above P2). */
  agingStepSeconds: number;
  /** Jobs whose deadline is closer than this are treated as P2. */
  deadlineUrgencySeconds: number;
}

export const HIGHEST_MEDIA_PRIORITY = 2;

export function effectivePriority(c: Candidate, now: Date, policy: SchedulingPolicy): number {
  const waitedS = Math.max(0, (now.getTime() - c.queuedSince.getTime()) / 1000);
  const aged = waitedS >= policy.agingStepSeconds ? c.priority - 1 : c.priority;
  let p = Math.max(HIGHEST_MEDIA_PRIORITY, aged);
  if (c.deadlineAt && c.deadlineAt.getTime() - now.getTime() <= policy.deadlineUrgencySeconds * 1000) {
    p = HIGHEST_MEDIA_PRIORITY;
  }
  return p;
}

export function isOverQuota(c: Candidate): boolean {
  return c.quotaGpuSecondsPerDay !== null && c.usedGpuSecondsToday >= c.quotaGpuSecondsPerDay;
}

/**
 * Orders candidates: influencers within their daily GPU quota first (fair
 * share across 20–30 personas), then effective priority, then earliest
 * deadline, then FIFO.
 */
export function rankCandidates(candidates: Candidate[], now: Date, policy: SchedulingPolicy): Candidate[] {
  const keyed = candidates.map((c) => ({
    c,
    over: isOverQuota(c) ? 1 : 0,
    p: effectivePriority(c, now, policy),
    deadline: c.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY,
  }));
  keyed.sort(
    (a, b) =>
      a.over - b.over ||
      a.p - b.p ||
      a.deadline - b.deadline ||
      a.c.createdAt.getTime() - b.c.createdAt.getTime() ||
      (a.c.id < b.c.id ? -1 : 1),
  );
  return keyed.map((k) => k.c);
}

/**
 * VRAM admission for the media lane. Jobs that need no GPU are always
 * admissible. A GPU job is admitted alongside other GPU jobs only when every
 * figure involved is measured and the sum fits the measured lane budget;
 * otherwise GPU jobs run one at a time.
 */
export function canAdmit(candidate: Pick<Candidate, 'gpuRequired' | 'vramMbPeak'>, inFlight: InFlight[], laneBudgetMb: number | null): boolean {
  if (!candidate.gpuRequired) return true;
  const gpu = inFlight.filter((j) => j.gpuRequired);
  if (gpu.length === 0) return true;
  if (laneBudgetMb === null || candidate.vramMbPeak === null || gpu.some((j) => j.vramMbPeak === null)) return false;
  const used = gpu.reduce((sum, j) => sum + (j.vramMbPeak ?? 0), 0);
  return used + candidate.vramMbPeak <= laneBudgetMb;
}

/**
 * Picks the jobs to dispatch to one engine this tick. `slots` is the engine's
 * free concurrency. Strict head-of-line for GPU jobs: if the best GPU
 * candidate does not fit, no lower-ranked GPU job jumps ahead of it (prevents
 * starvation of large jobs); non-GPU jobs may still use free slots.
 */
export function selectForDispatch(
  ranked: Candidate[],
  inFlight: InFlight[],
  slots: number,
  laneBudgetMb: number | null,
): Candidate[] {
  const chosen: Candidate[] = [];
  const running = [...inFlight];
  let gpuBlocked = false;
  for (const c of ranked) {
    if (chosen.length >= slots) break;
    if (c.gpuRequired && gpuBlocked) continue;
    if (!canAdmit(c, running, laneBudgetMb)) {
      if (c.gpuRequired) gpuBlocked = true;
      continue;
    }
    chosen.push(c);
    running.push({ gpuRequired: c.gpuRequired, vramMbPeak: c.vramMbPeak });
  }
  return chosen;
}
