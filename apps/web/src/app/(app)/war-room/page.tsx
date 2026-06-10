'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, errorMessage } from '@/lib/api';
import { Card, ConfidenceBar, EmptyState, ErrorNote, Pill, Spinner } from '@/components/ui';
import { fmtUsd, timeAgo } from '@/lib/format';

interface SessionRow {
  id: string;
  title: string;
  playbook_key: string;
  phase: string;
  status: string;
  money_at_stake_usd: string | null;
  confidence: string | null;
  decision_outcome: string | null;
  created_at: string;
}

export default function WarRoomList() {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState('');
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<{ items: SessionRow[] }>('/v1/sessions')
      .then((r) => setSessions(r.items))
      .catch((e) => setError(errorMessage(e)));

  useEffect(() => {
    void load();
  }, []);

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    if (question.trim().length < 5) return;
    setBusy(true);
    setError('');
    try {
      const res = await api<{ id: string }>('/v1/sessions', {
        method: 'POST',
        json: { question, playbookKey: 'roas_drop', scope: {} },
      });
      window.location.href = `/war-room/${res.id}`;
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-zinc-100">War Room</h1>
      </div>

      <form onSubmit={start} className="flex gap-2">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder='Ask the room — e.g. "Why did ROAS drop in Germany last week?"'
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-100 placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
        />
        <button
          disabled={busy || question.trim().length < 5}
          className="rounded-md bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          Investigate
        </button>
      </form>
      {error && <ErrorNote message={error} />}

      <Card title="Sessions">
        {!sessions ? (
          <Spinner />
        ) : sessions.length === 0 ? (
          <EmptyState>
            No sessions yet. Ask the room a question, or run the dev seed for a
            demo investigation.
          </EmptyState>
        ) : (
          <table className="w-full text-left">
            <thead>
              <tr className="text-xs uppercase tracking-wider text-zinc-500">
                <th className="pb-2">Session</th>
                <th className="pb-2">Playbook</th>
                <th className="pb-2">Phase</th>
                <th className="pb-2">Status</th>
                <th className="pb-2">$ at stake</th>
                <th className="pb-2">Confidence</th>
                <th className="pb-2">Age</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {sessions.map((s) => (
                <tr key={s.id} className="hover:bg-zinc-900/60">
                  <td className="py-2 pr-2">
                    <Link href={`/war-room/${s.id}`} className="font-medium text-zinc-100 hover:text-indigo-300">
                      {s.title}
                    </Link>
                  </td>
                  <td className="py-2 pr-2 text-zinc-400">{s.playbook_key}</td>
                  <td className="py-2 pr-2 text-zinc-400">{s.phase}</td>
                  <td className="py-2 pr-2"><Pill value={s.status} /></td>
                  <td className="py-2 pr-2 tabular-nums text-zinc-300">
                    {s.money_at_stake_usd ? fmtUsd(s.money_at_stake_usd) : '—'}
                  </td>
                  <td className="py-2 pr-2">
                    {s.confidence != null ? <ConfidenceBar value={s.confidence} /> : '—'}
                  </td>
                  <td className="py-2 text-zinc-500">{timeAgo(s.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
