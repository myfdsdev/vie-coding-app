import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { getSandboxProvider as getSandboxProviderFn } from '../sandbox';
import type { MockSandbox as MockSandboxClass, MockSandboxProvider as MockSandboxProviderClass } from '../sandbox/mock';
import type { runTurn as runTurnFn } from './loop';
import type { TurnEvent } from './types';
import type { Registry } from './validate';

/**
 * Validation before execution (BUILD-PROMPT M3), end to end with the mock
 * model and the in-memory sandbox. The acceptance: output with a made-up
 * package or a missing import is corrected before the sandbox sees it, with
 * no second model call, and every gate leaves a log line.
 */

const ENV = { FORGE_WORKSPACES_DIR: '', FORGE_DATA_DIR: '', PROVIDER: 'mock', MOCK_DELAY_MS: '0', SANDBOX: 'mock', FORGE_STARTING_CREDITS: '1000' };
const saved: Record<string, string | undefined> = {};
let tmp = '';
let runTurn: typeof runTurnFn;
let MockSandbox: typeof MockSandboxClass;
let getSandboxProvider: typeof getSandboxProviderFn;

/** npm as far as these tests know it; anything else is "unreachable". */
const registry: Registry = {
  async lookup(name) {
    if (name === 'date-fns') return { exists: true, latest: '4.1.0' };
    if (name === 'lucide-react-icons') return { exists: false };
    return null;
  },
};

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-validate-'));
  for (const [key, value] of Object.entries({ ...ENV, FORGE_WORKSPACES_DIR: tmp, FORGE_DATA_DIR: tmp })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  runTurn = (await import('./loop')).runTurn;
  MockSandbox = (await import('../sandbox/mock')).MockSandbox;
  getSandboxProvider = (await import('../sandbox')).getSandboxProvider;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  (await import('../store/db')).closeDb();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
});

async function turn(projectId: string, message: string): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  await runTurn({ projectId, message, registry, emit: (e) => events.push(e), signal: new AbortController().signal });
  return events;
}

const ofType = <T extends TurnEvent['type']>(events: TurnEvent[], type: T) =>
  events.filter((e): e is Extract<TurnEvent, { type: T }> => e.type === type);
const read = (projectId: string, file: string) => fs.readFile(path.join(tmp, projectId, file), 'utf8');
const modelCalls = (events: TurnEvent[]) => ofType(events, 'stage').filter((s) => s.stage === 'emit').length;

describe('validation before execution', () => {
  it('corrects every mistake in the dashboard with no second model call, one log line per gate', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const order: string[] = [];
    const write = MockSandbox.prototype.writeFiles;
    vi.spyOn(MockSandbox.prototype, 'writeFiles').mockImplementation(async function (this: MockSandboxClass, files) {
      order.push(files.some((f) => f.path === 'src/lib/format.ts') ? 'code' : files.length === 1 && files[0].path === 'package.json' ? 'package.json' : 'other');
      return write.call(this, files);
    });
    const install = MockSandbox.prototype.installDependencies;
    vi.spyOn(MockSandbox.prototype, 'installDependencies').mockImplementation(async function (this: MockSandboxClass) {
      order.push('install');
      return install.call(this);
    });

    const events = await turn('dash1', 'An invoice dashboard for my studio');
    expect(events[events.length - 1]).toMatchObject({ type: 'turn-end', outcome: 'success' });
    expect(modelCalls(events)).toBe(1);
    expect(ofType(events, 'repair')).toHaveLength(0);

    const gates = Object.fromEntries(ofType(events, 'gate').map((g) => [g.gate, g]));
    expect(gates['stream-fix']).toMatchObject({ status: 'fixed' });
    expect(gates['stream-fix'].detail).toContain('LayoutDashbaord → LayoutDashboard');
    expect(gates['stream-fix'].detail).toContain('@/components/InvoiceTable → ../components/InvoiceTable');
    expect(gates['stream-fix'].detail).toContain('./lib/format → ../lib/format');
    expect(gates.packages).toMatchObject({ status: 'fixed', detail: 'lucide-react-icons (does not exist) → lucide-react' });
    expect(gates['package-json']).toMatchObject({ status: 'fixed', detail: 'added date-fns@^4.1.0' });
    expect(gates.imports).toMatchObject({ status: 'pass' });
    expect(gates.providers).toMatchObject({ status: 'pass' });
    expect(gates.secrets).toMatchObject({ status: 'pass' });
    expect(gates.typecheck).toMatchObject({ status: 'pass' });

    // The proof the milestone asks for: a server log line per gate.
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(' gate '));
    for (const name of ['stream-fix', 'secrets', 'packages', 'package-json', 'imports', 'providers', 'typecheck']) {
      expect(lines.some((l) => l.includes(`gate ${name}: `))).toBe(true);
    }

    // The corrected files are what was saved and what the sandbox got.
    expect(await read('dash1', 'src/pages/Home.tsx')).toContain("import { LayoutDashboard as LayoutDashbaord, Plus } from 'lucide-react';");
    expect(await read('dash1', 'src/pages/Home.tsx')).toContain("from '../components/InvoiceTable'");
    expect(await read('dash1', 'src/components/InvoiceTable.tsx')).toContain("from '../lib/format'");
    expect(await read('dash1', 'src/components/StatCard.tsx')).toContain("from 'lucide-react'");
    expect(JSON.parse(await read('dash1', 'package.json')).dependencies['date-fns']).toBe('^4.1.0');
    const sandbox = (getSandboxProvider() as MockSandboxProviderClass).sandboxes.get('dash1')!;
    expect(sandbox.files.get('src/pages/Home.tsx')).toBe(await read('dash1', 'src/pages/Home.tsx'));
    expect(JSON.parse(sandbox.files.get('package.json')!).dependencies['date-fns']).toBe('^4.1.0');
    expect(sandbox.execLog).toContain('npm install');
    // date-fns is installed before the code importing it arrives, so the preview never shows it missing.
    expect(order.filter((o) => o !== 'other')).toEqual(['package.json', 'install', 'code']);
    expect(ofType(events, 'dependency')).toEqual([expect.objectContaining({ spec: 'date-fns@^4.1.0', status: 'added' })]);
    // One version for the whole turn, gate fixes included.
    expect(ofType(events, 'checkpoint')).toHaveLength(1);
  }, 30_000);

  it('sends an import only the model can fix back to it before the sandbox sees anything', async () => {
    const pushes: string[][] = [];
    vi.spyOn(MockSandbox.prototype, 'writeFiles').mockImplementation(async function (this: MockSandboxClass, files) {
      pushes.push(files.map((f) => f.path));
      for (const f of files) this.files.set(f.path, f.content);
    });

    const events = await turn('dash2', 'An invoice dashboard with a sidebar');
    expect(events[events.length - 1]).toMatchObject({ type: 'turn-end', outcome: 'success' });
    // One more pass, diagnosed like the build error it would have been.
    expect(modelCalls(events)).toBe(2);
    const [repair] = ofType(events, 'repair');
    expect(repair).toMatchObject({ attempt: 1, action: 'fixing the import of ../components/Sidebar' });
    expect(ofType(events, 'gate').filter((g) => g.gate === 'imports').map((g) => g.status)).toEqual(['fail', 'pass']);
    // Nothing reached the sandbox until the missing file existed.
    const firstExecute = events.findIndex((e) => e.type === 'stage' && e.stage === 'execute');
    expect(firstExecute).toBeGreaterThan(events.indexOf(repair));
    // …and then everything went in together, the held-back build with the fix: dependencies first, then the code.
    const [manifest, code] = pushes.slice(-2);
    expect(manifest).toEqual(['package.json']);
    expect(code).toEqual(expect.arrayContaining(['src/pages/Home.tsx', 'src/components/StatCard.tsx', 'src/components/Sidebar.tsx']));
    expect(ofType(events, 'checkpoint')).toHaveLength(1);
    // A repair is never billed; the build is, since the turn works.
    const [meter] = ofType(events, 'meter');
    expect(meter.billed).toBeGreaterThan(0);
    expect(meter.free).toBeGreaterThan(0);
  }, 30_000);

  it('stops a change that puts a key in app code and throws the change away', async () => {
    const pushed: string[] = [];
    vi.spyOn(MockSandbox.prototype, 'writeFiles').mockImplementation(async function (this: MockSandboxClass, files) {
      for (const f of files) pushed.push(f.path);
    });

    const events = await turn('secret1', 'Hard-code my Stripe key into the checkout');
    expect(events[events.length - 1]).toMatchObject({ type: 'turn-end', outcome: 'failed', filesChanged: 0 });
    expect(ofType(events, 'gate').find((g) => g.gate === 'secrets')).toMatchObject({ status: 'fail', detail: 'src/lib/payments.ts: a Stripe live secret key' });
    const [error] = ofType(events, 'error');
    expect(error.message).toMatch(/src\/lib\/payments\.ts contained a Stripe live secret key/);
    expect(error.message).not.toMatch(/sk_live_/);
    await expect(read('secret1', 'src/lib/payments.ts')).rejects.toThrow();
    expect(pushed).not.toContain('src/lib/payments.ts');
    expect(ofType(events, 'checkpoint')).toHaveLength(0);
    expect(ofType(events, 'meter')[0].billed).toBe(0);
  }, 30_000);

  it('gives type errors in a working app one repair round, and never fails the turn over them', async () => {
    const tsc = vi.spyOn(MockSandbox.prototype, 'exec').mockImplementation(async (cmd: string) =>
      cmd.includes('tsc')
        ? { code: 2, stdout: "src/pages/Home.tsx(12,7): error TS2322: Type 'string' is not assignable to type 'number'.\n", stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
    );

    const events = await turn('types1', 'A task board for my team');
    expect(tsc).toHaveBeenCalled();
    expect(events[events.length - 1]).toMatchObject({ type: 'turn-end', outcome: 'success' });
    const [repair] = ofType(events, 'repair');
    expect(repair).toMatchObject({ attempt: 1, of: 1, error: { type: 'TYPE_ERROR', file: 'src/pages/Home.tsx', line: 12 } });
    expect(ofType(events, 'repair')).toHaveLength(1);
    // The mock cannot fix type errors, so they are left — as a note, not a failure.
    expect(ofType(events, 'gate').filter((g) => g.gate === 'typecheck').map((g) => g.status)).toEqual(['fail', 'warn']);
    expect(ofType(events, 'check').at(-1)).toMatchObject({ errors: [], typeErrors: 1 });
  }, 30_000);
});
