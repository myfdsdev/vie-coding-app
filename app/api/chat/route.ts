import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { runTurn } from '@/agent/loop';
import type { TurnEvent } from '@/agent/types';
import { appendMessages } from '@/store/chats';
import { isProjectId } from '@/store/projects';
import { applyTurnEvent, newAssistantTurn, type UserMessage } from '@/ui/turn-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A failure the builder page asks Forge to fix ("Fix it"). It came from generated code, so it is capped. */
const PreviewErrorSchema = z.object({
  type: z.enum(['BUILD_ERROR', 'REACT_RENDER_ERROR', 'UNCAUGHT_EXCEPTION', 'UNHANDLED_REJECTION', 'BLANK_SCREEN']),
  message: z.string().max(1000),
  stack: z.string().max(4000).optional(),
  componentStack: z.string().max(4000).optional(),
  frame: z.string().max(1500).optional(),
  file: z.string().max(300).optional(),
  line: z.number().int().optional(),
});

const Body = z.object({
  projectId: z.string(),
  message: z.string().trim().min(1).max(20_000),
  /** The page will report what the preview shows after each change. */
  previewReports: z.boolean().optional(),
  repairOf: PreviewErrorSchema.optional(),
});

/** SSE endpoint: one agent turn, streamed as TurnEvents and saved to the chat when it ends. */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !isProjectId(parsed.data.projectId)) {
    return Response.json({ error: 'Expected { projectId, message }' }, { status: 400 });
  }
  const { projectId, message, previewReports, repairOf } = parsed.data;

  const abort = new AbortController();
  req.signal.addEventListener('abort', () => abort.abort());
  const encoder = new TextEncoder();
  const key = randomUUID();
  const user: UserMessage = { id: `u-${key}`, role: 'user', text: message };
  // The same reducer the builder uses, so a reloaded chat looks exactly as it streamed.
  let turn = newAssistantTurn(`a-${key}`);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit = (event: TurnEvent) => {
        turn = applyTurnEvent(turn, event);
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          open = false;
        }
      };
      await runTurn({ projectId, message, emit, signal: abort.signal, previewReports, repairOf });
      try {
        appendMessages(projectId, [user, turn]);
      } catch (err) {
        console.error('[forge] could not save the chat', err);
      }
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
