import { z } from 'zod';
import { runTurn } from '@/agent/loop';
import type { TurnEvent } from '@/agent/types';
import { isProjectId } from '@/store/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  projectId: z.string(),
  message: z.string().trim().min(1).max(20_000),
});

/** SSE endpoint: one agent turn, streamed as TurnEvents. */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !isProjectId(parsed.data.projectId)) {
    return Response.json({ error: 'Expected { projectId, message }' }, { status: 400 });
  }
  const { projectId, message } = parsed.data;

  const abort = new AbortController();
  req.signal.addEventListener('abort', () => abort.abort());
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit = (event: TurnEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          open = false;
        }
      };
      await runTurn({ projectId, message, emit, signal: abort.signal });
      open = false;
      try {
        controller.close();
      } catch {
        /* client already gone */
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      // no-transform stops the compression middleware from buffering the stream
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
