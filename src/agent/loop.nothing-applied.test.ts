import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { runTurn as runTurnFn } from './loop';
import type { TurnEvent } from './types';

/**
 * A reply whose <changes> block cannot be applied must end the turn as a
 * failure. Before, the model's own "the button is red now" was the last word
 * while the app had not changed at all.
 */

const BROKEN_REPLY = 'Adding the button.\n<changes>\n<write>export const x = 1;</write>\n</changes>\nThe button is red now.';

const saved: Record<string, string | undefined> = {};
let tmp = '';
let runTurn: typeof runTurnFn;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-nothing-'));
  for (const [key, value] of Object.entries({ FORGE_WORKSPACES_DIR: tmp, FORGE_DATA_DIR: tmp, SANDBOX: 'mock' })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  vi.doMock('./providers', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./providers')>()),
    getProvider: () => ({
      name: 'mock',
      modelFor: () => 'broken-model',
      async *stream() {
        yield { type: 'text', text: BROKEN_REPLY };
        yield {
          type: 'done',
          model: 'broken-model',
          stopReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    }),
  }));
  runTurn = (await import('./loop')).runTurn;
});

afterAll(async () => {
  vi.doUnmock('./providers');
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('runTurn with changes that cannot be applied', () => {
  it('ends as a failure instead of claiming the app changed', async () => {
    const events: TurnEvent[] = [];
    await runTurn({
      projectId: 'nothingapplied1',
      message: 'make the button red',
      emit: (e) => events.push(e),
      signal: new AbortController().signal,
    });
    expect(events.some((e) => e.type === 'warning')).toBe(true);
    expect(events.find((e) => e.type === 'error')).toMatchObject({ message: expect.stringMatching(/nothing in your app changed/) });
    expect(events[events.length - 1]).toMatchObject({ type: 'turn-end', outcome: 'failed', filesChanged: 0 });
    expect(events.some((e) => e.type === 'preview-reload')).toBe(false);
  }, 15_000);
});
