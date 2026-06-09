'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { api } from '@/lib/api';

interface Me {
  user: { email: string; name: string } | null;
  tenant: { name: string; slug: string } | null;
  role: string;
  permissions: string[];
}

const NAV = [
  { href: '/command-center', label: 'Command Center' },
  { href: '/war-room', label: 'War Room' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/recommendations', label: 'Recommendations' },
  { href: '/health', label: 'Tracking Health' },
  { href: '/creative', label: 'Creative Intelligence' },
  { href: '/audit', label: 'Audit Log' },
  { href: '/settings', label: 'Settings' },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const pathname = usePathname();

  useEffect(() => {
    api<Me>('/v1/auth/me').then(setMe).catch(() => undefined);
  }, []);

  return (
    <div className="flex min-h-screen">
      <aside className="fixed inset-y-0 left-0 flex w-56 flex-col border-r border-zinc-800 bg-zinc-950">
        <div className="border-b border-zinc-800 px-4 py-4">
          <div className="text-base font-bold tracking-tight text-zinc-100">GROS</div>
          <div className="mt-0.5 truncate text-xs text-zinc-500">
            {me?.tenant?.name ?? '…'}
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {NAV.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`block rounded-md px-3 py-1.5 ${
                  active
                    ? 'bg-zinc-800 font-medium text-zinc-100'
                    : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-zinc-800 p-3 text-xs text-zinc-500">
          <div className="truncate">{me?.user?.email}</div>
          <div className="mt-1 flex items-center justify-between">
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase">
              {me?.role ?? ''}
            </span>
            <button
              onClick={async () => {
                await api('/v1/auth/logout', { method: 'POST' }).catch(() => undefined);
                window.location.href = '/login';
              }}
              className="text-zinc-500 hover:text-zinc-300"
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>
      <main className="ml-56 flex-1 p-6">{children}</main>
    </div>
  );
}
