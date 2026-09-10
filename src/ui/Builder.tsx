'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileChange, TurnEvent } from '@/agent/types';
import type { SandboxStatus } from '@/sandbox/types';
import { ChatPane } from './ChatPane';
import { FileTree } from './FileTree';
import { firstPromptKey } from './first-prompt';
import { HistoryPanel } from './HistoryPanel';
import { PreviewPane } from './PreviewPane';
import { TopBar } from './TopBar';
import { applyTurnEvent, newAssistantTurn, readTurnEvents, type AssistantTurn, type ChatMessage } from './turn-state';

export interface SandboxState {
  status: SandboxStatus | 'unknown';
  detail?: string;
  error?: string;
}

interface BuilderProps {
  project: { id: string; name: string };
  provider: string;
  model: string;
  previewUrl: string;
  initialMessages: ChatMessage[];
  initialFiles: string[];
}

let seq = 0;
const nextId = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`;

export function Builder({ project, provider, model, previewUrl, initialMessages, initialFiles }: BuilderProps) {
  const projectId = project.id;
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [files, setFiles] = useState<string[]>(initialFiles);
  const [marks, setMarks] = useState<Record<string, FileChange>>({});
  const [sandbox, setSandbox] = useState<SandboxState>({ status: 'unknown', detail: 'Connecting to the sandbox' });
  const [previewKey, setPreviewKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versionsKey, setVersionsKey] = useState(0);
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

  /** Keep the file tree in step with the files a turn writes, deletes or renames. */
  const trackFile = useCallback((e: Extract<TurnEvent, { type: 'file' }>) => {
    if (e.status === 'failed') return;
    if (e.change === 'deleted') {
      setFiles((prev) => prev.filter((p) => p !== e.path));
      setMarks((prev) => {
        const next = { ...prev };
        delete next[e.path];
        return next;
      });
      return;
    }
    setFiles((prev) => {
      const kept = e.from ? prev.filter((p) => p !== e.from) : prev;
      return kept.includes(e.path) ? kept : [...kept, e.path].sort();
    });
    // A file created earlier in this turn stays "created" when it is rewritten.
    setMarks((prev) => ({ ...prev, [e.path]: prev[e.path] === 'created' || e.change === 'renamed' ? 'created' : e.change }));
  }, []);

  const send = useCallback(
    async (text: string) => {
      const turnId = nextId();
      setMessages((prev) => [...prev, { id: nextId(), role: 'user', text }, newAssistantTurn(turnId)]);
      setMarks({});
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
          if (event.type === 'file') trackFile(event);
          else if (event.type === 'checkpoint') setVersionsKey((k) => k + 1);
          else if (event.type === 'sandbox') {
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
    [projectId, updateTurn, trackFile],
  );

  // A project started from the home page arrives with its first request waiting.
  const sentFirst = useRef(false);
  useEffect(() => {
    if (sentFirst.current) return;
    sentFirst.current = true;
    let pending: string | null = null;
    try {
      pending = sessionStorage.getItem(firstPromptKey(projectId));
      sessionStorage.removeItem(firstPromptKey(projectId));
    } catch {
      /* storage blocked */
    }
    if (pending && initialMessages.length === 0) void send(pending);
    // Runs once per page load; the dependencies are stable for its lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const restore = useCallback(
    async (sha: string) => {
      const res = await fetch(`/api/projects/${projectId}/versions/${sha}/restore`, { method: 'POST' });
      const data = (await res.json()) as { error?: string; changed?: boolean; message?: AssistantTurn };
      if (!res.ok) throw new Error(data.error ?? `Restore failed (${res.status})`);
      if (data.message) setMessages((prev) => [...prev, data.message as AssistantTurn]);
      setMarks({});
      const list = (await fetch(`/api/projects/${projectId}/files`)
        .then((r) => r.json())
        .catch(() => null)) as { files?: string[] } | null;
      if (list?.files) setFiles(list.files);
      if (data.changed) setPreviewKey((k) => k + 1);
      setVersionsKey((k) => k + 1);
    },
    [projectId],
  );

  const lastTurn = [...messages].reverse().find((m): m is AssistantTurn => m.role === 'assistant');
  const writing = lastTurn?.status === 'streaming' ? lastTurn.files.find((f) => f.status === 'writing')?.path : undefined;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg text-text">
      <TopBar
        project={project}
        provider={provider}
        model={model}
        historyOpen={historyOpen}
        onToggleHistory={() => setHistoryOpen((open) => !open)}
      />
      <div className="flex min-h-0 flex-1">
        {historyOpen ? (
          <HistoryPanel projectId={projectId} refreshKey={versionsKey} busy={busy} onRestore={restore} onClose={() => setHistoryOpen(false)} />
        ) : (
          <ChatPane messages={messages} busy={busy} onSend={send} onStop={stop} />
        )}
        <FileTree files={files} marks={marks} writing={writing} />
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
