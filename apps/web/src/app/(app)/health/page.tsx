'use client';

import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { Card, EmptyState, ErrorNote, Pill, Spinner } from '@/components/ui';
import { timeAgo } from '@/lib/format';

interface Domain {
  domain: string;
  status: string;
  reasons: unknown[];
  declared_by: string;
  declared_at: string;
}
interface Check {
  id: string;
  check_key: string;
  domain: string;
  status: string;
  observed: Record<string, unknown>;
  run_at: string;
}
interface Violation {
  event_name: string;
  reason: string;
  count: string;
  last_seen: string;
}

export default function HealthPage() {
  const [domains, setDomains] = useState<Domain[] | null>(null);
  const [checks, setChecks] = useState<Check[]>([]);
  const [violations, setViolations] = useState<Violation[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api<{ items: Domain[] }>('/v1/health/status'),
      api<{ items: Check[] }>('/v1/health/checks'),
      api<{ items: Violation[] }>('/v1/taxonomy/violations'),
    ])
      .then(([d, c, v]) => {
        setDomains(d.items);
        setChecks(c.items);
        setViolations(v.items);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  if (error) return <ErrorNote message={error} />;
  if (!domains) return <Spinner />;

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-zinc-100">Tracking Health Center</h1>

      <div className="grid grid-cols-5 gap-3">
        {domains.map((d) => (
          <Card key={d.domain}>
            <div className="flex items-center justify-between">
              <span className="font-medium capitalize text-zinc-200">{d.domain}</span>
              <Pill value={d.status} />
            </div>
            <div className="mt-2 text-xs text-zinc-500">
              by {d.declared_by} · {timeAgo(d.declared_at)}
            </div>
            {d.reasons.length > 0 && (
              <pre className="mt-2 overflow-x-auto rounded bg-zinc-950 p-2 text-[10px] text-zinc-400">
                {JSON.stringify(d.reasons, null, 1)}
              </pre>
            )}
          </Card>
        ))}
      </div>

      <Card title="Data quality checks">
        {checks.length === 0 ? (
          <EmptyState>
            No reconciliation results yet — checks run as connectors sync.
          </EmptyState>
        ) : (
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="uppercase tracking-wider text-zinc-500">
                <th className="pb-2">Check</th>
                <th className="pb-2">Domain</th>
                <th className="pb-2">Status</th>
                <th className="pb-2">Observed</th>
                <th className="pb-2">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {checks.map((c) => (
                <tr key={c.id}>
                  <td className="py-2 text-zinc-300">{c.check_key}</td>
                  <td className="py-2 text-zinc-400">{c.domain}</td>
                  <td className="py-2"><Pill value={c.status} /></td>
                  <td className="py-2 font-mono text-[10px] text-zinc-500">
                    {JSON.stringify(c.observed).slice(0, 80)}
                  </td>
                  <td className="py-2 text-zinc-500">{timeAgo(c.run_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Event taxonomy violations (quarantined events)">
        {violations.length === 0 ? (
          <EmptyState>No taxonomy violations — all ingested events are canonical.</EmptyState>
        ) : (
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="uppercase tracking-wider text-zinc-500">
                <th className="pb-2">Event</th>
                <th className="pb-2">Reason</th>
                <th className="pb-2">Count</th>
                <th className="pb-2">Last seen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {violations.map((v) => (
                <tr key={`${v.event_name}-${v.reason}`}>
                  <td className="py-2 font-mono text-zinc-300">{v.event_name}</td>
                  <td className="py-2 text-zinc-400">{v.reason}</td>
                  <td className="py-2 tabular-nums text-zinc-300">{v.count}</td>
                  <td className="py-2 text-zinc-500">{timeAgo(v.last_seen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
