import type { SandboxStatus } from '../sandbox/types';

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
  | { type: 'sandbox'; status: SandboxStatus; detail?: string; previewUrl?: string }
  | { type: 'preview-reload' }
  | { type: 'usage'; model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string }
  | { type: 'turn-end'; outcome: 'success' | 'failed' | 'stopped' | 'answered'; durationMs: number; filesChanged: number };
