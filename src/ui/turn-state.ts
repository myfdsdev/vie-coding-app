import type { FileChange, TurnEvent } from '@/agent/types';

export interface FileRow {
  path: string;
  change: FileChange;
  status: 'writing' | 'done' | 'failed';
  from?: string;
  lines?: number;
  error?: string;
}

export interface Usage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface UserMessage {
  id: string;
  role: 'user';
  text: string;
}

export interface AssistantTurn {
  id: string;
  role: 'assistant';
  status: 'streaming' | 'success' | 'failed' | 'stopped' | 'answered';
  plan: string;
  summary: string;
  files: FileRow[];
  dependencies: { spec: string; status: 'added' | 'rejected'; detail?: string }[];
  warnings: string[];
  stage?: string;
  model?: string;
  usage?: Usage;
  error?: string;
  durationMs?: number;
}

export type ChatMessage = UserMessage | AssistantTurn;

export function newAssistantTurn(id: string): AssistantTurn {
  return { id, role: 'assistant', status: 'streaming', plan: '', summary: '', files: [], dependencies: [], warnings: [] };
}

const STAGE_LABEL: Record<string, string> = {
  context: 'Reading the project',
  emit: 'Writing code',
  apply: 'Saving files',
  execute: 'Updating the preview',
};

/** Pure reducer: fold one server event into the assistant turn it belongs to. */
export function applyTurnEvent(turn: AssistantTurn, e: TurnEvent): AssistantTurn {
  switch (e.type) {
    case 'turn-start':
      return { ...turn, model: e.model };
    case 'stage':
      return { ...turn, stage: STAGE_LABEL[e.stage] ?? e.stage };
    case 'text':
      return e.phase === 'before' ? { ...turn, plan: turn.plan + e.text } : { ...turn, summary: turn.summary + e.text };
    case 'file': {
      const path = e.path;
      const row: FileRow = { path, change: e.change, status: e.status, from: e.from, lines: e.lines, error: e.error };
      const idx = turn.files.findIndex((f) => f.path === path);
      const files = idx === -1 ? [...turn.files, row] : turn.files.map((f, i) => (i === idx ? { ...f, ...row } : f));
      return { ...turn, files };
    }
    case 'dependency':
      return { ...turn, dependencies: [...turn.dependencies, { spec: e.spec, status: e.status, detail: e.detail }] };
    case 'usage':
      return { ...turn, usage: { model: e.model, inputTokens: e.inputTokens, outputTokens: e.outputTokens, cacheReadTokens: e.cacheReadTokens, cacheWriteTokens: e.cacheWriteTokens } };
    case 'warning':
      return { ...turn, warnings: [...turn.warnings, e.message] };
    case 'error':
      return { ...turn, error: e.message };
    case 'turn-end':
      return { ...turn, status: e.outcome, durationMs: e.durationMs, stage: undefined };
    default:
      return turn;
  }
}

/** Split an SSE byte stream into parsed TurnEvents. */
export async function* readTurnEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<TurnEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = frame
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (data) yield JSON.parse(data) as TurnEvent;
    }
  }
}
