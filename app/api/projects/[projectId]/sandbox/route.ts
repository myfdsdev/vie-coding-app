import { ensureSandbox, waitForReady } from '@/sandbox';
import { ensureWorkspace, isProjectId } from '@/store/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Warm-up: create (or resume) the project's sandbox and wait for the dev
 * server. The builder calls this on page load so the sandbox is already hot
 * by the time the user sends their first message.
 */
export async function POST(_req: Request, { params }: { params: { projectId: string } }) {
  const { projectId } = params;
  if (!isProjectId(projectId)) return Response.json({ error: 'invalid project id' }, { status: 400 });
  try {
    await ensureWorkspace(projectId);
    const sandbox = await ensureSandbox(projectId);
    const status = await waitForReady(sandbox, 90_000);
    return Response.json({ status, previewUrl: sandbox.previewUrl() });
  } catch (err) {
    return Response.json({ status: 'crashed', error: err instanceof Error ? err.message : String(err) }, { status: 503 });
  }
}
