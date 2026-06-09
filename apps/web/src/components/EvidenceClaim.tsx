'use client';

import { bindClaim } from '@gros/shared';

/**
 * Evidence-bound claim renderer (docs/06 §6.2): numeric values are
 * substituted from evidence digests. A token that cannot be resolved renders
 * as an explicit [unverified value] error chip — an unsupported number is
 * structurally unrenderable in this UI.
 */
export function EvidenceClaim({
  claim,
  digests,
  onEvidenceClick,
}: {
  claim: string;
  digests: Map<string, Record<string, unknown>>;
  onEvidenceClick?: (evidenceId: string) => void;
}) {
  const segments = bindClaim(claim, digests);
  return (
    <span>
      {segments.map((seg, i) => {
        if (seg.kind === 'text') return <span key={i}>{seg.text}</span>;
        if (seg.kind === 'error') {
          return (
            <span
              key={i}
              title={`Unresolvable evidence reference (${seg.evidenceId ?? '?'}:${seg.path ?? '?'})`}
              className="mx-0.5 rounded border border-rose-500/40 bg-rose-500/10 px-1 text-[11px] font-medium text-rose-400"
            >
              {seg.text}
            </span>
          );
        }
        return (
          <button
            key={i}
            type="button"
            onClick={() => seg.evidenceId && onEvidenceClick?.(seg.evidenceId)}
            className="mx-0.5 rounded border border-indigo-500/40 bg-indigo-500/10 px-1 font-medium tabular-nums text-indigo-300 hover:bg-indigo-500/20"
            title={`evidence ${seg.evidenceId?.slice(0, 8)} · ${seg.path}`}
          >
            {seg.text}
          </button>
        );
      })}
    </span>
  );
}
