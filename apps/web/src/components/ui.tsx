'use client';

export function Card({
  title,
  children,
  className = '',
  right,
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className={`rounded-lg border border-zinc-800 bg-zinc-900/60 ${className}`}>
      {title && (
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            {title}
          </h2>
          {right}
        </div>
      )}
      <div className="p-4">{children}</div>
    </div>
  );
}

const PILL_COLORS: Record<string, string> = {
  green: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  yellow: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  red: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
  running: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
  published: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  monitoring: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
  parked: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  failed: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
  budget_exceeded: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  awaiting_approval: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  approved: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  rejected: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
  expired: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
  proposed: 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30',
  dismissed: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
  closed: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
  pass: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  warn: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  fail: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
};

export function Pill({ value }: { value: string }) {
  const color = PILL_COLORS[value] ?? 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30';
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium ${color}`}
    >
      {value.replace(/_/g, ' ')}
    </span>
  );
}

export function ConfidenceBar({ value }: { value: number | string | null }) {
  const v = Math.max(0, Math.min(1, Number(value ?? 0)));
  const segments = 5;
  const filled = Math.round(v * segments);
  return (
    <span className="inline-flex items-center gap-1.5" title={`confidence ${v.toFixed(2)}`}>
      <span className="flex gap-0.5">
        {Array.from({ length: segments }, (_, i) => (
          <span
            key={i}
            className={`h-2.5 w-1.5 rounded-sm ${
              i < filled
                ? v >= 0.7
                  ? 'bg-emerald-400'
                  : v >= 0.4
                    ? 'bg-amber-400'
                    : 'bg-rose-400'
                : 'bg-zinc-700'
            }`}
          />
        ))}
      </span>
      <span className="text-xs tabular-nums text-zinc-400">{v.toFixed(2)}</span>
    </span>
  );
}

export function Sparkline({
  values,
  width = 120,
  height = 28,
}: {
  values: number[];
  width?: number;
  height?: number;
}) {
  if (values.length < 2) return <span className="text-zinc-600">—</span>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pts = values
    .map(
      (v, i) =>
        `${(i / (values.length - 1)) * width},${height - 2 - ((v - min) / range) * (height - 4)}`,
    )
    .join(' ');
  const declining = (values[values.length - 1] ?? 0) < (values[0] ?? 0);
  return (
    <svg width={width} height={height} className="overflow-visible">
      <polyline
        points={pts}
        fill="none"
        strokeWidth="1.5"
        className={declining ? 'stroke-rose-400' : 'stroke-emerald-400'}
      />
    </svg>
  );
}

export function Spinner() {
  return (
    <div className="flex items-center justify-center p-8 text-zinc-500">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-300" />
    </div>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-zinc-800 p-8 text-center text-zinc-500">
      {children}
    </div>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-rose-300">
      {message}
    </div>
  );
}
