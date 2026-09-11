'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileChange, TurnEvent } from '@/agent/types';
import { dedupeErrors, isFailureEvent, parsePreviewEvent, toPreviewError, type PreviewError, type PreviewEvent } from '@/preview/events';
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
  initialCredits: number;
}

let seq = 0;
const nextId = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function Builder({ project, provider, model, previewUrl, initialMessages, initialFiles, initialCredits }: BuilderProps) {
  const projectId = project.id;
  const previewOrigin = useMemo(() => new URL(previewUrl).origin, [previewUrl]);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [files, setFiles] = useState<string[]>(initialFiles);
  const [marks, setMarks] = useState<Record<string, FileChange>>({});
  const [sandbox, setSandbox] = useState<SandboxState>({ status: 'unknown', detail: 'Connecting to the sandbox' });
  const [previewKey, setPreviewKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versionsKey, setVersionsKey] = useState(0);
  const [credits, setCredits] = useState(initialCredits);
  const [idleErrors, setIdleErrors] = useState<PreviewError[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  // Everything the preview posted, with arrival times; each attempt reports what came after its change.
  const eventsRef = useRef<{ at: number; raw: unknown; event: PreviewEvent }[]>([]);
  const attemptStartRef = useRef(0);

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

  // The preview reports failures and RENDER_OK by postMessage. Only its own
  // origin may, and the payload is untrusted generated code (parsePreviewEvent).
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== previewOrigin) return;
      const event = parsePreviewEvent(e.data);
      if (!event) return;
      const log = eventsRef.current;
      log.push({ at: Date.now(), raw: e.data, event });
      if (log.length > 300) log.splice(0, log.length - 200);
      if (busyRef.current) return;
      // Between turns, a failure offers "Fix it"; a clean render clears it.
      const error = toPreviewError(event, previewOrigin);
      if (error) setIdleErrors((prev) => dedupeErrors([...prev, error]).slice(0, 3));
      else if (event.type === 'RENDER_OK') setIdleErrors([]);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [previewOrigin]);

  useEffect(() => {
    setIdleErrors([]);
  }, [previewKey]);

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

  /**
   * 9 COLLECT, page side: watch the preview after the change, then report what
   * it said. A crash ends the watch early (once React's companion reports have
   * arrived), and so does RENDER_OK on a fresh load. BLANK_SCREEN does not: on
   * a cold sandbox the shim can call a page blank before React has rendered,
   * and the real crash arrives afterwards.
   */
  const reportPreview = useCallback(async (turnId: string, check: number, windowMs: number, remounted: boolean, fresh: boolean) => {
    const start = fresh ? Date.now() : attemptStartRef.current;
    const seen = () => eventsRef.current.filter((x) => x.at >= start);
    const crashed = (e: PreviewEvent) => isFailureEvent(e) && e.type !== 'BLANK_SCREEN';
    const deadline = Date.now() + windowMs;
    while (Date.now() < deadline) {
      await sleep(150);
      if (seen().some((x) => crashed(x.event))) {
        await sleep(600);
        break;
      }
      if (remounted && seen().some((x) => x.event.type === 'RENDER_OK')) break;
    }
    await fetch(`/api/turns/${turnId}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ check, events: seen().map((x) => x.raw) }),
    }).catch(() => undefined);
  }, []);

  const send = useCallback(
    async (text: string, repairOf?: PreviewError) => {
      const turnId = nextId();
      setMessages((prev) => [...prev, { id: nextId(), role: 'user', text }, newAssistantTurn(turnId)]);
      setMarks({});
      setIdleErrors([]);
      setBusy(true);
      busyRef.current = true;
      const abort = new AbortController();
      abortRef.current = abort;
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectId, message: text, previewReports: true, repairOf }),
          signal: abort.signal,
        });
        if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`);
        for await (const event of readTurnEvents(res.body)) {
          updateTurn(turnId, (t) => applyTurnEvent(t, event));
          switch (event.type) {
            case 'file':
              trackFile(event);
              break;
            case 'checkpoint':
              setVersionsKey((k) => k + 1);
              break;
            case 'stage':
              if (event.stage === 'execute') attemptStartRef.current = Date.now();
              break;
            case 'collect':
              void reportPreview(event.turnId, event.check, event.windowMs, event.remounted, !!event.fresh);
              break;
            case 'meter':
              setCredits(event.balance);
              break;
            case 'sandbox':
              setSandbox({ status: event.status, detail: event.detail, error: event.status === 'crashed' ? event.detail : undefined });
              break;
            case 'preview-reload':
              setPreviewKey((k) => k + 1);
              break;
            case 'error':
              if (/Docker|sandbox/i.test(event.message)) setSandbox({ status: 'crashed', error: event.message });
              break;
            default:
              break;
          }
        }
      } catch (err) {
        const stopped = abort.signal.aborted;
        updateTurn(turnId, (t) => ({ ...t, status: stopped ? 'stopped' : 'failed', error: stopped ? undefined : (err as Error).message }));
      } finally {
        setBusy(false);
        busyRef.current = false;
        abortRef.current = null;
      }
    },
    [projectId, updateTurn, trackFile, reportPreview],
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

  const rollback = useCallback(
    (sha: string) => {
      restore(sha).catch((err: Error) =>
        setMessages((prev) => [...prev, { ...newAssistantTurn(nextId()), status: 'failed', error: `Could not roll back: ${err.message}` }]),
      );
    },
    [restore],
  );

  /** "Fix it" on a failure the preview showed between turns: a repair turn, never billed. */
  const fixIdle = useCallback(() => {
    const error = idleErrors[0];
    if (error && !busyRef.current) void send('Fix the error in the preview', error);
  }, [idleErrors, send]);

  const lastTurn = [...messages].reverse().find((m): m is AssistantTurn => m.role === 'assistant');
  const streaming = lastTurn?.status === 'streaming';
  const writing = streaming ? lastTurn?.files.find((f) => f.status === 'writing')?.path : undefined;
  const liveRepair = streaming ? lastTurn?.repairs?.find((r) => r.status === 'fixing') : undefined;
  const turnErrors = lastTurn && (streaming || lastTurn.status === 'failed') ? lastTurn.errors : undefined;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg text-text">
      <TopBar
        project={project}
        provider={provider}
        model={model}
        credits={credits}
        historyOpen={historyOpen}
        onToggleHistory={() => setHistoryOpen((open) => !open)}
      />
      <div className="flex min-h-0 flex-1">
        {historyOpen ? (
          <HistoryPanel projectId={projectId} refreshKey={versionsKey} busy={busy} onRestore={restore} onClose={() => setHistoryOpen(false)} />
        ) : (
          <ChatPane messages={messages} busy={busy} onSend={send} onStop={stop} onRollback={rollback} />
        )}
        <FileTree files={files} marks={marks} writing={writing} />
        <PreviewPane
          previewUrl={previewUrl}
          previewKey={previewKey}
          sandbox={sandbox}
          onReload={() => setPreviewKey((k) => k + 1)}
          lastUsage={[...messages].reverse().find((m): m is AssistantTurn => m.role === 'assistant' && !!m.usage)?.usage}
          repair={liveRepair}
          errors={turnErrors}
          idleError={busy ? undefined : idleErrors[0]}
          onFix={fixIdle}
        />
      </div>
    </div>
  );
}
