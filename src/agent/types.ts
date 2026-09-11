import type { PreviewError } from '../preview/events';
import type { SandboxStatus } from '../sandbox/types';
import type { GateResult } from './validate';

/** Stages of runTurn (BUILD-PROMPT §7). Only the ones a milestone implements are emitted. */
export type TurnStage =
  | 'route'
  | 'context'
  | 'emit'
  | 'apply'
  | 'validate'
  | 'checkpoint'
  | 'execute'
  | 'collect'
  | 'decide'
  | 'meter';

export type FileChange = 'created' | 'modified' | 'deleted' | 'renamed';

/** Server-sent events streamed from /api/chat to the builder UI. */
export type TurnEvent =
  | { type: 'turn-start'; turnId: string; provider: string; model: string }
  | { type: 'stage'; stage: TurnStage; detail?: string }
  | { type: 'text'; text: string; phase: 'before' | 'after' }
  | { type: 'file'; path: string; status: 'writing' | 'done' | 'failed'; change: FileChange; from?: string; lines?: number; error?: string }
  | { type: 'dependency'; spec: string; status: 'added' | 'rejected'; detail?: string }
  | { type: 'checkpoint'; version: number; sha: string; subject: string }
  | { type: 'sandbox'; status: SandboxStatus; detail?: string; previewUrl?: string }
  | { type: 'preview-reload' }
  /**
   * The builder page should watch the preview (for up to `windowMs`), then
   * report what it saw under `check`. `fresh`: a second look after a reload,
   * counted from now rather than from the attempt's change.
   */
  | { type: 'collect'; turnId: string; attempt: number; check: number; windowMs: number; remounted: boolean; fresh?: boolean }
  /** A pre-execution gate (§9a/§9b) or the typecheck ran: one per gate per attempt, also logged on the server. */
  | ({ type: 'gate'; attempt: number } & GateResult)
  /**
   * What checking the preview found after an attempt; empty means it works.
   * `typeErrors`: type errors left in a working app, which never fail a turn.
   */
  | { type: 'check'; attempt: number; errors: PreviewError[]; typeErrors?: number }
  /** A repair attempt starts: "Attempt 2 of 3 — adding a loading guard". */
  | {
      type: 'repair';
      round: number;
      attempt: number;
      of: number;
      signature: string;
      cause: string;
      action: string;
      stuck: boolean;
      error: PreviewError;
    }
  /** The repair budget ran out with the preview still failing. */
  | { type: 'repair-stopped'; error: PreviewError; cause: string; attempts: number; rollback?: { number: number; sha: string } }
  | { type: 'usage'; model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  /** Credits: billed for this turn, recorded but free (repairs, retries), and the balance left. */
  | { type: 'meter'; billed: number; free: number; balance: number }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string }
  | { type: 'turn-end'; outcome: 'success' | 'failed' | 'stopped' | 'answered'; durationMs: number; filesChanged: number };
