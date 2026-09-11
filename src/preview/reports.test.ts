import { describe, expect, it } from 'vitest';
import { deliverReport, waitForReport } from './reports';

const OK = [{ type: 'RENDER_OK' as const, pathname: '/' }];

describe('preview reports', () => {
  it('hands a report to the turn waiting for it', async () => {
    const waiting = waitForReport('turn-a', 1, 5_000);
    deliverReport('turn-a', 1, OK);
    await expect(waiting).resolves.toEqual(OK);
  });

  it('keeps a report that arrives before the turn waits', async () => {
    deliverReport('turn-b', 0, OK);
    await expect(waitForReport('turn-b', 0, 5_000)).resolves.toEqual(OK);
  });

  it('gives up after the timeout, or when the turn is stopped', async () => {
    await expect(waitForReport('turn-c', 0, 20)).resolves.toBeNull();
    const abort = new AbortController();
    const waiting = waitForReport('turn-d', 0, 5_000, abort.signal);
    abort.abort();
    await expect(waiting).resolves.toBeNull();
  });

  it('never mixes up attempts', async () => {
    const second = waitForReport('turn-e', 2, 200);
    deliverReport('turn-e', 1, OK);
    await expect(second).resolves.toBeNull();
  });
});
