import { SESSION_COOKIE, requestCode, sessionUser, signOut, verifyCode } from '@/backend/auth';
import { loadEntity } from '@/backend/model';
import { ApiError, createRow, deleteRow, getRow, listRows, updateRow, type Query } from '@/backend/store';
import { isProjectId } from '@/store/projects';

/**
 * The backend of a generated app (BUILD-PROMPT M4). The app's own JavaScript
 * calls it from the preview origin as /_forge/... — the custom server rewrites
 * those requests here (server.ts), so the app and its data share one origin
 * and the sandbox container never sees the data or the session.
 *
 * Everything a browser sends is untrusted: access rules are applied in
 * src/backend/store.ts, on every single request.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: { projectId: string; path: string[] } };

export function GET(req: Request, ctx: Context) {
  return handle(req, ctx, 'GET');
}
export function POST(req: Request, ctx: Context) {
  return handle(req, ctx, 'POST');
}
export function PATCH(req: Request, ctx: Context) {
  return handle(req, ctx, 'PATCH');
}
export function DELETE(req: Request, ctx: Context) {
  return handle(req, ctx, 'DELETE');
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });

/** Only the custom server sets this, and it strips whatever the client sent. */
const isPreview = (req: Request) => req.headers.get('x-forge-preview') === '1';

function cookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

function sessionCookie(req: Request, token: string, maxAgeSeconds: number): string {
  const secure = new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';
  // Lax keeps another site from using the cookie in a cross-site request.
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

async function body(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new ApiError(400, 'Expected a JSON body.');
  }
}

async function handle(req: Request, { params }: Context, method: string): Promise<Response> {
  const { projectId } = params;
  const [area, ...rest] = params.path ?? [];
  if (!isProjectId(projectId)) return json({ error: 'Unknown app.' }, 404);
  try {
    if (area === 'auth') return await auth(req, projectId, rest, method);
    if (area === 'data') return await data(req, projectId, rest, method);
    return json({ error: 'Not found.' }, 404);
  } catch (err) {
    if (err instanceof ApiError) return json({ error: err.message }, err.status);
    console.error('[forge] app api failed', err);
    return json({ error: 'Something went wrong on the server.' }, 500);
  }
}

async function auth(req: Request, projectId: string, path: string[], method: string): Promise<Response> {
  const [action] = path;
  const token = cookie(req, SESSION_COOKIE);

  if (action === 'me' && method === 'GET') return json({ user: sessionUser(projectId, token) });

  if (action === 'code' && method === 'POST') {
    const { email } = (await body(req)) as { email?: unknown };
    const result = requestCode(projectId, email, { preview: isPreview(req) });
    return json(result);
  }

  if (action === 'verify' && method === 'POST') {
    const { email, code } = (await body(req)) as { email?: unknown; code?: unknown };
    const { user, token: session, expiresInMs } = verifyCode(projectId, email, code);
    return json({ user }, 200, { 'set-cookie': sessionCookie(req, session, Math.floor(expiresInMs / 1000)) });
  }

  if (action === 'signout' && method === 'POST') {
    signOut(projectId, token);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(req, '', 0) });
  }

  return json({ error: 'Not found.' }, 404);
}

function query(req: Request): Query {
  const raw = new URL(req.url).searchParams.get('q');
  if (!raw) return {};
  if (raw.length > 4_000) throw new ApiError(400, 'That query is too long.');
  try {
    const parsed = JSON.parse(raw) as Query;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new ApiError(400, 'That query is not valid.');
  }
}

async function data(req: Request, projectId: string, path: string[], method: string): Promise<Response> {
  const [name, id] = path;
  if (!name) return json({ error: 'Not found.' }, 404);
  const entity = await loadEntity(projectId, name);
  const caller = sessionUser(projectId, cookie(req, SESSION_COOKIE));

  if (!id) {
    if (method === 'GET') return json(listRows(projectId, entity, caller, query(req)));
    if (method === 'POST') return json({ row: createRow(projectId, entity, caller, await body(req)) }, 201);
  } else {
    if (method === 'GET') return json({ row: getRow(projectId, entity, caller, id) });
    if (method === 'PATCH') return json({ row: updateRow(projectId, entity, caller, id, await body(req)) });
    if (method === 'DELETE') {
      deleteRow(projectId, entity, caller, id);
      return json({ ok: true });
    }
  }
  return json({ error: `${method} is not supported here.` }, 405);
}
