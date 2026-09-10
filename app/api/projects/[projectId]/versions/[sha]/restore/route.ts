import { WATCHER_SETTLE_MS } from '@/agent/loop';
import { pushWorkspaceChanges } from '@/sandbox';
import { addPendingNote, appendMessages } from '@/store/chats';
import { restoreVersion } from '@/store/checkpoints';
import { ensureProject, isProjectId, touchProject } from '@/store/projects';
import { newAssistantTurn, type AssistantTurn } from '@/ui/turn-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Restore an earlier version as a new one. Only code comes back: database
 * rows and anything else outside the workspace are untouched, and the chat
 * message says so.
 */
export async function POST(_req: Request, { params }: { params: { projectId: string; sha: string } }) {
  const { projectId, sha } = params;
  if (!isProjectId(projectId)) return Response.json({ error: 'invalid project id' }, { status: 400 });

  let result: Awaited<ReturnType<typeof restoreVersion>>;
  try {
    ensureProject(projectId);
    result = await restoreVersion(projectId, sha);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }

  const { version, restoredFrom, written, deleted } = result;
  const changed = written.length + deleted.length > 0;
  let warning: string | undefined;
  if (changed) {
    addPendingNote(
      projectId,
      `The user restored version v${restoredFrom.number} ("${restoredFrom.subject}"). The files are back to that state; later changes were undone.`,
    );
    try {
      await pushWorkspaceChanges(projectId, { written, deleted });
      // Let the dev server see the files before the preview reloads (see WATCHER_SETTLE_MS).
      await new Promise((r) => setTimeout(r, WATCHER_SETTLE_MS));
    } catch (err) {
      warning = `The files were restored, but the preview could not be updated yet: ${(err as Error).message}`;
    }
  }

  const message: AssistantTurn = {
    ...newAssistantTurn(`r-${version.sha}`),
    status: 'answered',
    summary: changed
      ? `Restored v${restoredFrom.number} (“${restoredFrom.subject}”) as v${version.number}. Your code is back to that version; data in any database is unchanged.`
      : `Already at v${restoredFrom.number}, so there was nothing to restore.`,
    version: changed ? { number: version.number, sha: version.sha } : undefined,
    warnings: warning ? [warning] : [],
  };
  appendMessages(projectId, [message]);
  touchProject(projectId);
  return Response.json({ version, restoredFrom, changed, message });
}
