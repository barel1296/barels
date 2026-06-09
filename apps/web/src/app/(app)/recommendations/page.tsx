'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, errorMessage } from '@/lib/api';
import { Card, ConfidenceBar, EmptyState, ErrorNote, Pill, Spinner } from '@/components/ui';
import { fmtUsd, timeAgo } from '@/lib/format';

interface Rec {
  id: string;
  title: string;
  summary: string;
  category: string;
  confidence: string;
  predicted_impact: { metric: string; low: number; high: number; horizonDays: number } | null;
  status: string;
  session_id: string | null;
  created_at: string;
}

export default function RecommendationsPage() {
  const [items, setItems] = useState<Rec[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ items: Rec[] }>('/v1/recommendations')
      .then((r) => setItems(r.items))
      .catch((e) => setError(errorMessage(e)));
  }, []);

  if (error) return <ErrorNote message={error} />;
  if (!items) return <Spinner />;

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-zinc-100">Recommendations</h1>
      {items.length === 0 ? (
        <EmptyState>No recommendations yet.</EmptyState>
      ) : (
        <div className="space-y-3">
          {items.map((r) => (
            <Card key={r.id}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <Pill value={r.category} />
                    <Pill value={r.status} />
                    <span className="text-xs text-zinc-500">{timeAgo(r.created_at)}</span>
                  </div>
                  <div className="mt-2 font-medium text-zinc-100">{r.title}</div>
                  <p className="mt-1 text-zinc-400">{r.summary}</p>
                </div>
                <div className="shrink-0 space-y-2 text-right">
                  <ConfidenceBar value={r.confidence} />
                  {r.predicted_impact && (
                    <div className="text-xs tabular-nums text-zinc-400">
                      {fmtUsd(r.predicted_impact.low)}–{fmtUsd(r.predicted_impact.high)}
                      <span className="text-zinc-600"> / {r.predicted_impact.horizonDays}d</span>
                    </div>
                  )}
                  {r.session_id && (
                    <Link href={`/war-room/${r.session_id}`} className="block text-xs text-indigo-400 hover:underline">
                      investigation →
                    </Link>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
