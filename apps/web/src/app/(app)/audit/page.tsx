'use client';

import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { Card, EmptyState, ErrorNote, Spinner } from '@/components/ui';
import { timeAgo } from '@/lib/format';

interface AuditRow {
  id: string;
  actor_type: string;
  actor_id: string;
  event: string;
  object_type: string;
  object_id: string;
  after_ref: unknown;
  at: string;
}

export default function AuditPage() {
  const [items, setItems] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ items: AuditRow[] }>('/v1/audit-logs?limit=100')
      .then((r) => setItems(r.items))
      .catch((e) => setError(errorMessage(e)));
  }, []);

  if (error) return <ErrorNote message={error} />;
  if (!items) return <Spinner />;

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-zinc-100">Audit Log</h1>
      <Card>
        {items.length === 0 ? (
          <EmptyState>No audit events yet.</EmptyState>
        ) : (
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="uppercase tracking-wider text-zinc-500">
                <th className="pb-2">Event</th>
                <th className="pb-2">Actor</th>
                <th className="pb-2">Object</th>
                <th className="pb-2">Detail</th>
                <th className="pb-2">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {items.map((row) => (
                <tr key={row.id} className="align-top hover:bg-zinc-900/60">
                  <td className="py-2 pr-3 font-medium text-zinc-200">{row.event}</td>
                  <td className="py-2 pr-3 text-zinc-400">
                    {row.actor_type}
                    <span className="block font-mono text-[10px] text-zinc-600">
                      {row.actor_id.slice(0, 18)}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-zinc-400">
                    {row.object_type}
                    <span className="block font-mono text-[10px] text-zinc-600">
                      {row.object_id.slice(0, 18)}
                    </span>
                  </td>
                  <td className="py-2 pr-3 font-mono text-[10px] text-zinc-500">
                    {row.after_ref ? JSON.stringify(row.after_ref).slice(0, 100) : '—'}
                  </td>
                  <td className="py-2 whitespace-nowrap text-zinc-500">{timeAgo(row.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <p className="text-xs text-zinc-600">
        Audit records are append-only at the database level (UPDATE/DELETE are rejected by trigger).
      </p>
    </div>
  );
}
