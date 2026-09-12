import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The generated app's backend over HTTP, the way the app's own code reaches
 * it — including the session cookie. This is BUILD-PROMPT M4's acceptance:
 * a user signs in, writes rows, and a second user provably cannot read them.
 */

type Handler = (req: Request, ctx: { params: { projectId: string; path: string[] } }) => Promise<Response>;

const saved = { data: process.env.FORGE_DATA_DIR, workspaces: process.env.FORGE_WORKSPACES_DIR };
let tmp = '';
let route: Record<'GET' | 'POST' | 'PATCH' | 'DELETE', Handler>;

const PROJECT = 'apitest1';

const TASK_ENTITY = JSON.stringify({
  name: 'Task',
  fields: { title: { type: 'string', required: true }, done: { type: 'boolean', default: false } },
  access: { read: 'owner', create: 'user', update: 'owner', delete: 'owner' },
});

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-api-'));
  process.env.FORGE_DATA_DIR = path.join(tmp, 'data');
  process.env.FORGE_WORKSPACES_DIR = path.join(tmp, 'workspaces');
  await fs.mkdir(path.join(tmp, 'workspaces', PROJECT, 'entities'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'workspaces', PROJECT, 'entities', 'Task.json'), TASK_ENTITY);
  route = (await import('../../app/api/app/[projectId]/[...path]/route')) as unknown as typeof route;
});

afterAll(async () => {
  (await import('./db')).closeAppDbs();
  for (const [key, value] of [
    ['FORGE_DATA_DIR', saved.data],
    ['FORGE_WORKSPACES_DIR', saved.workspaces],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
});

interface Options {
  body?: unknown;
  cookie?: string;
  /** Preview requests get the sign-in code back; published ones never do. */
  preview?: boolean;
}

async function api(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', target: string, opts: Options = {}) {
  const [pathname, search] = target.split('?');
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.preview !== false) headers['x-forge-preview'] = '1';
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const url = `http://sbx-${PROJECT}.localhost:3000/api/app/${PROJECT}/${pathname}${search ? `?${search}` : ''}`;
  const req = new Request(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const res = await route[method](req, { params: { projectId: PROJECT, path: pathname.split('/') } });
  const text = await res.text();
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
    cookie: (res.headers.get('set-cookie') ?? '').split(';')[0],
    setCookie: res.headers.get('set-cookie') ?? '',
  };
}

/** Sign someone in the way the generated form does, and return their cookie. */
async function signIn(email: string): Promise<string> {
  const asked = await api('POST', 'auth/code', { body: { email } });
  expect(asked.status).toBe(200);
  const verified = await api('POST', 'auth/verify', { body: { email, code: (asked.body as { code: string }).code } });
  expect(verified.status).toBe(200);
  expect(verified.setCookie).toMatch(/HttpOnly/);
  expect(verified.setCookie).toMatch(/SameSite=Lax/);
  return verified.cookie;
}

describe('a generated app’s backend', () => {
  it('signs a user in and keeps their rows from anyone else', async () => {
    const alice = await signIn('alice@example.com');
    expect((await api('GET', 'auth/me', { cookie: alice })).body).toMatchObject({ user: { email: 'alice@example.com' } });

    const created = await api('POST', 'data/Task', { cookie: alice, body: { title: 'Alice’s private plan' } });
    expect(created.status).toBe(201);
    const row = (created.body as { row: { id: string; done: boolean; ownerId: string } }).row;
    expect(row.done).toBe(false);
    expect((await api('GET', 'data/Task', { cookie: alice })).body).toMatchObject({ rows: [{ id: row.id }] });

    // A second person, in the same app, cannot reach any of it.
    const bob = await signIn('bob@example.com');
    expect((await api('GET', 'data/Task', { cookie: bob })).body).toEqual({ rows: [] });
    expect((await api('GET', `data/Task/${row.id}`, { cookie: bob })).status).toBe(404);
    expect((await api('PATCH', `data/Task/${row.id}`, { cookie: bob, body: { title: 'taken' } })).status).toBe(404);
    expect((await api('DELETE', `data/Task/${row.id}`, { cookie: bob })).status).toBe(404);
    // Nor by asking for Alice's rows directly.
    const filtered = await api('GET', `data/Task?q=${encodeURIComponent(JSON.stringify({ where: { ownerId: row.ownerId } }))}`, { cookie: bob });
    expect(filtered.body).toEqual({ rows: [] });
    // Alice's row is exactly as she left it.
    expect((await api('GET', `data/Task/${row.id}`, { cookie: alice })).body).toMatchObject({ row: { title: 'Alice’s private plan' } });
  });

  it('turns a signed-out request away with 401', async () => {
    expect((await api('GET', 'data/Task')).status).toBe(401);
    expect((await api('POST', 'data/Task', { body: { title: 'x' } })).status).toBe(401);
    expect((await api('GET', 'auth/me')).body).toEqual({ user: null });
  });

  it('updates and deletes for the owner, and ends the session on sign-out', async () => {
    const carol = await signIn('carol@example.com');
    const { body } = await api('POST', 'data/Task', { cookie: carol, body: { title: 'Water the plants' } });
    const id = (body as { row: { id: string } }).row.id;
    expect((await api('PATCH', `data/Task/${id}`, { cookie: carol, body: { done: true } })).body).toMatchObject({ row: { done: true, title: 'Water the plants' } });
    expect((await api('DELETE', `data/Task/${id}`, { cookie: carol })).status).toBe(200);
    expect((await api('GET', 'data/Task', { cookie: carol })).body).toEqual({ rows: [] });

    await api('POST', 'auth/signout', { cookie: carol, body: {} });
    expect((await api('GET', 'auth/me', { cookie: carol })).body).toEqual({ user: null });
  });

  it('refuses what the data model does not allow', async () => {
    const dave = await signIn('dave@example.com');
    expect((await api('POST', 'data/Task', { cookie: dave, body: { done: true } })).body).toMatchObject({ error: 'title is required.' });
    expect((await api('POST', 'data/Task', { cookie: dave, body: { title: 'x', colour: 'red' } })).body).toMatchObject({ error: 'Task has no field "colour".' });
    expect((await api('GET', 'data/Invoice', { cookie: dave })).status).toBe(404);
    expect((await api('GET', 'data/Task?q=not-json', { cookie: dave })).status).toBe(400);
  });

  it('hands out the sign-in code in the preview only', async () => {
    const preview = await api('POST', 'auth/code', { body: { email: 'erin@example.com' } });
    expect(preview.body).toMatchObject({ delivery: 'preview', code: expect.stringMatching(/^\d{6}$/) as unknown as string });
    const published = await api('POST', 'auth/code', { body: { email: 'frank@example.com' }, preview: false });
    expect(published.body).toMatchObject({ delivery: 'email' });
    expect((published.body as { code?: string }).code).toBeUndefined();
  });
});
