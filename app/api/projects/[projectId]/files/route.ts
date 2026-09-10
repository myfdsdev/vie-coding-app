import { isProjectId, listProjectFiles, projectExists } from '@/store/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Every project file path, sorted — the file tree. */
export async function GET(_req: Request, { params }: { params: { projectId: string } }) {
  const { projectId } = params;
  if (!isProjectId(projectId)) return Response.json({ error: 'invalid project id' }, { status: 400 });
  if (!(await projectExists(projectId))) return Response.json({ files: [] });
  return Response.json({ files: await listProjectFiles(projectId) });
}
