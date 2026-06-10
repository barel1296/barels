'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, errorMessage } from '@/lib/api';
import { Card, ConfidenceBar, EmptyState, ErrorNote, Pill, Sparkline, Spinner } from '@/components/ui';
import { fmtNum, fmtUsd, timeAgo } from '@/lib/format';

interface MetricRow {
  bucket?: string;
  value?: number | string | null;
}
interface CommandCenter {
  kpis: {
    spend: MetricRow[];
    roasD7: MetricRow[];
    installs: MetricRow[];
    cpi: MetricRow[];
    freshness: string | null;
  };
  health: { domain: string; status: string }[];
  signals: {
    risks: Anomaly[];
    opportunities: Anomaly[];
  };
  recommendations: Rec[];
  awaitingApproval: number;
  runningSessions: number;
}
interface Anomaly {
  id: string;
  metric_key: string;
  direction: string;
  magnitude: string | null;
  detector: string;
  materiality_usd: string | null;
  status: string;
  session_id: string | null;
  detected_at: string;
}
interface Rec {
  id: string;
  title: string;
  category: string;
  confidence: string;
  session_id: string | null;
}

function values(rows: MetricRow[]): number[] {
  return rows.map((r) => Number(r.value ?? 0)).filter((v) => Number.isFinite(v));
}

function Kpi({ label, rows, money }: { label: string; rows: MetricRow[]; money?: boolean }) {
  const vs = values(rows);
  const last = vs[vs.length - 1] ?? 0;
  const prev = vs[vs.length - 2] ?? last;
  const delta = prev !== 0 ? (last - prev) / prev : 0;
  return (
    <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
      <div>
        <div className="text-xs uppercase tracking-wider text-zinc-500">{label}</div>
        <div className="mt-1 text-xl font-semibold tabular-nums text-zinc-100">
          {money ? fmtUsd(last) : fmtNum(last)}
        </div>
        <div className={`text-xs tabular-nums ${delta < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
          {delta >= 0 ? '+' : ''}
          {(delta * 100).toFixed(1)}% vs prev day
        </div>
      </div>
      <Sparkline values={vs} />
    </div>
  );
}

export default function CommandCenterPage() {
  const [data, setData] = useState<CommandCenter | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<CommandCenter>('/v1/dashboard/command-center')
      .then(setData)
      .catch((e) => setError(errorMessage(e)));
  }, []);

  if (error) return <ErrorNote message={error} />;
  if (!data) return <Spinner />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-zinc-100">Command Center</h1>
        <div className="flex items-center gap-3 text-xs text-zinc-500">
          <span>
            data through{' '}
            <span className="text-zinc-300">{data.kpis.freshness ?? 'n/a'}</span>
          </span>
          <Link href="/approvals"
            className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 font-medium text-amber-300 hover:bg-amber-500/20">
            {data.awaitingApproval} awaiting approval
          </Link>
          <Link href="/war-room"
            className="rounded-md border border-sky-500/40 bg-sky-500/10 px-2.5 py-1 font-medium text-sky-300 hover:bg-sky-500/20">
            {data.runningSessions} live sessions
          </Link>
        </div>
      </div>

      {/* health strip */}
      <div className="flex gap-2">
        {data.health.map((h) => (
          <div key={h.domain}
            className="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1">
            <span className={`h-1.5 w-1.5 rounded-full ${
              h.status === 'green' ? 'bg-emerald-400' : h.status === 'yellow' ? 'bg-amber-400' : 'bg-rose-400'
            }`} />
            <span className="text-xs text-zinc-400">{h.domain}</span>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-4 gap-3">
        <Kpi label="Spend / day" rows={data.kpis.spend} money />
        <Kpi label="ROAS D7" rows={data.kpis.roasD7} />
        <Kpi label="Installs / day" rows={data.kpis.installs} />
        <Kpi label="CPI" rows={data.kpis.cpi} money />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Card title="Where money is at risk">
          {data.signals.risks.length === 0 ? (
            <EmptyState>No active risk signals.</EmptyState>
          ) : (
            <ul className="space-y-2">
              {data.signals.risks.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2">
                  <div>
                    <span className="font-medium text-zinc-200">{a.metric_key}</span>
                    <span className="ml-2 text-zinc-500">
                      {a.detector} · {timeAgo(a.detected_at)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="tabular-nums text-rose-400">
                      {fmtUsd(a.materiality_usd)} at stake
                    </span>
                    {a.session_id ? (
                      <Link href={`/war-room/${a.session_id}`} className="text-indigo-400 hover:underline">
                        session →
                      </Link>
                    ) : (
                      <Pill value={a.status} />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Scale opportunities">
          {data.signals.opportunities.length === 0 ? (
            <EmptyState>No active opportunity signals.</EmptyState>
          ) : (
            <ul className="space-y-2">
              {data.signals.opportunities.map((a) => (
                <li key={a.id} className="flex items-center justify-between">
                  <span className="font-medium text-zinc-200">{a.metric_key}</span>
                  <span className="tabular-nums text-emerald-400">
                    {fmtUsd(a.materiality_usd)} potential
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="What the agents recommend now">
        {data.recommendations.length === 0 ? (
          <EmptyState>No open recommendations.</EmptyState>
        ) : (
          <ul className="divide-y divide-zinc-800">
            {data.recommendations.map((r) => (
              <li key={r.id} className="flex items-center justify-between py-2">
                <div className="flex items-center gap-2">
                  <Pill value={r.category} />
                  <span className="text-zinc-200">{r.title}</span>
                </div>
                <div className="flex items-center gap-3">
                  <ConfidenceBar value={r.confidence} />
                  {r.session_id && (
                    <Link href={`/war-room/${r.session_id}`} className="text-indigo-400 hover:underline">
                      open →
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
