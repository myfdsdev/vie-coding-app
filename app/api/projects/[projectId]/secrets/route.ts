import { z } from 'zod';
import { SecretError, deleteSecret, listSecrets, setSecret } from '@/backend/secrets';
import { isProjectId } from '@/store/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The project's secrets, by name only. Nothing here ever returns a value:
 * a stored key is write-only from the moment it arrives (§3.7).
 */
export async function GET(_req: Request, { params }: { params: { projectId: string } }) {
  if (!isProjectId(params.projectId)) return Response.json({ error: 'invalid project id' }, { status: 400 });
  return Response.json({ secrets: listSecrets(params.projectId) });
}

const Body = z.object({ name: z.string().trim().min(1).max(64), value: z.string().min(1).max(8_000) });

export async function POST(req: Request, { params }: { params: { projectId: string } }) {
  if (!isProjectId(params.projectId)) return Response.json({ error: 'invalid project id' }, { status: 400 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Expected { name, value }' }, { status: 400 });
  try {
    setSecret(params.projectId, parsed.data.name.toUpperCase(), parsed.data.value);
  } catch (err) {
    if (err instanceof SecretError) return Response.json({ error: err.message }, { status: 400 });
    throw err;
  }
  return Response.json({ secrets: listSecrets(params.projectId) });
}

export async function DELETE(req: Request, { params }: { params: { projectId: string } }) {
  if (!isProjectId(params.projectId)) return Response.json({ error: 'invalid project id' }, { status: 400 });
  const name = new URL(req.url).searchParams.get('name') ?? '';
  if (!name) return Response.json({ error: 'Expected ?name=' }, { status: 400 });
  deleteSecret(params.projectId, name);
  return Response.json({ secrets: listSecrets(params.projectId) });
}
