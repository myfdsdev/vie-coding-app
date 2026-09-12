import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { appDb } from './db';
import { ApiError, type AppUser } from './store';

/**
 * Sign-in for generated apps (BUILD-PROMPT M4): an emailed six-digit code, no
 * passwords to leak or reset.
 *
 * Codes and session tokens are stored hashed, so a copy of the app database is
 * not a set of working logins. Until an email provider is configured, a code
 * is delivered through the preview itself — the preview is only reachable by
 * the person building the app, and publishing (M5) turns that off.
 */

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_AFTER_MS = 30 * 1000;
const MAX_ATTEMPTS = 5;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const SESSION_COOKIE = 'forge_app_session';

const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface CodeRequest {
  /** How the person gets the code. 'preview': shown in the app, because no email provider is configured. */
  delivery: 'preview' | 'email';
  /** Only for preview delivery. */
  code?: string;
  expiresInMs: number;
}

/**
 * Start a sign-in. The same answer comes back whether or not the address has
 * an account, so the app never becomes a way to check who is registered.
 */
export function requestCode(projectId: string, rawEmail: unknown, opts: { preview: boolean }): CodeRequest {
  const email = String(rawEmail ?? '').trim().toLowerCase();
  if (!EMAIL.test(email)) throw new ApiError(400, 'That does not look like an email address.');
  const db = appDb(projectId);
  const now = Date.now();
  const existing = db.prepare('SELECT sent_at FROM codes WHERE email = ?').get(email) as { sent_at: number } | undefined;
  if (existing && now - existing.sent_at < RESEND_AFTER_MS) {
    throw new ApiError(429, `Wait ${Math.ceil((RESEND_AFTER_MS - (now - existing.sent_at)) / 1000)} seconds before asking for another code.`);
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  db.prepare(
    `INSERT INTO codes (email, code_hash, expires_at, attempts, sent_at) VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at`,
  ).run(email, hash(code), now + CODE_TTL_MS, now);
  // Whoever runs the builder can read this; nobody else can.
  console.log(`[forge] app ${projectId}: sign-in code for ${email} is ${code}`);
  return opts.preview ? { delivery: 'preview', code, expiresInMs: CODE_TTL_MS } : { delivery: 'email', expiresInMs: CODE_TTL_MS };
}

/** Finish a sign-in: the code becomes a session token for the app's cookie. */
export function verifyCode(projectId: string, rawEmail: unknown, rawCode: unknown): { user: AppUser; token: string; expiresInMs: number } {
  const email = String(rawEmail ?? '').trim().toLowerCase();
  const code = String(rawCode ?? '').trim();
  const db = appDb(projectId);
  const now = Date.now();
  const pending = db.prepare('SELECT code_hash, expires_at, attempts FROM codes WHERE email = ?').get(email) as
    | { code_hash: string; expires_at: number; attempts: number }
    | undefined;
  if (!pending || pending.expires_at < now) throw new ApiError(400, 'That code has expired. Ask for a new one.');
  if (pending.attempts >= MAX_ATTEMPTS) throw new ApiError(429, 'Too many tries. Ask for a new code.');
  if (!sameString(pending.code_hash, hash(code))) {
    db.prepare('UPDATE codes SET attempts = attempts + 1 WHERE email = ?').run(email);
    throw new ApiError(400, 'That code is not right.');
  }
  db.prepare('DELETE FROM codes WHERE email = ?').run(email);

  let user = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email) as AppUser | undefined;
  if (!user) {
    user = { id: `u_${randomBytes(8).toString('hex')}`, email };
    db.prepare('INSERT INTO users (id, email, created_at, last_seen_at) VALUES (?, ?, ?, ?)').run(user.id, user.email, now, now);
  }
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(hash(token), user.id, now, now + SESSION_TTL_MS);
  return { user, token, expiresInMs: SESSION_TTL_MS };
}

/** The signed-in user for a session cookie, or null. */
export function sessionUser(projectId: string, token: string | undefined): AppUser | null {
  if (!token) return null;
  const db = appDb(projectId);
  const row = db
    .prepare(
      `SELECT users.id AS id, users.email AS email, sessions.expires_at AS expires_at
       FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?`,
    )
    .get(hash(token)) as { id: string; email: string; expires_at: number } | undefined;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(token));
    return null;
  }
  db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), row.id);
  return { id: row.id, email: row.email };
}

export function signOut(projectId: string, token: string | undefined): void {
  if (token) appDb(projectId).prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(token));
}

export interface AppUserRow extends AppUser {
  createdAt: number;
  lastSeenAt: number;
}

/** The app's users, for the builder's data panel. */
export function listAppUsers(projectId: string, limit = 50): AppUserRow[] {
  return appDb(projectId)
    .prepare('SELECT id, email, created_at AS createdAt, last_seen_at AS lastSeenAt FROM users ORDER BY created_at DESC LIMIT ?')
    .all(limit) as AppUserRow[];
}
