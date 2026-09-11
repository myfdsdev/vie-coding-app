import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** A throwaway database; the modules read its location when loaded. */

let meter: typeof import('./meter');
let database: typeof import('./db');
let tmp = '';
const saved = { FORGE_DATA_DIR: process.env.FORGE_DATA_DIR, FORGE_STARTING_CREDITS: process.env.FORGE_STARTING_CREDITS };

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-meter-'));
  process.env.FORGE_DATA_DIR = tmp;
  process.env.FORGE_STARTING_CREDITS = '1000';
  database = await import('./db');
  meter = await import('./meter');
});

afterAll(async () => {
  database.closeDb();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
});

const usage = (inputTokens: number, outputTokens: number, cacheReadTokens = 0) => ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0 });

describe('creditsFor', () => {
  it('charges list price, one credit per cent', () => {
    // 100K input at $2/M + 10K output at $12/M = $0.20 + $0.12 = 32 cents
    expect(meter.creditsFor('gemini-3.1-pro-preview', usage(100_000, 10_000))).toBe(32);
    // Opus: 10K in at $5/M + 2K out at $25/M = $0.05 + $0.05 = 10 cents
    expect(meter.creditsFor('claude-opus-5', usage(10_000, 2_000))).toBe(10);
  });

  it('charges cached input at a tenth of the price', () => {
    expect(meter.creditsFor('claude-sonnet-5', usage(0, 0, 1_000_000))).toBe(20);
  });
});

describe('billing', () => {
  const base = { projectId: 'p1', model: 'claude-opus-5', usage: usage(10_000, 2_000) };

  it('bills the build of a working turn and never its repairs', () => {
    meter.recordUsage({ ...base, turnId: 't-ok', attempt: 0, kind: 'build' });
    meter.recordUsage({ ...base, turnId: 't-ok', attempt: 1, kind: 'repair' });
    meter.recordUsage({ ...base, turnId: 't-ok', attempt: 1, kind: 'retry' });
    expect(meter.settleTurn('t-ok', true)).toEqual({ billed: 10, free: 20, balance: 990 });
  });

  it('bills nothing for a turn that ends broken', () => {
    meter.recordUsage({ ...base, turnId: 't-broken', attempt: 0, kind: 'build' });
    meter.recordUsage({ ...base, turnId: 't-broken', attempt: 1, kind: 'repair' });
    expect(meter.settleTurn('t-broken', false)).toEqual({ billed: 0, free: 20, balance: 990 });
    expect(meter.balance()).toBe(990);
  });
});
