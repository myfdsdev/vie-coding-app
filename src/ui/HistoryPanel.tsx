'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, RotateCcw, X } from 'lucide-react';
import type { Version } from '@/store/checkpoints';
import { timeAgo } from './time';

interface HistoryPanelProps {
  projectId: string;
  /** Bumped whenever a new version exists, so the list reloads. */
  refreshKey: number;
  busy: boolean;
  onRestore: (sha: string) => Promise<void>;
  onClose: () => void;
}

const KIND_LABEL: Record<Version['kind'], string> = {
  template: 'starter',
  turn: '',
  repair: 'auto-repaired',
  restore: 'restored',
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function HistoryPanel({ projectId, refreshKey, busy, onRestore, onClose }: HistoryPanelProps) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${projectId}/versions`)
      .then((r) => r.json())
      .then((data: { versions?: Version[]; error?: string }) => {
        if (cancelled) return;
        if (data.error) setError(data.error);
        else {
          setVersions(data.versions ?? []);
          setError(null);
        }
      })
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshKey]);

  const restore = async (v: Version) => {
    setRestoring(v.sha);
    setError(null);
    try {
      await onRestore(v.sha);
      setConfirming(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRestoring(null);
    }
  };

  return (
    <aside className="flex w-[376px] shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex h-[42px] shrink-0 items-center gap-2.5 border-b border-line px-4">
        <span className="text-[13px] font-semibold">Version history</span>
        <span className="flex-1" />
        {versions && <span className="text-[11.5px] text-dim-2">{plural(versions.length, 'version')}</span>}
        <button onClick={onClose} title="Back to the chat" className="rounded p-1 text-dim hover:bg-surface hover:text-text-2">
          <X size={14} />
        </button>
      </div>

      <div className="thin-scroll flex flex-1 flex-col overflow-y-auto px-4 py-3.5">
        <div className="mb-4 flex gap-2.5 rounded-[9px] border border-[#3a3020] bg-[#1d1810] px-3 py-2.5">
          <AlertTriangle size={14} className="mt-px shrink-0 text-accent" />
          <div className="flex flex-col gap-0.5">
            <span className="text-[12.5px] font-semibold text-[#f0d5a8]">Restoring brings back code, not data</span>
            <span className="text-xs leading-relaxed text-[#a3947c]">
              A restore is saved as a new version, so it can be undone. Database rows and anything stored outside the code stay as they are.
            </span>
          </div>
        </div>

        {error && <div className="mb-3 rounded-md border border-[#4a2a28] bg-[#1e1615] px-3 py-2 text-xs text-[#e8b4b2]">{error}</div>}
        {!versions && !error && (
          <div className="flex items-center gap-2 text-dim">
            <span className="spinner" />
            Loading versions
          </div>
        )}

        {versions?.map((v, i) => (
          <div key={v.sha} className="flex gap-3">
            <div className="flex w-3.5 shrink-0 flex-col items-center">
              <span className={'mt-[5px] block h-[9px] w-[9px] rounded-full ' + (i === 0 ? 'bg-accent shadow-[0_0_0_3px_#2a1f10]' : 'bg-line-raised')} />
              {i < versions.length - 1 && <span className="w-px flex-1 bg-line" />}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5 pb-4">
              <div className="flex items-baseline gap-2">
                <span className={'text-[13px] font-semibold ' + (i === 0 ? 'text-text' : 'text-text-2')}>v{v.number}</span>
                {i === 0 && <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-accent">Current</span>}
                {KIND_LABEL[v.kind] && <span className="text-[11px] text-dim">{KIND_LABEL[v.kind]}</span>}
                <span className="flex-1" />
                <span className="shrink-0 text-[11.5px] text-dim-2">{timeAgo(v.createdAt)}</span>
              </div>
              <span className={'break-words text-[12.5px] leading-normal ' + (i === 0 ? 'text-[#a49c92]' : 'text-[#8b847b]')}>{v.subject}</span>
              <div className="flex items-center gap-1.5 font-mono">
                {v.added > 0 && <span className="rounded bg-[#161d16] px-1.5 py-0.5 text-[10.5px] text-ok">+{plural(v.added, 'file')}</span>}
                {v.modified > 0 && <span className="rounded bg-[#221c14] px-1.5 py-0.5 text-[10.5px] text-[#a08a6a]">~{plural(v.modified, 'file')}</span>}
                {v.deleted > 0 && <span className="rounded bg-[#241817] px-1.5 py-0.5 text-[10.5px] text-err">−{plural(v.deleted, 'file')}</span>}
                <span className="flex-1" />
                {i > 0 && confirming !== v.sha && (
                  <button
                    onClick={() => setConfirming(v.sha)}
                    disabled={busy || restoring !== null}
                    title={busy ? 'Wait for the current change to finish' : `Restore v${v.number}`}
                    className="flex items-center gap-1 rounded-md border border-line px-2 py-1 font-sans text-[11.5px] text-text-2 transition hover:border-line-raised disabled:opacity-40"
                  >
                    <RotateCcw size={11} />
                    Restore
                  </button>
                )}
              </div>
              {confirming === v.sha && (
                <div className="flex items-center gap-2 rounded-md border border-line-raised bg-surface px-2.5 py-2">
                  <span className="flex-1 text-xs leading-snug text-text-2">Restore v{v.number}? Your code goes back; data doesn&apos;t.</span>
                  <button onClick={() => setConfirming(null)} disabled={restoring !== null} className="text-xs text-dim hover:text-text-2">
                    Cancel
                  </button>
                  <button
                    onClick={() => void restore(v)}
                    disabled={restoring !== null}
                    className="rounded-md bg-accent px-2.5 py-1 text-xs font-semibold text-accent-ink disabled:opacity-60"
                  >
                    {restoring === v.sha ? 'Restoring…' : 'Restore'}
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
