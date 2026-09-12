import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Sign-in for generated apps: a six-digit code, hashed at rest, one session per browser. */

const saved = process.env.FORGE_DATA_DIR;
let tmp = '';
let auth: typeof import('./auth');
let appDb: typeof import('./db').appDb;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-auth-'));
  process.env.FORGE_DATA_DIR = tmp;
  auth = await import('./auth');
  appDb = (await import('./db')).appDb;
});

afterAll(async () => {
  (await import('./db')).closeAppDbs();
  if (saved === undefined) delete process.env.FORGE_DATA_DIR;
  else process.env.FORGE_DATA_DIR = saved;
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
});

describe('email sign-in', () => {
  it('turns a code into a session, and the same address into the same user', () => {
    const first = auth.requestCode('auth1', 'ALICE@example.com ', { preview: true });
    expect(first.code).toMatch(/^\d{6}$/);
    const { user, token } = auth.verifyCode('auth1', 'alice@example.com', first.code!);
    expect(user.email).toBe('alice@example.com');
    expect(auth.sessionUser('auth1', token)).toEqual(user);

    const again = auth.requestCode('auth1', 'alice@example.com', { preview: true });
    const second = auth.verifyCode('auth1', 'alice@example.com', again.code!);
    expect(second.user.id).toBe(user.id);
    // Signing in elsewhere does not end the first session.
    expect(auth.sessionUser('auth1', token)).toEqual(user);
  });

  it('never stores the code or the token in a usable form', () => {
    const { code } = auth.requestCode('auth2', 'bob@example.com', { preview: true });
    const { token } = auth.verifyCode('auth2', 'bob@example.com', code!);
    const rows = appDb('auth2').prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[];
    expect(rows[0].token_hash).not.toBe(token);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('refuses a wrong code, gives up after five tries, and forgets a used one', () => {
    const { code } = auth.requestCode('auth3', 'carol@example.com', { preview: true });
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect(() => auth.verifyCode('auth3', 'carol@example.com', wrong)).toThrow(/not right/);
    expect(() => auth.verifyCode('auth3', 'carol@example.com', code!)).toThrow(/Too many tries/);

    const fresh = auth.requestCode('auth3', 'dave@example.com', { preview: true });
    auth.verifyCode('auth3', 'dave@example.com', fresh.code!);
    expect(() => auth.verifyCode('auth3', 'dave@example.com', fresh.code!)).toThrow(/expired/);
  });

  it('checks the address and slows down repeat requests', () => {
    expect(() => auth.requestCode('auth4', 'not-an-email', { preview: true })).toThrow(/email address/);
    auth.requestCode('auth4', 'erin@example.com', { preview: true });
    expect(() => auth.requestCode('auth4', 'erin@example.com', { preview: true })).toThrow(/Wait \d+ seconds/);
  });

  it('hands the code over only in the preview, never once it is published', () => {
    const published = auth.requestCode('auth5', 'frank@example.com', { preview: false });
    expect(published).toMatchObject({ delivery: 'email' });
    expect(published.code).toBeUndefined();
  });

  it('ends a session on sign-out', () => {
    const { code } = auth.requestCode('auth6', 'gail@example.com', { preview: true });
    const { token } = auth.verifyCode('auth6', 'gail@example.com', code!);
    auth.signOut('auth6', token);
    expect(auth.sessionUser('auth6', token)).toBeNull();
    expect(auth.sessionUser('auth6', undefined)).toBeNull();
  });

  it('lists who has signed in, for the builder panel', () => {
    const { code } = auth.requestCode('auth7', 'hank@example.com', { preview: true });
    auth.verifyCode('auth7', 'hank@example.com', code!);
    expect(auth.listAppUsers('auth7').map((u) => u.email)).toEqual(['hank@example.com']);
  });
});
