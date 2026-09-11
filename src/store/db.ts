import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * SQLite via better-sqlite3 (BUILD-PROMPT §4). Only src/store/* touches the
 * database, so moving to Postgres later means rewriting these modules only.
 *
 * WAL mode and a busy timeout let two local server processes share the file.
 */

export const DATA_DIR = process.env.FORGE_DATA_DIR || path.join(process.cwd(), 'data');

/** Schema changes, applied in order; PRAGMA user_version records how many have run. */
const MIGRATIONS: string[] = [
  `CREATE TABLE projects (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE messages (
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     seq INTEGER NOT NULL,
     body TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (project_id, seq)
   );
   CREATE TABLE history (
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     seq INTEGER NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
     content TEXT NOT NULL,
     PRIMARY KEY (project_id, seq)
   );
   CREATE TABLE notes (
     project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
     note TEXT NOT NULL
   );`,
  // M2: one row per model call; see meter.ts for what gets billed.
  `CREATE TABLE ledger (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     project_id TEXT NOT NULL,
     turn_id TEXT NOT NULL,
     attempt INTEGER NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('build', 'retry', 'repair')),
     model TEXT NOT NULL,
     input_tokens INTEGER NOT NULL,
     output_tokens INTEGER NOT NULL,
     cache_read_tokens INTEGER NOT NULL,
     cache_write_tokens INTEGER NOT NULL,
     credits REAL NOT NULL,
     billed INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX ledger_turn ON ledger (turn_id);`,
];

// Keyed by file so tests that point FORGE_DATA_DIR elsewhere get their own connection.
const g = globalThis as typeof globalThis & { __forgeDb?: Map<string, Database.Database> };
const connections = (g.__forgeDb ??= new Map());

export function db(): Database.Database {
  const file = path.join(DATA_DIR, 'forge.db');
  let conn = connections.get(file);
  if (!conn) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    conn = new Database(file);
    conn.pragma('journal_mode = WAL');
    conn.pragma('busy_timeout = 5000');
    conn.pragma('foreign_keys = ON');
    migrate(conn);
    connections.set(file, conn);
  }
  return conn;
}

/** Close every open connection (tests delete their data folder afterwards). */
export function closeDb(): void {
  for (const conn of connections.values()) conn.close();
  connections.clear();
}

function migrate(conn: Database.Database): void {
  // IMMEDIATE takes the write lock first, so two processes starting together
  // cannot both run the same migration.
  conn
    .transaction(() => {
      const version = conn.pragma('user_version', { simple: true }) as number;
      for (let v = version; v < MIGRATIONS.length; v++) conn.exec(MIGRATIONS[v]);
      if (version < MIGRATIONS.length) conn.pragma(`user_version = ${MIGRATIONS.length}`);
    })
    .immediate();
}
