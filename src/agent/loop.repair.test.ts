import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PreviewEvent } from '../preview/events';
import type { deliverReport as deliverReportFn } from '../preview/reports';
import type { runTurn as runTurnFn } from './loop';
import type { TurnEvent } from './types';

/**
 * The self-healing loop end to end (BUILD-PROMPT M2). The mock model builds a
 * page that crashes on its first render; this test plays the builder page and
 * reports what the preview "showed"; the loop diagnoses the crash, repairs it
 * within the budget, and bills only the build. Projects and the database live
 * in a throwaway folder.
 */

const ENV = {
  FORGE_WORKSPACES_DIR: '',
  FORGE_DATA_DIR: '',
  PROVIDER: 'mock',
  MOCK_DELAY_MS: '0',
  SANDBOX: 'mock',
  FORGE_STARTING_CREDITS: '1000',
};
const saved: Record<string, string | undefined> = {};
let tmp = '';
let runTurn: typeof runTurnFn;
let deliverReport: typeof deliverReportFn;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-repair-'));
  for (const [key, value] of Object.entries({ ...ENV, FORGE_WORKSPACES_DIR: tmp, FORGE_DATA_DIR: tmp })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  runTurn = (await import('./loop')).runTurn;
  deliverReport = (await import('../preview/reports')).deliverReport;
});

afterAll(async () => {
  (await import('../store/db')).closeDb();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
});

/** What the preview posts for the demo crash: React reports it twice (MockSandbox previews live at sbx-<id>.mock.invalid). */
const crash = (projectId: string): PreviewEvent[] => [
  { type: 'UNCAUGHT_EXCEPTION', message: "Uncaught TypeError: Cannot read properties of undefined (reading 'map')", pathname: '/' },
  {
    type: 'REACT_RENDER_ERROR',
    message: "Cannot read properties of undefined (reading 'map')",
    componentStack: `\n    at Home (http://sbx-${projectId}.mock.invalid/src/pages/Home.tsx?t=1:21:18)`,
  },
];
const rendered: PreviewEvent[] = [{ type: 'RENDER_OK', pathname: '/' }];

async function turn(projectId: string, message: string, report: (attempt: number, check: number) => PreviewEvent[]): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  await runTurn({
    projectId,
    message,
    previewReports: true,
    signal: new AbortController().signal,
    emit: (e) => {
      events.push(e);
      // Play the builder page: report what the preview "showed" for this check.
      if (e.type === 'collect') setTimeout(() => deliverReport(e.turnId, e.check, report(e.attempt, e.check)), 5);
    },
  });
  return events;
}

const ofType = <T extends TurnEvent['type']>(events: TurnEvent[], type: T) =>
  events.filter((e): e is Extract<TurnEvent, { type: T }> => e.type === type);

describe('runTurn repair loop', () => {
  it('catches a crash, repairs it and bills only the build', async () => {
    const events = await turn('repairok1', 'Show my recipes — render data.map before the fetch resolves', (attempt) =>
      attempt === 0 ? crash('repairok1') : rendered,
    );
    const repairs = ofType(events, 'repair');
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatchObject({ round: 1, attempt: 1, of: 3, action: 'adding a loading guard', stuck: false });
    expect(repairs[0].error).toMatchObject({ type: 'REACT_RENDER_ERROR', file: 'src/pages/Home.tsx', line: 21 });
    // React's duplicate report of the same crash counts once.
    expect(ofType(events, 'check').map((c) => c.errors.length)).toEqual([1, 0]);
    // The build and the repair are separate versions on top of the template (v1).
    expect(ofType(events, 'checkpoint').map((c) => c.version)).toEqual([2, 3]);
    const [meter] = ofType(events, 'meter');
    expect(meter.billed).toBeGreaterThan(0);
    expect(meter.free).toBeGreaterThan(0);
    expect(meter.balance).toBeCloseTo(1000 - meter.billed, 2);
    expect(events[events.length - 1]).toMatchObject({ type: 'turn-end', outcome: 'success' });
  }, 30_000);

  it('stops after three attempts at the same failure and bills nothing', async () => {
    const events = await turn('repairstuck1', 'unfixable: render data.map before the fetch resolves', () => crash('repairstuck1'));
    // The second time the same failure comes back, the approach is wrong ("stuck").
    expect(ofType(events, 'repair').map((r) => [r.attempt, r.stuck])).toEqual([
      [1, false],
      [2, true],
      [3, true],
    ]);
    expect(ofType(events, 'repair-stopped')[0]).toMatchObject({ attempts: 3, rollback: { number: 1 } });
    const [meter] = ofType(events, 'meter');
    expect(meter.billed).toBe(0);
    expect(meter.free).toBeGreaterThan(0);
    expect(events[events.length - 1]).toMatchObject({ type: 'turn-end', outcome: 'failed' });
  }, 60_000);

  it('looks again on a fresh load before calling a blank screen a failure', async () => {
    // A cold first load can be "blank" at the shim's 2.5s deadline and fine a moment later.
    const events = await turn('blankcheck1', 'A task board for my team', (_attempt, check) =>
      check === 0 ? [{ type: 'BLANK_SCREEN', pathname: '/' }] : rendered,
    );
    expect(ofType(events, 'collect').map((c) => [c.check, c.fresh ?? false])).toEqual([
      [0, false],
      [1, true],
    ]);
    expect(ofType(events, 'repair')).toHaveLength(0);
    expect(events[events.length - 1]).toMatchObject({ type: 'turn-end', outcome: 'success' });
  }, 30_000);

  it('repairs a failure sent from the preview ("Fix it") without billing anything', async () => {
    const events: TurnEvent[] = [];
    const [, reported] = crash('fixit1');
    await runTurn({
      projectId: 'fixit1',
      message: 'Fix the error in the preview',
      previewReports: true,
      repairOf: { type: 'REACT_RENDER_ERROR', message: reported.type === 'REACT_RENDER_ERROR' ? reported.message : '', file: 'src/pages/Home.tsx' },
      signal: new AbortController().signal,
      emit: (e) => {
        events.push(e);
        if (e.type === 'collect') setTimeout(() => deliverReport(e.turnId, e.check, rendered), 5);
      },
    });
    // The turn starts as a repair: diagnosed, attempt 1 of 3, and the fix is saved as a repair version.
    expect(ofType(events, 'repair')[0]).toMatchObject({ round: 1, attempt: 1, action: 'adding a loading guard' });
    expect(ofType(events, 'check').map((c) => c.errors.length)).toEqual([0]);
    const [meter] = ofType(events, 'meter');
    expect(meter.billed).toBe(0);
    expect(meter.free).toBeGreaterThan(0);
    expect(events[events.length - 1]).toMatchObject({ type: 'turn-end', outcome: 'success' });
  }, 30_000);
});
