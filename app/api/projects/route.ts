import { z } from 'zod';
import { scanForSecrets, secretRefusal } from '@/agent/validate';
import { ensureRepo } from '@/store/checkpoints';
import { createProject, listProjects, projectNameFrom } from '@/store/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Recent projects for the home page. */
export async function GET() {
  return Response.json({ projects: listProjects() });
}

const Body = z.object({ prompt: z.string().trim().max(20_000).optional() });

/** A new project named after the request that starts it; v1 is the starter template. */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: 'Expected { prompt? }' }, { status: 400 });
  // Checked here too, so a key never names a project.
  const secrets = scanForSecrets(parsed.data.prompt ?? '');
  if (secrets.length) return Response.json({ error: secretRefusal(secrets) }, { status: 422 });
  const project = await createProject(parsed.data.prompt ? projectNameFrom(parsed.data.prompt) : 'untitled');
  await ensureRepo(project.id).catch((err) => console.error('[forge] could not start version history', err));
  return Response.json({ project });
}
