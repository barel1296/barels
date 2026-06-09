'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, errorMessage } from '@/lib/api';
import { Card, EmptyState, ErrorNote, Pill, Spinner } from '@/components/ui';
import { timeAgo } from '@/lib/format';

interface ActionRow {
  id: string;
  kind: string;
  status: string;
  diff: { summary?: string; entries?: { field: string; entity: string; before: unknown; after: unknown }[] };
  diff_hash: string;
  guardrail_eval: { key: string; passed: boolean }[];
  recommendation_title: string | null;
  confidence: string | null;
  session_id: string | null;
  expires_at: string | null;
  created_at: string;
}

export default function ApprovalsPage() {
  const [items, setItems] = useState<ActionRow[] | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [filter, setFilter] = useState('awaiting_approval');

  const load = (status: string) =>
    api<{ items: ActionRow[] }>(`/v1/actions${status ? `?status=${status}` : ''}`)
      .then((r) => setItems(r.items))
      .catch((e) => setError(errorMessage(e)));

  useEffect(() => {
    void load(filter);
  }, [filter]);

  const approve = async (a: ActionRow) => {
    setNote('');
    try {
      // Echo the diff hash of exactly what this screen displayed.
      const res = await api<{ status: string; note?: string }>(`/v1/actions/${a.id}/approve`, {
        method: 'POST',
        json: { confirmDiffHash: a.diff_hash },
      });
      setNote(res.note ?? `Action ${res.status}.`);
      await load(filter);
    } catch (err) {
      setNote(errorMessage(err));
    }
  };

  const reject = async (a: ActionRow) => {
    const reason = window.prompt('Rejection reason (recorded):');
    if (reason === null) return;
    try {
      await api(`/v1/actions/${a.id}/reject`, {
        method: 'POST',
        json: { reasonCode: 'other', note: reason || 'rejected' },
      });
      await load(filter);
    } catch (err) {
      setNote(errorMessage(err));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-zinc-100">Approvals</h1>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-300">
          <option value="awaiting_approval">awaiting approval</option>
          <option value="approved">approved</option>
          <option value="rejected">rejected</option>
          <option value="expired">expired</option>
          <option value="">all</option>
        </select>
      </div>
      {error && <ErrorNote message={error} />}
      {note && <div className="text-amber-300">{note}</div>}
      {!items ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState>Nothing here. The agents will prepare actions for approval.</EmptyState>
      ) : (
        <div className="space-y-3">
          {items.map((a) => (
            <Card key={a.id}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Pill value={a.kind} />
                    <Pill value={a.status} />
                    <span className="text-xs text-zinc-500">{timeAgo(a.created_at)}</span>
                  </div>
                  <div className="mt-2 font-medium text-zinc-200">
                    {a.recommendation_title ?? a.diff?.summary ?? a.kind}
                  </div>
                  {(a.diff?.entries ?? []).map((d, i) => (
                    <div key={i} className="mt-1.5 inline-block rounded bg-zinc-800/60 px-2 py-1 text-xs tabular-nums">
                      <span className="text-zinc-500">{d.entity} · {d.field}: </span>
                      <span className="text-rose-300 line-through">{String(d.before)}</span>
                      <span className="text-zinc-500"> → </span>
                      <span className="text-emerald-300">{String(d.after)}</span>
                    </div>
                  ))}
                  <div className="mt-2 flex flex-wrap gap-1">
                    {(a.guardrail_eval ?? []).map((g) => (
                      <span key={g.key} className={`rounded px-1.5 py-0.5 text-[10px] ${
                        g.passed ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'
                      }`}>
                        {g.passed ? '✓' : '✗'} {g.key}
                      </span>
                    ))}
                  </div>
                  {a.session_id && (
                    <Link href={`/war-room/${a.session_id}`} className="mt-2 inline-block text-xs text-indigo-400 hover:underline">
                      view investigation →
                    </Link>
                  )}
                </div>
                {a.status === 'awaiting_approval' && (
                  <div className="flex shrink-0 flex-col gap-2">
                    <button onClick={() => approve(a)}
                      className="rounded-md bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-emerald-500">
                      Approve
                    </button>
                    <button onClick={() => reject(a)}
                      className="rounded-md border border-zinc-700 px-4 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">
                      Reject
                    </button>
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
