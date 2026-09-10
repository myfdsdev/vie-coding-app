import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockSandbox as MockSandboxClass } from '../sandbox/mock';
import type { runTurn as runTurnFn } from './loop';
import type { TurnEvent } from './types';

/**
 * runTurn end to end with the mock model and the in-memory sandbox, checking
 * the events that decide whether the preview iframe is (re)mounted. Projects
 * live in a throwaway folder; the modules read these settings when loaded, so
 * they are imported only after the environment is set.
 */

const ENV = { FORGE_WORKSPACES_DIR: '', FORGE_DATA_DIR: '', PROVIDER: 'mock', MOCK_DELAY_MS: '0', SANDBOX: 'mock' };
const saved: Record<string, string | undefined> = {};
let tmp = '';
let runTurn: typeof runTurnFn;
let settleMs = 0;
let MockSandbox: typeof MockSandboxClass;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-turn-'));
  for (const [key, value] of Object.entries({ ...ENV, FORGE_WORKSPACES_DIR: tmp, FORGE_DATA_DIR: tmp })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  const loop = await import('./loop');
  runTurn = loop.runTurn;
  settleMs = loop.WATCHER_SETTLE_MS;
  MockSandbox = (await import('../sandbox/mock')).MockSandbox;
});

afterAll(async () => {
  vi.restoreAllMocks();
  (await import('../store/db')).closeDb();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
});

type Stamped = { at: number; e: TurnEvent };

async function turn(projectId: string): Promise<Stamped[]> {
  const events: Stamped[] = [];
  await runTurn({
    projectId,
    message: 'A recipe box with cook times',
    emit: (e) => events.push({ at: Date.now(), e }),
    signal: new AbortController().signal,
  });
  return events;
}

const sandboxStatuses = (events: Stamped[]) =>
  events.flatMap(({ e }) => (e.type === 'sandbox' ? [e.status] : []));

describe('runTurn preview handling', () => {
  it('keeps a live preview mounted when the dev server was already serving', async () => {
    const events = await turn('turnserving1');
    expect(events[events.length - 1].e).toMatchObject({ type: 'turn-end', outcome: 'success' });
    // 'starting' would make the pane unmount the live iframe; HMR delivers the change instead.
    expect(sandboxStatuses(events)).toEqual(['ready']);
    expect(events.some(({ e }) => e.type === 'preview-reload')).toBe(false);
  }, 15_000);

  it('remounts, after the watcher settles, when the sandbox came up during the turn', async () => {
    // The first status() call is the check at turn start: a sandbox that was
    // (re)created has no live preview attached, even once it serves.
    vi.spyOn(MockSandbox.prototype, 'status').mockResolvedValueOnce('starting');
    const events = await turn('turnrestart1');
    expect(sandboxStatuses(events)).toEqual(['starting', 'ready']);

    const lastFile = Math.max(...events.filter(({ e }) => e.type === 'file').map(({ at }) => at));
    const readyIndex = events.findIndex(({ e }) => e.type === 'sandbox' && e.status === 'ready');
    const reloadIndex = events.findIndex(({ e }) => e.type === 'preview-reload');
    expect(reloadIndex).toBeGreaterThan(readyIndex);
    // Nothing may mount the preview inside the watcher window after the write.
    expect(events[readyIndex].at - lastFile).toBeGreaterThanOrEqual(settleMs - 20);
  }, 15_000);
});
