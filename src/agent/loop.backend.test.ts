import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { isProtectedPath as isProtectedPathFn } from '../store/projects';
import type { getSandboxProvider as getSandboxProviderFn } from '../sandbox';
import type { MockSandboxProvider as MockSandboxProviderClass } from '../sandbox/mock';
import type { runTurn as runTurnFn } from './loop';
import type { TurnEvent } from './types';

/**
 * A turn that gives the app a backend (BUILD-PROMPT M4): the model declares
 * what to store, Forge writes the data model, generates the typed client and
 * the sign-in, and the sandbox gets all of it — with no second model call.
 * What those rules then enforce is proved in src/backend/api.test.ts.
 */

const ENV = { FORGE_WORKSPACES_DIR: '', FORGE_DATA_DIR: '', PROVIDER: 'mock', MOCK_DELAY_MS: '0', SANDBOX: 'mock' };
const saved: Record<string, string | undefined> = {};
let tmp = '';
let runTurn: typeof runTurnFn;
let getSandboxProvider: typeof getSandboxProviderFn;
let isProtectedPath: typeof isProtectedPathFn;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-backend-'));
  for (const [key, value] of Object.entries({ ...ENV, FORGE_WORKSPACES_DIR: tmp, FORGE_DATA_DIR: tmp })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  // Everything is imported here, never at the top: these modules read the
  // paths above when they load, and a static import would run first — writing
  // this test's projects into the real workspaces folder.
  runTurn = (await import('./loop')).runTurn;
  getSandboxProvider = (await import('../sandbox')).getSandboxProvider;
  isProtectedPath = (await import('../store/projects')).isProtectedPath;
});

afterAll(async () => {
  (await import('../store/db')).closeDb();
  (await import('../backend/db')).closeAppDbs();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
});

async function turn(projectId: string, message: string): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  await runTurn({ projectId, message, emit: (e) => events.push(e), signal: new AbortController().signal, registry: { async lookup() { return null; } } });
  return events;
}

const ofType = <T extends TurnEvent['type']>(events: TurnEvent[], type: T) =>
  events.filter((e): e is Extract<TurnEvent, { type: T }> => e.type === type);
const gatesOf = (events: TurnEvent[]) => Object.fromEntries(ofType(events, 'gate').map((g) => [g.gate, g]));
const read = (projectId: string, file: string) => fs.readFile(path.join(tmp, projectId, file), 'utf8');
const sandboxOf = (projectId: string) => (getSandboxProvider() as MockSandboxProviderClass).sandboxes.get(projectId)!;

describe('a turn that gives the app a backend', () => {
  it('writes the data model, generates the client, and makes it private by default', async () => {
    const events = await turn('saved1', 'A task list I can sign in to, with my tasks saved');
    expect(events[events.length - 1]).toMatchObject({ type: 'turn-end', outcome: 'success' });
    expect(ofType(events, 'stage').filter((s) => s.stage === 'emit')).toHaveLength(1);
    expect(ofType(events, 'repair')).toHaveLength(0);

    // The model left the rules out; Forge filled them in rather than guessing wide open.
    const gates = gatesOf(events);
    expect(gates['data-model']).toMatchObject({ status: 'fixed' });
    expect(gates['data-model'].detail).toContain('generated data.ts and auth.tsx for Task');
    expect(gates['data-model'].detail).toContain('private by default: Task (access)');
    expect(gates.imports).toMatchObject({ status: 'pass' });

    const entity = JSON.parse(await read('saved1', 'entities/Task.json')) as { access: Record<string, string>; fields: Record<string, unknown> };
    expect(entity.access).toEqual({ read: 'owner', create: 'user', update: 'owner', delete: 'owner' });
    expect(Object.keys(entity.fields)).toEqual(['title', 'done']);

    // The client the app imports is written by Forge, not by the model.
    const data = await read('saved1', 'src/forge/data.ts');
    expect(data).toContain("export const Task = collection<Task, TaskInput>('Task');");
    expect(data).toContain('export interface Task {');
    expect(await read('saved1', 'src/forge/auth.tsx')).toContain('export function RequireSignIn(');
    expect(await read('saved1', 'src/pages/Home.tsx')).toContain("import { Task } from '../forge/data';");

    // …and the sandbox runs exactly those files.
    const sandbox = sandboxOf('saved1');
    expect(sandbox.files.get('src/forge/data.ts')).toBe(data);
    expect(sandbox.files.has('entities/Task.json')).toBe(true);
    // The user sees them appear, and the whole turn is one version.
    expect(ofType(events, 'file').map((f) => f.path)).toEqual(expect.arrayContaining(['entities/Task.json', 'src/forge/data.ts', 'src/forge/auth.tsx']));
    expect(ofType(events, 'checkpoint')).toHaveLength(1);
  }, 30_000);

  it('writes a deliberate sharing choice exactly as asked', async () => {
    const events = await turn('shared1', 'A shared team task list everyone signed in can see, with sign in');
    expect(events[events.length - 1]).toMatchObject({ type: 'turn-end', outcome: 'success' });
    const entity = JSON.parse(await read('shared1', 'entities/Task.json')) as { access: Record<string, string> };
    expect(entity.access).toEqual({ read: 'user', create: 'user', update: 'owner', delete: 'owner' });
    // Nothing was filled in, because the model said what it wanted.
    expect(gatesOf(events)['data-model'].detail).not.toContain('private by default');
    expect(await read('shared1', 'src/forge/data.ts')).toContain('read — any signed-in user');
  }, 30_000);

  it('keeps the generated client out of the model’s reach', () => {
    expect(isProtectedPath('src/forge/data.ts')).toBe(true);
    expect(isProtectedPath('src/forge/auth.tsx')).toBe(true);
    expect(isProtectedPath('src/pages/Home.tsx')).toBe(false);
    expect(isProtectedPath('entities/Task.json')).toBe(false);
  });
});
