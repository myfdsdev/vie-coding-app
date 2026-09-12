import { deleteAppDb } from '@/backend/db';
import { destroySandbox } from '@/sandbox';
import { deleteProject, getProject, isProjectId } from '@/store/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Delete a project and everything that belongs to it: the code, the chat, the
 * version history, the sandbox, and the data people saved in the app. It
 * cannot be undone, so the button in the UI asks twice before calling this.
 */
export async function DELETE(_req: Request, { params }: { params: { projectId: string } }) {
  const { projectId } = params;
  if (!isProjectId(projectId)) return Response.json({ error: 'invalid project id' }, { status: 400 });
  const project = getProject(projectId);

  // The container first: it holds the volume, and it keeps running otherwise.
  await destroySandbox(projectId);
  try {
    deleteAppDb(projectId);
  } catch (err) {
    console.error('[forge] could not remove the app data', err);
  }
  await deleteProject(projectId);
  console.log(`[forge] deleted project ${projectId}${project ? ` (${project.name})` : ''}`);
  return Response.json({ ok: true });
}
