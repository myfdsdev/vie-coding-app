import type { FileChange, TurnEvent } from '@/agent/types';
import type { GateResult } from '@/agent/validate';
import type { PreviewError } from '@/preview/events';

/** One pre-execution check (§9) as the chat shows it. */
export type CheckRow = GateResult;

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
  /** The version this turn was saved as (git checkpoint). */
  version?: { number: number; sha: string };
  turnId?: string;
  /** Automatic repairs in this turn, oldest first. Absent on turns saved before M2. */
  repairs?: RepairRow[];
  /** Failures found by the latest check of the preview (empty once it works). */
  errors?: PreviewError[];
  /** Set when the repair budget ran out with the preview still failing. */
  failure?: { error: PreviewError; cause: string; attempts: number; rollback?: { number: number; sha: string } };
  meter?: { billed: number; free: number; balance: number };
  /** The checks run before the change reached the preview, one row per gate. Absent before M3. */
  checks?: CheckRow[];
}

export interface RepairRow {
  round: number;
  attempt: number;
  of: number;
  signature: string;
  cause: string;
  action: string;
  stuck: boolean;
  error: PreviewError;
  status: 'fixing' | 'fixed' | 'failed';
}

export type ChatMessage = UserMessage | AssistantTurn;

export function newAssistantTurn(id: string): AssistantTurn {
  return { id, role: 'assistant', status: 'streaming', plan: '', summary: '', files: [], dependencies: [], warnings: [], repairs: [] };
}

const STAGE_LABEL: Record<string, string> = {
  context: 'Reading the project',
  emit: 'Writing code',
  apply: 'Saving files',
  validate: 'Checking the code',
  checkpoint: 'Saving a version',
  execute: 'Updating the preview',
  collect: 'Checking the preview',
};

/** Close the repair in progress: fixed, or it did not hold. */
function settleRepairs(repairs: RepairRow[] | undefined, status: 'fixed' | 'failed', unlessSignature?: string): RepairRow[] {
  return (repairs ?? []).map((r) =>
    r.status !== 'fixing' ? r : { ...r, status: unlessSignature !== undefined && r.signature !== unlessSignature ? 'fixed' : status },
  );
}

/** Pure reducer: fold one server event into the assistant turn it belongs to. */
export function applyTurnEvent(turn: AssistantTurn, e: TurnEvent): AssistantTurn {
  switch (e.type) {
    case 'turn-start':
      return { ...turn, model: e.model, turnId: e.turnId };
    case 'check': {
      if (e.errors.length) return { ...turn, errors: e.errors };
      // The app works. A type-error repair only counts as fixed if no type errors are left.
      const typesLeft = (e.typeErrors ?? 0) > 0;
      const repairs = (turn.repairs ?? []).map((r) =>
        r.status !== 'fixing' ? r : { ...r, status: r.error.type === 'TYPE_ERROR' && typesLeft ? ('failed' as const) : ('fixed' as const) },
      );
      return { ...turn, errors: [], repairs };
    }
    case 'gate': {
      const checks = turn.checks ?? [];
      const prev = checks.find((c) => c.gate === e.gate);
      // A later pass does not hide what an earlier attempt corrected.
      const row: CheckRow =
        e.status === 'pass' && prev && (prev.status === 'fixed' || prev.status === 'fail')
          ? { gate: e.gate, status: 'fixed', detail: prev.status === 'fixed' ? prev.detail : e.detail }
          : { gate: e.gate, status: e.status, detail: e.detail };
      return { ...turn, checks: prev ? checks.map((c) => (c.gate === e.gate ? row : c)) : [...checks, row] };
    }
    case 'repair': {
      // A new round on the same failure means the last fix did not hold; a different failure means it did.
      const earlier = settleRepairs(turn.repairs, 'failed', e.signature);
      const row: RepairRow = { round: e.round, attempt: e.attempt, of: e.of, signature: e.signature, cause: e.cause, action: e.action, stuck: e.stuck, error: e.error, status: 'fixing' };
      return { ...turn, repairs: [...earlier, row] };
    }
    case 'repair-stopped':
      return {
        ...turn,
        repairs: settleRepairs(turn.repairs, 'failed'),
        failure: { error: e.error, cause: e.cause, attempts: e.attempts, rollback: e.rollback },
      };
    case 'meter':
      return { ...turn, meter: { billed: e.billed, free: e.free, balance: e.balance } };
    case 'stage':
      return { ...turn, stage: e.detail ?? STAGE_LABEL[e.stage] ?? e.stage };
    case 'checkpoint':
      return { ...turn, version: { number: e.version, sha: e.sha } };
    case 'text':
      return e.phase === 'before' ? { ...turn, plan: turn.plan + e.text } : { ...turn, summary: turn.summary + e.text };
    case 'file': {
      const path = e.path;
      const row: FileRow = { path, change: e.change, status: e.status, from: e.from, lines: e.lines, error: e.error };
      const idx = turn.files.findIndex((f) => f.path === path);
      const files = idx === -1 ? [...turn.files, row] : turn.files.map((f, i) => (i === idx ? { ...f, ...row } : f));
      // The <changes> block has started, so the plan text is complete.
      return { ...turn, files, plan: dropOrphanFence(turn.plan, 'end') };
    }
    case 'dependency':
      return { ...turn, dependencies: [...turn.dependencies, { spec: e.spec, status: e.status, detail: e.detail }] };
    case 'usage':
      return { ...turn, usage: { model: e.model, inputTokens: e.inputTokens, outputTokens: e.outputTokens, cacheReadTokens: e.cacheReadTokens, cacheWriteTokens: e.cacheWriteTokens } };
    case 'warning':
      return { ...turn, warnings: [...turn.warnings, e.message] };
    case 'error':
      return { ...turn, error: e.message };
    case 'turn-end': {
      // Summary text only exists after a <changes> block, as do file rows.
      const hadChanges = turn.files.length > 0 || turn.summary.length > 0;
      return {
        ...turn,
        status: e.outcome,
        durationMs: e.durationMs,
        stage: undefined,
        plan: hadChanges ? dropOrphanFence(turn.plan, 'end') : turn.plan,
        summary: dropOrphanFence(turn.summary, 'start'),
      };
    }
    default:
      return turn;
  }
}

const FENCE_LINE = /^\s*```[\w-]*\s*$/;

/**
 * A model sometimes wraps the <changes> block in a markdown fence. The block
 * is not shown, so its opening fence dangles at the end of the plan and its
 * closing fence at the start of the summary. Drop that one orphaned fence
 * line; balanced fences are left alone.
 */
export function dropOrphanFence(text: string, side: 'start' | 'end'): string {
  const lines = text.split('\n');
  const fences = lines.flatMap((line, i) => (FENCE_LINE.test(line) ? [i] : []));
  if (fences.length % 2 === 0) return text;
  const drop = side === 'end' ? fences[fences.length - 1] : fences[0];
  return lines.filter((_, i) => i !== drop).join('\n');
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
