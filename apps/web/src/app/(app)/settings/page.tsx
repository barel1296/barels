'use client';

import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { Card, EmptyState, ErrorNote, Pill, Spinner } from '@/components/ui';
import { fmtUsd } from '@/lib/format';

interface Integration {
  id: string;
  source_key: string;
  name: string;
  status: string;
  scopes_granted: string[];
}
interface DataSource {
  key: string;
  display_name: string;
  category: string;
}
interface Policy {
  action_kind: string;
  rules: { maxMagnitudeUsd?: number | null; twoPersonAboveUsd?: number | null; expiryHours?: number };
  autonomy_level: number;
}
interface Guardrail {
  key: string;
  description: string;
  params: Record<string, unknown>;
  enabled: boolean;
}
interface Budget {
  monthly_usd: string;
  hard_stop: boolean;
  spentThisMonthUsd: number;
}

export default function SettingsPage() {
  const [integrations, setIntegrations] = useState<Integration[] | null>(null);
  const [sources, setSources] = useState<DataSource[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [guardrails, setGuardrails] = useState<Guardrail[]>([]);
  const [budget, setBudget] = useState<Budget | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api<{ items: Integration[] }>('/v1/integrations'),
      api<{ items: DataSource[] }>('/v1/data-sources'),
      api<{ items: Policy[] }>('/v1/approval-policies'),
      api<{ items: Guardrail[] }>('/v1/guardrails'),
      api<Budget>('/v1/costs/budget'),
    ])
      .then(([i, s, p, g, b]) => {
        setIntegrations(i.items);
        setSources(s.items);
        setPolicies(p.items);
        setGuardrails(g.items);
        setBudget(b);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  if (error) return <ErrorNote message={error} />;
  if (!integrations) return <Spinner />;

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-zinc-100">Settings</h1>

      <Card title="Integrations">
        {integrations.length === 0 ? (
          <EmptyState>
            No data sources connected. Available connectors:{' '}
            {sources.map((s) => s.display_name).join(', ')}.
            <div className="mt-1 text-xs">
              Live connector sync is a roadmap item — see docs/dev/known-gaps.md.
            </div>
          </EmptyState>
        ) : (
          <ul className="divide-y divide-zinc-800">
            {integrations.map((i) => (
              <li key={i.id} className="flex items-center justify-between py-2">
                <div>
                  <span className="font-medium text-zinc-200">{i.name}</span>
                  <span className="ml-2 text-xs text-zinc-500">{i.source_key}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-500">
                    scopes: {i.scopes_granted.length ? i.scopes_granted.join(', ') : 'read-only'}
                  </span>
                  <Pill value={i.status} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid grid-cols-2 gap-4">
        <Card title="Approval policies (autonomy level per action kind)">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="uppercase tracking-wider text-zinc-500">
                <th className="pb-2">Action kind</th>
                <th className="pb-2">Autonomy</th>
                <th className="pb-2">Magnitude cap</th>
                <th className="pb-2">Expiry</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {policies.map((p) => (
                <tr key={p.action_kind}>
                  <td className="py-1.5 text-zinc-300">{p.action_kind.replace(/_/g, ' ')}</td>
                  <td className="py-1.5">
                    <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-400">
                      L{p.autonomy_level} — approval required
                    </span>
                  </td>
                  <td className="py-1.5 tabular-nums text-zinc-400">
                    {p.rules.maxMagnitudeUsd ? fmtUsd(p.rules.maxMagnitudeUsd) : '—'}
                  </td>
                  <td className="py-1.5 text-zinc-400">{p.rules.expiryHours ?? 72}h</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-[11px] text-zinc-600">
            This build caps autonomy at Level 2: every action requires human approval and no
            execution adapter is wired. Raising levels is a policy change guarded by
            `policies:manage` once the execution layer ships.
          </p>
        </Card>

        <div className="space-y-4">
          <Card title="Guardrails">
            <ul className="space-y-1.5 text-xs">
              {guardrails.map((g) => (
                <li key={g.key} className="flex items-center justify-between">
                  <span className="text-zinc-300">{g.description || g.key}</span>
                  <span className="font-mono text-zinc-500">{JSON.stringify(g.params)}</span>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="LLM cost budget">
            {budget && (
              <div className="space-y-2">
                <div className="flex items-end justify-between">
                  <span className="text-2xl font-semibold tabular-nums text-zinc-100">
                    {fmtUsd(budget.spentThisMonthUsd)}
                  </span>
                  <span className="text-zinc-500">of {fmtUsd(budget.monthly_usd)} / month</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className="h-full bg-indigo-500"
                    style={{
                      width: `${Math.min(100, (budget.spentThisMonthUsd / Number(budget.monthly_usd)) * 100)}%`,
                    }}
                  />
                </div>
                <div className="text-xs text-zinc-500">
                  hard stop: {budget.hard_stop ? 'enabled — agents pause at the cap' : 'disabled'}
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
