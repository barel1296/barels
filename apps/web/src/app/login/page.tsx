'use client';

import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';

export default function LoginPage() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState({
    email: '',
    password: '',
    name: '',
    tenantName: '',
    tenantSlug: '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'login') {
        await api('/v1/auth/login', {
          method: 'POST',
          json: { email: form.email, password: form.password },
        });
      } else {
        await api('/v1/auth/register', { method: 'POST', json: form });
      }
      window.location.href = '/command-center';
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const input =
    'w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-100 ' +
    'placeholder-zinc-500 focus:border-indigo-500 focus:outline-none';

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-zinc-100">GROS</h1>
          <p className="mt-1 text-zinc-500">AI Growth Operating System</p>
        </div>
        <form onSubmit={submit} className="space-y-3">
          {mode === 'register' && (
            <>
              <input className={input} placeholder="Your name" value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              <input className={input} placeholder="Company name" value={form.tenantName}
                onChange={(e) => setForm({ ...form, tenantName: e.target.value })} required />
              <input className={input} placeholder="workspace-slug" value={form.tenantSlug}
                onChange={(e) => setForm({ ...form, tenantSlug: e.target.value })}
                pattern="[a-z0-9][a-z0-9-]+" required />
            </>
          )}
          <input className={input} type="email" placeholder="Email" value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          <input className={input} type="password" placeholder="Password" value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })} required
            minLength={mode === 'register' ? 10 : 1} />
          {error && (
            <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-rose-300">
              {error}
            </div>
          )}
          <button disabled={busy}
            className="w-full rounded-md bg-indigo-600 px-3 py-2 font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
            {busy ? '…' : mode === 'login' ? 'Sign in' : 'Create workspace'}
          </button>
        </form>
        <button onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
          className="mt-4 w-full text-center text-zinc-500 hover:text-zinc-300">
          {mode === 'login' ? 'New here? Create a workspace' : 'Have an account? Sign in'}
        </button>
        <p className="mt-6 text-center text-xs text-zinc-600">
          Local dev seed: demo@gros.dev / demo-password-123
        </p>
      </div>
    </main>
  );
}
