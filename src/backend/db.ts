import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DATA_DIR } from '../store/db';
import { assertProjectId } from '../store/projects';

/**
 * One SQLite database per generated app (BUILD-PROMPT M4).
 *
 * It lives beside the builder's own database, never inside the project's
 * workspace: restoring the code to an older version must not restore — or
 * destroy — the rows people have saved. The schema below is fixed and closed;
 * an entity never becomes a table, so no generated code and no model output
 * ever reaches SQL. Rows are JSON documents, queried through store.ts.
 */

const MIGRATIONS: string[] = [
  `CREATE TABLE users (
     id TEXT PRIMARY KEY,
     email TEXT NOT NULL UNIQUE,
     created_at INTEGER NOT NULL,
     last_seen_at INTEGER NOT NULL
   );
   CREATE TABLE codes (
     email TEXT PRIMARY KEY,
     code_hash TEXT NOT NULL,
     expires_at INTEGER NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     sent_at INTEGER NOT NULL
   );
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE TABLE rows_ (
     entity TEXT NOT NULL,
     id TEXT NOT NULL,
     owner_id TEXT,
     data TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (entity, id)
   );
   CREATE INDEX rows_by_owner ON rows_ (entity, owner_id, created_at DESC);
   CREATE TABLE secrets (
     name TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );`,
];

const g = globalThis as typeof globalThis & { __forgeAppDbs?: Map<string, Database.Database> };
const connections = (g.__forgeAppDbs ??= new Map());

export function appDbFile(projectId: string): string {
  return path.join(DATA_DIR, 'apps', `${assertProjectId(projectId)}.db`);
}

/** The app database for a project, created on first use. */
export function appDb(projectId: string): Database.Database {
  const file = appDbFile(projectId);
  let conn = connections.get(file);
  if (!conn) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    conn = new Database(file);
    conn.pragma('journal_mode = WAL');
    conn.pragma('busy_timeout = 5000');
    conn.pragma('foreign_keys = ON');
    migrate(conn);
    connections.set(file, conn);
  }
  return conn;
}

/** Close every open app database (tests delete their data folder afterwards). */
export function closeAppDbs(): void {
  for (const conn of connections.values()) conn.close();
  connections.clear();
}

function migrate(conn: Database.Database): void {
  conn
    .transaction(() => {
      const version = conn.pragma('user_version', { simple: true }) as number;
      for (let v = version; v < MIGRATIONS.length; v++) conn.exec(MIGRATIONS[v]);
      if (version < MIGRATIONS.length) conn.pragma(`user_version = ${MIGRATIONS.length}`);
    })
    .immediate();
}
