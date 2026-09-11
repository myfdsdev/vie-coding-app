import type { ModelUsage } from '../agent/providers';
import { db } from './db';

/**
 * Token and credit accounting (BUILD-PROMPT §3.5, §8). One credit is one US
 * cent of model cost at list price. Every model call is recorded; a turn's
 * build is billed only once the turn ends with a working preview. Repair
 * attempts and whole-file retries — the AI fixing its own mistakes — are
 * never billed, and neither is a turn that ends broken or stopped.
 */

export type LedgerKind = 'build' | 'retry' | 'repair';

/** US$ per million tokens. Cached input costs 10% of input, cache writes 125%. */
const PRICES: { match: RegExp; input: number; output: number }[] = [
  { match: /opus/, input: 5, output: 25 },
  { match: /sonnet/, input: 2, output: 10 },
  { match: /haiku/, input: 1, output: 5 },
  { match: /gemini-[\d.]+-pro/, input: 2, output: 12 }, // up to 200K prompt tokens
  { match: /gemini-[\d.]+-flash/, input: 0.5, output: 3 },
  // Priced like a mid-tier model so the meter visibly moves in offline demos.
  { match: /^mock/, input: 2, output: 10 },
];
const UNKNOWN_MODEL = { input: 5, output: 25 };

const round2 = (n: number) => Math.round(n * 100) / 100;

export function creditsFor(model: string, u: ModelUsage): number {
  const p = PRICES.find((x) => x.match.test(model)) ?? UNKNOWN_MODEL;
  const usd =
    (u.inputTokens * p.input + u.cacheReadTokens * p.input * 0.1 + u.cacheWriteTokens * p.input * 1.25 + u.outputTokens * p.output) /
    1_000_000;
  return round2(usd * 100);
}

export function recordUsage(entry: {
  projectId: string;
  turnId: string;
  attempt: number;
  kind: LedgerKind;
  model: string;
  usage: ModelUsage;
}): number {
  const credits = creditsFor(entry.model, entry.usage);
  db()
    .prepare(
      `INSERT INTO ledger (project_id, turn_id, attempt, kind, model, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, credits, billed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(
      entry.projectId,
      entry.turnId,
      entry.attempt,
      entry.kind,
      entry.model,
      entry.usage.inputTokens,
      entry.usage.outputTokens,
      entry.usage.cacheReadTokens,
      entry.usage.cacheWriteTokens,
      credits,
      Date.now(),
    );
  return credits;
}

/**
 * Close the books on a turn. `working` means it ended with a working preview
 * (or was a plain answer): only then is its build billed.
 */
export function settleTurn(turnId: string, working: boolean): { billed: number; free: number; balance: number } {
  const conn = db();
  if (working) conn.prepare(`UPDATE ledger SET billed = 1 WHERE turn_id = ? AND kind = 'build'`).run(turnId);
  const row = conn
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN billed = 1 THEN credits END), 0) AS billed,
              COALESCE(SUM(CASE WHEN billed = 0 THEN credits END), 0) AS free
       FROM ledger WHERE turn_id = ?`,
    )
    .get(turnId) as { billed: number; free: number };
  return { billed: round2(row.billed), free: round2(row.free), balance: balance() };
}

export function startingCredits(): number {
  return Number(process.env.FORGE_STARTING_CREDITS) || 1500;
}

/** Credits left: the starting grant minus everything billed. */
export function balance(): number {
  const row = db().prepare('SELECT COALESCE(SUM(credits), 0) AS spent FROM ledger WHERE billed = 1').get() as { spent: number };
  return round2(startingCredits() - row.spent);
}
