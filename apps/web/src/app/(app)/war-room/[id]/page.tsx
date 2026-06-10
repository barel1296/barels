'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, errorMessage } from '@/lib/api';
import { Card, ConfidenceBar, ErrorNote, Pill, Spinner } from '@/components/ui';
import { EvidenceClaim } from '@/components/EvidenceClaim';
import { fmtUsd, timeAgo } from '@/lib/format';

interface Message {
  id: string;
  agent: string;
  type: string;
  claim: string;
  payload: Record<string, unknown>;
  evidence_ids: string[];
  confidence: string | null;
  in_reply_to: string | null;
  seq: number;
  created_at: string;
}
interface Evidence {
  id: string;
  kind: string;
  metric_key: string | null;
  params: Record<string, unknown>;
  sql_hash: string;
  result_digest: Record<string, unknown>;
  freshness_at: string | null;
  executed_at: string;
}
interface ActionRow {
  id: string;
  kind: string;
  status: string;
  diff: { summary?: string; entries?: { field: string; entity: string; before: unknown; after: unknown }[] };
  diffHash: string;
  guardrailEval: { key: string; passed: boolean; observed: Record<string, unknown>; limit: Record<string, unknown> }[];
  rollbackPlan: Record<string, unknown>;
  monitoringPlan: Record<string, unknown>;
  expiresAt: string | null;
}
interface SessionDetail {
  id: string;
  title: string;
  playbook_key: string;
  phase: string;
  status: string;
  abstract: string | null;
  money_at_stake_usd: string | null;
  decision: {
    outcome?: string;
    chosenOption?: string;
    rejectedAlternatives?: { option: string; reason: string }[];
    confidence?: number;
    confidenceBreakdown?: Record<string, number>;
    predictedImpact?: { metric: string; low: number; mid: number; high: number; horizonDays: number } | null;
    riskStatement?: string;
    reEvaluationConditions?: string[];
  } | null;
  actions: ActionRow[] | null;
  recommendations: { id: string; title: string; confidence: string }[] | null;
  created_at: string;
}

const AGENT_STYLE: Record<string, string> = {
  growth_director: 'border-purple-500/40 text-purple-300',
  intelligence: 'border-sky-500/40 text-sky-300',
  creative: 'border-pink-500/40 text-pink-300',
  tracking: 'border-emerald-500/40 text-emerald-300',
  operations: 'border-amber-500/40 text-amber-300',
  orchestrator: 'border-zinc-600 text-zinc-400',
  user: 'border-indigo-500/40 text-indigo-300',
};

export default function SessionPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [error, setError] = useState('');
  const [openEvidence, setOpenEvidence] = useState<string | null>(null);
  const [directive, setDirective] = useState('');
  const [actionNote, setActionNote] = useState('');

  const load = useCallback(async () => {
    try {
      const [s, m, e] = await Promise.all([
        api<SessionDetail>(`/v1/sessions/${id}`),
        api<{ items: Message[] }>(`/v1/sessions/${id}/messages`),
        api<{ items: Evidence[] }>(`/v1/sessions/${id}/evidence`),
      ]);
      setSession(s);
      setMessages(m.items);
      setEvidence(e.items);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live updates while running.
  useEffect(() => {
    if (!session || session.status !== 'running') return;
    const t = setInterval(() => void load(), 2500);
    return () => clearInterval(t);
  }, [session, load]);

  if (error) return <ErrorNote message={error} />;
  if (!session) return <Spinner />;

  const digests = new Map(evidence.map((e) => [e.id, e.result_digest]));
  const decision = session.decision;

  const approve = async (action: ActionRow) => {
    setActionNote('');
    try {
      // The diff-hash echo: we send the hash of the diff we RENDERED.
      const res = await api<{ status: string; note?: string }>(
        `/v1/actions/${action.id}/approve`,
        { method: 'POST', json: { confirmDiffHash: action.diffHash } },
      );
      setActionNote(res.note ?? `Action ${res.status}.`);
      await load();
    } catch (err) {
      setActionNote(errorMessage(err));
    }
  };

  const reject = async (action: ActionRow) => {
    const note = window.prompt('Why reject? (recorded for the learning loop)');
    if (note === null) return;
    try {
      await api(`/v1/actions/${action.id}/reject`, {
        method: 'POST',
        json: { reasonCode: 'other', note: note || 'rejected from war room' },
      });
      setActionNote('Action rejected.');
      await load();
    } catch (err) {
      setActionNote(errorMessage(err));
    }
  };

  const sendDirective = async (e: React.FormEvent) => {
    e.preventDefault();
    if (directive.trim().length < 3) return;
    try {
      await api(`/v1/sessions/${id}/messages`, { method: 'POST', json: { claim: directive } });
      setDirective('');
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">{session.title}</h1>
          <div className="mt-1 flex items-center gap-2 text-xs text-zinc-500">
            <Pill value={session.status} />
            <span>phase: {session.phase}</span>
            <span>· playbook: {session.playbook_key}</span>
            {session.money_at_stake_usd && (
              <span>· {fmtUsd(session.money_at_stake_usd)} at stake</span>
            )}
          </div>
        </div>
      </div>

      {session.abstract && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/80 px-4 py-3 text-zinc-300">
          {session.abstract}
        </div>
      )}

      <div className="grid grid-cols-3 gap-4">
        {/* debate thread */}
        <div className="col-span-2 space-y-2">
          {messages.map((m) => {
            const style = AGENT_STYLE[m.agent] ?? AGENT_STYLE.orchestrator;
            const isChallenge = m.type === 'challenge';
            return (
              <div
                key={m.id}
                className={`rounded-lg border bg-zinc-900/60 px-3 py-2 ${
                  isChallenge ? 'border-rose-500/30' : 'border-zinc-800'
                }`}
              >
                <div className="mb-1 flex items-center gap-2 text-[11px]">
                  <span className={`rounded border px-1.5 py-0.5 font-medium uppercase tracking-wide ${style}`}>
                    {m.agent.replace('_', ' ')}
                  </span>
                  <span className="text-zinc-500">{m.type}</span>
                  {m.in_reply_to && <span className="text-zinc-600">↳ reply</span>}
                  <span className="ml-auto text-zinc-600">#{m.seq}</span>
                </div>
                <div className="leading-relaxed text-zinc-200">
                  <EvidenceClaim claim={m.claim} digests={digests} onEvidenceClick={setOpenEvidence} />
                </div>
                {typeof m.payload?.falsification === 'string' && (
                  <div className="mt-1.5 border-l-2 border-zinc-700 pl-2 text-xs text-zinc-500">
                    falsification: {m.payload.falsification}
                  </div>
                )}
                <div className="mt-1.5 flex items-center gap-2">
                  {m.confidence != null && <ConfidenceBar value={m.confidence} />}
                  {m.evidence_ids.map((eid) => (
                    <button key={eid} onClick={() => setOpenEvidence(eid)}
                      className="rounded border border-zinc-700 bg-zinc-800/60 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:border-indigo-500/50 hover:text-indigo-300">
                      ev:{eid.slice(0, 8)}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}

          <form onSubmit={sendDirective} className="flex gap-2 pt-2">
            <input value={directive} onChange={(e) => setDirective(e.target.value)}
              placeholder="Ask the room / add a constraint — the Growth Director must address it"
              className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-100 placeholder-zinc-500 focus:border-indigo-500 focus:outline-none" />
            <button className="rounded-md border border-zinc-700 px-3 py-2 text-zinc-300 hover:bg-zinc-800">
              Send
            </button>
          </form>
        </div>

        {/* right rail */}
        <div className="space-y-4">
          <Card title="Decision">
            {decision ? (
              <div className="space-y-3 text-zinc-300">
                <div className="flex items-center gap-2">
                  <Pill value={decision.outcome ?? 'pending'} />
                  {decision.confidence != null && <ConfidenceBar value={decision.confidence} />}
                </div>
                <p>{decision.chosenOption}</p>
                {decision.predictedImpact && (
                  <div className="rounded-md bg-zinc-800/60 px-3 py-2 text-xs">
                    <div className="text-zinc-500">predicted impact ({decision.predictedImpact.metric})</div>
                    <div className="mt-0.5 tabular-nums text-zinc-200">
                      {fmtUsd(decision.predictedImpact.low)} – {fmtUsd(decision.predictedImpact.high)}
                      <span className="text-zinc-500"> over {decision.predictedImpact.horizonDays}d</span>
                    </div>
                  </div>
                )}
                {decision.riskStatement && (
                  <div className="text-xs">
                    <span className="text-zinc-500">risk: </span>
                    {decision.riskStatement}
                  </div>
                )}
                {(decision.rejectedAlternatives?.length ?? 0) > 0 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-zinc-500">
                      rejected alternatives ({decision.rejectedAlternatives!.length})
                    </summary>
                    <ul className="mt-1 space-y-1">
                      {decision.rejectedAlternatives!.map((r, i) => (
                        <li key={i}>
                          <span className="text-zinc-300">{r.option}</span>
                          <span className="text-zinc-500"> — {r.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {(decision.reEvaluationConditions?.length ?? 0) > 0 && (
                  <div className="text-xs text-zinc-500">
                    re-evaluate if: {decision.reEvaluationConditions!.join(' · ')}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-zinc-500">No decision yet.</div>
            )}
          </Card>

          <Card title="Prepared actions">
            {actionNote && <div className="mb-2 text-xs text-amber-300">{actionNote}</div>}
            {!session.actions || session.actions.length === 0 ? (
              <div className="text-zinc-500">No actions prepared.</div>
            ) : (
              <div className="space-y-3">
                {session.actions.map((a) => (
                  <div key={a.id} className="rounded-md border border-zinc-800 p-3">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-zinc-200">{a.kind.replace('_', ' ')}</span>
                      <Pill value={a.status} />
                    </div>
                    <div className="mt-1 text-xs text-zinc-400">{a.diff?.summary}</div>
                    {(a.diff?.entries ?? []).map((d, i) => (
                      <div key={i} className="mt-1.5 rounded bg-zinc-800/60 px-2 py-1.5 text-xs tabular-nums">
                        <span className="text-zinc-500">{d.entity} · {d.field}: </span>
                        <span className="text-rose-300 line-through">{String(d.before)}</span>
                        <span className="text-zinc-500"> → </span>
                        <span className="text-emerald-300">{String(d.after)}</span>
                      </div>
                    ))}
                    <div className="mt-2 flex flex-wrap gap-1">
                      {(a.guardrailEval ?? []).map((g) => (
                        <span key={g.key}
                          title={`observed ${JSON.stringify(g.observed)} limit ${JSON.stringify(g.limit)}`}
                          className={`rounded px-1.5 py-0.5 text-[10px] ${
                            g.passed ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'
                          }`}>
                          {g.passed ? '✓' : '✗'} {g.key}
                        </span>
                      ))}
                    </div>
                    <details className="mt-2 text-xs text-zinc-500">
                      <summary className="cursor-pointer">rollback & monitoring</summary>
                      <pre className="mt-1 overflow-x-auto rounded bg-zinc-950 p-2 text-[10px]">
                        {JSON.stringify({ rollback: a.rollbackPlan, monitoring: a.monitoringPlan }, null, 2)}
                      </pre>
                    </details>
                    {a.status === 'awaiting_approval' && (
                      <div className="mt-2 flex gap-2">
                        <button onClick={() => approve(a)}
                          className="flex-1 rounded-md bg-emerald-600 px-2 py-1.5 text-xs font-medium text-white hover:bg-emerald-500">
                          Approve
                        </button>
                        <button onClick={() => reject(a)}
                          className="flex-1 rounded-md border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">
                          Reject
                        </button>
                      </div>
                    )}
                    {a.expiresAt && a.status === 'awaiting_approval' && (
                      <div className="mt-1 text-[10px] text-zinc-600">
                        expires {timeAgo(a.expiresAt).includes('ago') ? 'soon' : ''} {new Date(a.expiresAt).toLocaleString()}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title={`Evidence (${evidence.length})`}>
            <ul className="space-y-1">
              {evidence.map((e) => (
                <li key={e.id}>
                  <button onClick={() => setOpenEvidence(e.id)}
                    className="w-full rounded px-2 py-1 text-left text-xs text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200">
                    <span className="text-zinc-600">{e.kind}</span>{' '}
                    {e.metric_key ?? Object.keys(e.params).join(',') ?? e.id.slice(0, 8)}
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>

      {/* evidence inspector drawer */}
      {openEvidence && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={() => setOpenEvidence(null)}>
          <div className="h-full w-[480px] overflow-y-auto border-l border-zinc-800 bg-zinc-950 p-4"
            onClick={(e) => e.stopPropagation()}>
            {(() => {
              const e = evidence.find((x) => x.id === openEvidence);
              if (!e) return <div className="text-zinc-500">Evidence not found.</div>;
              return (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h2 className="font-semibold text-zinc-100">Evidence Inspector</h2>
                    <button onClick={() => setOpenEvidence(null)} className="text-zinc-500 hover:text-zinc-300">✕</button>
                  </div>
                  <div className="text-xs text-zinc-500">
                    {e.kind} {e.metric_key && `· ${e.metric_key}`} · executed {timeAgo(e.executed_at)}
                    {e.freshness_at && ` · data through ${String(e.freshness_at).slice(0, 10)}`}
                  </div>
                  <div>
                    <div className="mb-1 text-xs uppercase tracking-wider text-zinc-500">Frozen digest</div>
                    <pre className="overflow-x-auto rounded bg-zinc-900 p-3 text-[11px] text-zinc-300">
                      {JSON.stringify(e.result_digest, null, 2)}
                    </pre>
                  </div>
                  <div>
                    <div className="mb-1 text-xs uppercase tracking-wider text-zinc-500">Query params</div>
                    <pre className="overflow-x-auto rounded bg-zinc-900 p-3 text-[11px] text-zinc-300">
                      {JSON.stringify(e.params, null, 2)}
                    </pre>
                  </div>
                  <div className="text-[10px] text-zinc-600">sql hash: {e.sql_hash}</div>
                </div>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
