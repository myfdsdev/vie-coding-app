import { z } from 'zod';
import { parsePreviewEvent, type PreviewEvent } from '@/preview/events';
import { deliverReport } from '@/preview/reports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  attempt: z.number().int().min(0).max(50),
  events: z.array(z.unknown()).max(300),
});

/** What the preview showed after a change, reported by the builder page to the turn waiting for it. */
export async function POST(req: Request, { params }: { params: { turnId: string } }) {
  if (!/^[0-9a-f-]{36}$/i.test(params.turnId)) return Response.json({ error: 'invalid turn id' }, { status: 400 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Expected { attempt, events }' }, { status: 400 });
  // The events were produced by generated code: validate every one again here.
  const events = parsed.data.events.map((e) => parsePreviewEvent(e)).filter((e): e is PreviewEvent => e !== null);
  deliverReport(params.turnId, parsed.data.attempt, events);
  return Response.json({ ok: true, received: events.length });
}
