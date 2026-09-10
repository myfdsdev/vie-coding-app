import { listVersions } from '@/store/checkpoints';
import { isProjectId, projectExists } from '@/store/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Saved versions, newest first. */
export async function GET(_req: Request, { params }: { params: { projectId: string } }) {
  const { projectId } = params;
  if (!isProjectId(projectId)) return Response.json({ error: 'invalid project id' }, { status: 400 });
  if (!(await projectExists(projectId))) return Response.json({ versions: [] });
  try {
    return Response.json({ versions: await listVersions(projectId) });
  } catch (err) {
    return Response.json({ error: `Version history is unavailable: ${(err as Error).message}` }, { status: 500 });
  }
}
