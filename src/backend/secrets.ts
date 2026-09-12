import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appDb, appDbFile } from './db';
import { DATA_DIR } from '../store/db';

/**
 * Write-only secrets, one set per project (BUILD-PROMPT M4, principle §3.7).
 *
 * A value goes in and never comes back out: no API returns it, it is never
 * written into the app's code where every visitor could read it, and it never
 * reaches a model prompt — the model is told the NAMES only. Server-side code
 * reads a value with getSecret(); nothing else may.
 */

const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

export class SecretError extends Error {}

function keyFile(): string {
  return path.join(DATA_DIR, 'secret.key');
}

/** The local encryption key, created on first use and readable only by this account. */
function key(): Buffer {
  const fromEnv = process.env.FORGE_SECRET_KEY;
  if (fromEnv) {
    const buf = Buffer.from(fromEnv, 'base64');
    if (buf.length !== 32) throw new SecretError('FORGE_SECRET_KEY must be 32 bytes, base64 encoded.');
    return buf;
  }
  const file = keyFile();
  if (!fs.existsSync(file)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 });
  }
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
}

function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}

function decrypt(stored: string): string {
  const [iv, tag, body] = stored.split('.');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
}

export function setSecret(projectId: string, name: string, value: string): void {
  if (!NAME.test(name)) throw new SecretError('A secret name looks like STRIPE_SECRET_KEY: capitals, digits and underscores.');
  if (!value.trim()) throw new SecretError('A secret needs a value.');
  if (value.length > 8_000) throw new SecretError('That value is too long to store as a secret.');
  const now = Date.now();
  appDb(projectId)
    .prepare(
      `INSERT INTO secrets (name, value, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(name, encrypt(value), now, now);
}

export interface SecretInfo {
  name: string;
  updatedAt: number;
}

/** Names only — there is no API anywhere that returns a value. */
export function listSecrets(projectId: string): SecretInfo[] {
  // Asking must not create an app database for a project that stores nothing.
  if (!fs.existsSync(appDbFile(projectId))) return [];
  return appDb(projectId).prepare('SELECT name, updated_at AS updatedAt FROM secrets ORDER BY name').all() as SecretInfo[];
}

export function deleteSecret(projectId: string, name: string): boolean {
  return appDb(projectId).prepare('DELETE FROM secrets WHERE name = ?').run(name).changes > 0;
}

/**
 * The value, for server-side use only. Never return this from a route, never
 * put it in a prompt, never write it into a file the sandbox receives.
 */
export function getSecret(projectId: string, name: string): string | null {
  const row = appDb(projectId).prepare('SELECT value FROM secrets WHERE name = ?').get(name) as { value: string } | undefined;
  return row ? decrypt(row.value) : null;
}
