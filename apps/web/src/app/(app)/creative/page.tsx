'use client';

import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { Card, EmptyState, ErrorNote, Sparkline, Spinner } from '@/components/ui';
import { fmtNum, timeAgo } from '@/lib/format';

interface Creative {
  id: string;
  name: string;
  format: string;
  duration_s: number | null;
  language: string | null;
  tags: Record<string, string>;
  first_seen_at: string | null;
}

interface SeriesState {
  [creativeId: string]: number[];
}

export default function CreativePage() {
  const [creatives, setCreatives] = useState<Creative[] | null>(null);
  const [series, setSeries] = useState<SeriesState>({});
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ items: Creative[] }>('/v1/dashboard/creatives')
      .then(async (r) => {
        setCreatives(r.items);
        const to = new Date().toISOString().slice(0, 10);
        const from = new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10);
        // Per-creative IPM series via the semantic layer — the only read path.
        const results = await Promise.all(
          r.items.slice(0, 12).map(async (c) => {
            try {
              const res = await api<{ rows: { value?: number | string }[] }>(
                '/v1/metrics/query',
                {
                  method: 'POST',
                  json: {
                    metricKey: 'creative_ipm',
                    grain: 'day',
                    dimensions: [],
                    filters: { creative_id: c.id },
                    range: { from, to },
                  },
                },
              );
              return [c.id, res.rows.map((row) => Number(row.value ?? 0))] as const;
            } catch {
              return [c.id, []] as const;
            }
          }),
        );
        setSeries(Object.fromEntries(results));
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  if (error) return <ErrorNote message={error} />;
  if (!creatives) return <Spinner />;

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-zinc-100">Creative Intelligence</h1>
      {creatives.length === 0 ? (
        <EmptyState>No creatives registered yet.</EmptyState>
      ) : (
        <Card title="Creative inventory — 28d IPM trend">
          <table className="w-full text-left">
            <thead>
              <tr className="text-xs uppercase tracking-wider text-zinc-500">
                <th className="pb-2">Creative</th>
                <th className="pb-2">Hook</th>
                <th className="pb-2">Format</th>
                <th className="pb-2">IPM trend</th>
                <th className="pb-2">Latest IPM</th>
                <th className="pb-2">First seen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {creatives.map((c) => {
                const s = series[c.id] ?? [];
                const last = s[s.length - 1];
                const peak = s.length ? Math.max(...s) : 0;
                const declining = peak > 0 && last !== undefined && last < peak * 0.75;
                return (
                  <tr key={c.id} className="hover:bg-zinc-900/60">
                    <td className="py-2 pr-2">
                      <span className="font-medium text-zinc-200">{c.name}</span>
                      {declining && (
                        <span className="ml-2 rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-medium text-rose-400">
                          fatigue risk
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-2 text-zinc-400">{c.tags?.hook_type ?? '—'}</td>
                    <td className="py-2 pr-2 text-zinc-400">
                      {c.format}
                      {c.duration_s ? ` · ${c.duration_s}s` : ''}
                    </td>
                    <td className="py-2 pr-2">
                      {s.length > 1 ? <Sparkline values={s} /> : <span className="text-zinc-600">no data</span>}
                    </td>
                    <td className="py-2 pr-2 tabular-nums text-zinc-300">
                      {last !== undefined ? fmtNum(last) : '—'}
                    </td>
                    <td className="py-2 text-zinc-500">{timeAgo(c.first_seen_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
      <p className="text-xs text-zinc-600">
        Fatigue badges here are display heuristics over semantic-layer series; agent-grade fatigue
        diagnosis (fitted decay curves) runs in War Room investigations.
      </p>
    </div>
  );
}
