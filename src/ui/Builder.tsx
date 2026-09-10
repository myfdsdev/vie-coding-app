'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SandboxStatus } from '@/sandbox/types';
import { ChatPane } from './ChatPane';
import { PreviewPane } from './PreviewPane';
import { TopBar } from './TopBar';
import { applyTurnEvent, newAssistantTurn, readTurnEvents, type AssistantTurn, type ChatMessage } from './turn-state';

export interface SandboxState {
  status: SandboxStatus | 'unknown';
  detail?: string;
  error?: string;
}

interface BuilderProps {
  projectId: string;
  provider: string;
  model: string;
  previewUrl: string;
}

let seq = 0;
const nextId = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`;

export function Builder({ projectId, provider, model, previewUrl }: BuilderProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sandbox, setSandbox] = useState<SandboxState>({ status: 'unknown', detail: 'Connecting to the sandbox' });
  const [previewKey, setPreviewKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Warm the sandbox on load so it is hot before the first message is sent.
  useEffect(() => {
    let cancelled = false;
    setSandbox({ status: 'starting', detail: 'Starting the sandbox' });
    fetch(`/api/projects/${projectId}/sandbox`, { method: 'POST' })
      .then((r) => r.json())
      .then((data: { status: SandboxStatus; error?: string }) => {
        if (cancelled) return;
        setSandbox({ status: data.status, error: data.error, detail: data.status === 'ready' ? 'vite ready' : data.status });
        if (data.status === 'ready') setPreviewKey((k) => k + 1);
      })
      .catch((err: Error) => !cancelled && setSandbox({ status: 'crashed', error: err.message }));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const updateTurn = useCallback((id: string, fn: (t: AssistantTurn) => AssistantTurn) => {
    setMessages((prev) => prev.map((m) => (m.id === id && m.role === 'assistant' ? fn(m) : m)));
  }, []);

  const send = useCallback(
    async (text: string) => {
      const turnId = nextId();
      setMessages((prev) => [...prev, { id: nextId(), role: 'user', text }, newAssistantTurn(turnId)]);
      setBusy(true);
      const abort = new AbortController();
      abortRef.current = abort;
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectId, message: text }),
          signal: abort.signal,
        });
        if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`);
        for await (const event of readTurnEvents(res.body)) {
          updateTurn(turnId, (t) => applyTurnEvent(t, event));
          if (event.type === 'sandbox') {
            setSandbox({ status: event.status, detail: event.detail, error: event.status === 'crashed' ? event.detail : undefined });
          } else if (event.type === 'preview-reload') {
            setPreviewKey((k) => k + 1);
          } else if (event.type === 'error' && /Docker|sandbox/i.test(event.message)) {
            setSandbox({ status: 'crashed', error: event.message });
          }
        }
      } catch (err) {
        const stopped = abort.signal.aborted;
        updateTurn(turnId, (t) => ({ ...t, status: stopped ? 'stopped' : 'failed', error: stopped ? undefined : (err as Error).message }));
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [projectId, updateTurn],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg text-text">
      <TopBar projectId={projectId} provider={provider} model={model} />
      <div className="flex min-h-0 flex-1">
        <ChatPane messages={messages} busy={busy} onSend={send} onStop={stop} />
        <PreviewPane
          previewUrl={previewUrl}
          previewKey={previewKey}
          sandbox={sandbox}
          onReload={() => setPreviewKey((k) => k + 1)}
          lastUsage={[...messages].reverse().find((m): m is AssistantTurn => m.role === 'assistant' && !!m.usage)?.usage}
        />
      </div>
    </div>
  );
}
