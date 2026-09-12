'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Database, KeyRound, Lock, Trash2, Users, X } from 'lucide-react';
import type { Action, AccessLevel } from '@/backend/entities';
import { timeAgo } from './time';

/**
 * What the app stores, who has signed in, and the keys held for it (M4).
 *
 * It shows shapes and rules, never rows: the builder is not a back door into
 * the data people saved in a generated app. Secret values are write-only —
 * nothing here can display one, because no API returns one.
 */

interface EntityInfo {
  name: string;
  label: string;
  fields: { name: string; type: string; required: boolean }[];
  access: Record<Action, AccessLevel>;
  accessSummary: string;
  rows: number;
}

interface AppUserInfo {
  id: string;
  email: string;
  createdAt: number;
  lastSeenAt: number;
}

interface SecretInfo {
  name: string;
  updatedAt: number;
}

const ACCESS_WORD: Record<AccessLevel, string> = {
  everyone: 'anyone, even signed out',
  user: 'any signed-in user',
  owner: 'only whoever created it',
  nobody: 'no one',
};

const ACCESS_TONE: Record<AccessLevel, string> = {
  everyone: 'text-[#e0b06e]',
  user: 'text-text-2',
  owner: 'text-ok',
  nobody: 'text-dim',
};

const ACTIONS: Action[] = ['read', 'create', 'update', 'delete'];

export function DataPanel({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [entities, setEntities] = useState<EntityInfo[] | null>(null);
  const [users, setUsers] = useState<AppUserInfo[]>([]);
  const [secrets, setSecrets] = useState<SecretInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const [data, keys] = await Promise.all([
      fetch(`/api/projects/${projectId}/data`).then((r) => r.json() as Promise<{ entities?: EntityInfo[]; users?: AppUserInfo[] }>),
      fetch(`/api/projects/${projectId}/secrets`).then((r) => r.json() as Promise<{ secrets?: SecretInfo[] }>),
    ]);
    setEntities(data.entities ?? []);
    setUsers(data.users ?? []);
    setSecrets(keys.secrets ?? []);
  }, [projectId]);

  useEffect(() => {
    load().catch((err: Error) => setError(err.message));
  }, [load]);

  const addSecret = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/secrets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, value }),
      });
      const data = (await res.json()) as { secrets?: SecretInfo[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Could not save that key.');
      setSecrets(data.secrets ?? []);
      setName('');
      setValue('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const removeSecret = async (secret: string) => {
    const res = await fetch(`/api/projects/${projectId}/secrets?name=${encodeURIComponent(secret)}`, { method: 'DELETE' });
    const data = (await res.json()) as { secrets?: SecretInfo[] };
    setSecrets(data.secrets ?? []);
  };

  const field = 'w-full rounded-md border border-line bg-panel-2 px-2.5 py-1.5 font-mono text-[11.5px] text-text outline-none focus:border-line-raised';

  return (
    <aside className="flex w-[376px] shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex h-[42px] shrink-0 items-center gap-2.5 border-b border-line px-4">
        <span className="text-[13px] font-semibold">Data &amp; keys</span>
        <span className="flex-1" />
        <button onClick={onClose} title="Back to the chat" className="rounded p-1 text-dim hover:bg-surface hover:text-text-2">
          <X size={14} />
        </button>
      </div>

      <div className="thin-scroll flex flex-1 flex-col gap-5 overflow-y-auto px-4 py-3.5">
        {error && <div className="rounded-md border border-[#4a2a28] bg-[#1e1615] px-3 py-2 text-xs text-[#e8b4b2]">{error}</div>}

        <section className="flex flex-col gap-2.5">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-dim">
            <Database size={12} className="text-accent" />
            What this app stores
          </div>
          {!entities && <span className="text-xs text-dim">Loading…</span>}
          {entities?.length === 0 && (
            <p className="rounded-[9px] border border-dashed border-line px-3 py-4 text-xs leading-relaxed text-dim">
              Nothing yet. Ask for something the app should remember — &ldquo;let people sign in and save their notes&rdquo; — and it appears here.
            </p>
          )}
          {entities?.map((entity) => (
            <div key={entity.name} className="overflow-hidden rounded-[9px] border border-line bg-panel-2">
              <div className="flex items-center gap-2 border-b border-line px-3 py-2">
                <span className="text-[12.5px] font-semibold text-text">{entity.name}</span>
                <span className="flex-1" />
                <span className="font-mono text-[10.5px] text-dim-2">{entity.rows === 1 ? '1 row' : `${entity.rows} rows`}</span>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 px-3 py-2">
                {entity.fields.map((f) => (
                  <span key={f.name} className="font-mono text-[10.5px] text-dim">
                    {f.name}
                    <span className="text-dim-2">:{f.type}</span>
                    {f.required && <span className="text-accent">*</span>}
                  </span>
                ))}
              </div>
              <div className="flex flex-col gap-1 border-t border-line px-3 py-2">
                {ACTIONS.map((action) => (
                  <div key={action} className="flex items-baseline gap-2 text-[11.5px]">
                    <span className="w-12 shrink-0 text-dim">{action}</span>
                    <span className={ACCESS_TONE[entity.access[action]]}>{ACCESS_WORD[entity.access[action]]}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </section>

        {users.length > 0 && (
          <section className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-dim">
              <Users size={12} className="text-accent" />
              People who signed in
            </div>
            {users.map((user) => (
              <div key={user.id} className="flex items-baseline gap-2 px-1 text-[11.5px]">
                <span className="min-w-0 flex-1 truncate text-text-2">{user.email}</span>
                <span className="shrink-0 text-[10.5px] text-dim-2">{timeAgo(user.lastSeenAt)}</span>
              </div>
            ))}
          </section>
        )}

        <section className="flex flex-col gap-2.5">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-dim">
            <KeyRound size={12} className="text-accent" />
            Keys
          </div>
          <div className="flex gap-2 rounded-[9px] border border-line bg-panel-2 px-3 py-2.5">
            <Lock size={12} className="mt-0.5 shrink-0 text-ok" />
            <span className="text-[11.5px] leading-relaxed text-dim">
              A key you add here is stored for this app and never shown again — not to the AI, not in the app&rsquo;s code, not to anyone who opens
              the app.
            </span>
          </div>
          {secrets.map((secret) => (
            <div key={secret.name} className="flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-text-2">{secret.name}</span>
              <span className="shrink-0 text-[10.5px] text-dim-2">{timeAgo(secret.updatedAt)}</span>
              <button onClick={() => void removeSecret(secret.name)} title="Delete this key" className="rounded p-1 text-dim hover:text-err">
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          <form onSubmit={addSecret} className="flex flex-col gap-2">
            <input value={name} onChange={(e) => setName(e.target.value.toUpperCase())} placeholder="STRIPE_SECRET_KEY" className={field} />
            <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="the value" type="password" className={field} />
            <button
              type="submit"
              disabled={saving || !name.trim() || !value.trim()}
              className="rounded-md border border-line px-3 py-1.5 text-xs font-medium text-text-2 transition hover:border-line-raised disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Add key'}
            </button>
          </form>
        </section>
      </div>
    </aside>
  );
}
