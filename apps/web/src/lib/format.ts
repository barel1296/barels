export function fmtUsd(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1000) {
    return `$${(v / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}K`;
  }
  return `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

export function fmtNum(n: number | string | null | undefined, digits = 2): string {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { maximumFractionDigits: digits });
}

export function fmtPct(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return '—';
  return `${(v * 100).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
