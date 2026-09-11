import type { PreviewEvent } from './events';

/**
 * Hand-off between the builder page and a running turn. After a change
 * reaches the preview, the page reports what the preview said (errors,
 * RENDER_OK) and the turn waits for that report.
 *
 * Kept on globalThis: the chat route and the report route are separate
 * bundles with separate copies of this module.
 */

interface Slot {
  report?: PreviewEvent[];
  waiter?: (events: PreviewEvent[] | null) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const g = globalThis as typeof globalThis & { __forgeReports?: Map<string, Slot> };
const slots = (g.__forgeReports ??= new Map());

const keyOf = (turnId: string, attempt: number) => `${turnId}:${attempt}`;

/** The page's report for this attempt, or null if none arrives in time. */
export function waitForReport(turnId: string, attempt: number, timeoutMs: number, signal?: AbortSignal): Promise<PreviewEvent[] | null> {
  const key = keyOf(turnId, attempt);
  const early = slots.get(key);
  if (early?.report) {
    if (early.timer) clearTimeout(early.timer);
    slots.delete(key);
    return Promise.resolve(early.report);
  }
  return new Promise((resolve) => {
    const finish = (events: PreviewEvent[] | null) => {
      const slot = slots.get(key);
      if (slot?.timer) clearTimeout(slot.timer);
      slots.delete(key);
      signal?.removeEventListener('abort', onAbort);
      resolve(events);
    };
    const onAbort = () => finish(null);
    signal?.addEventListener('abort', onAbort, { once: true });
    slots.set(key, { waiter: finish, timer: background(setTimeout(() => finish(null), timeoutMs)) });
  });
}

/** Deliver a report. One that arrives before the turn waits is kept for a minute. */
export function deliverReport(turnId: string, attempt: number, events: PreviewEvent[]): void {
  const key = keyOf(turnId, attempt);
  const slot = slots.get(key);
  if (slot?.waiter) {
    slot.waiter(events);
    return;
  }
  if (slot?.timer) clearTimeout(slot.timer);
  slots.set(key, { report: events, timer: background(setTimeout(() => slots.delete(key), 60_000)) });
}

/** Housekeeping timers must never keep the process alive on their own. */
function background(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  (timer as { unref?: () => void }).unref?.();
  return timer;
}
