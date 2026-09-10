import type { ModelMessage } from '../agent/providers';
import type { ChatMessage } from '../ui/turn-state';
import { db } from './db';

/**
 * Two views of one conversation, both persisted per project:
 * - messages: what the builder shows (user messages and folded assistant turns)
 * - history: what the model sees, append-only so the cached prefix never
 *   changes (BUILD-PROMPT §3.3)
 */

export function listMessages(projectId: string): ChatMessage[] {
  const rows = db().prepare('SELECT body FROM messages WHERE project_id = ? ORDER BY seq').all(projectId) as { body: string }[];
  return rows.map((r) => JSON.parse(r.body) as ChatMessage);
}

export function appendMessages(projectId: string, messages: ChatMessage[]): void {
  const conn = db();
  const next = conn.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE project_id = ?');
  const insert = conn.prepare('INSERT INTO messages (project_id, seq, body, created_at) VALUES (?, ?, ?, ?)');
  conn
    .transaction(() => {
      let seq = (next.get(projectId) as { seq: number }).seq;
      for (const m of messages) insert.run(projectId, seq++, JSON.stringify(m), Date.now());
    })
    .immediate();
}

export function getHistory(projectId: string): ModelMessage[] {
  return db().prepare('SELECT role, content FROM history WHERE project_id = ? ORDER BY seq').all(projectId) as ModelMessage[];
}

export function appendHistory(projectId: string, entries: ModelMessage[]): void {
  const conn = db();
  const next = conn.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM history WHERE project_id = ?');
  const insert = conn.prepare('INSERT INTO history (project_id, seq, role, content) VALUES (?, ?, ?, ?)');
  conn
    .transaction(() => {
      let seq = (next.get(projectId) as { seq: number }).seq;
      for (const e of entries) insert.run(projectId, seq++, e.role, e.content);
    })
    .immediate();
}

/** Something the model must know on its next turn (e.g. the user restored an older version). */
export function addPendingNote(projectId: string, note: string): void {
  db()
    .prepare(
      `INSERT INTO notes (project_id, note) VALUES (?, ?)
       ON CONFLICT(project_id) DO UPDATE SET note = note || char(10) || excluded.note`,
    )
    .run(projectId, note);
}

/** Read and clear the pending note, if any. */
export function takePendingNote(projectId: string): string | null {
  const conn = db();
  return conn
    .transaction(() => {
      const row = conn.prepare('SELECT note FROM notes WHERE project_id = ?').get(projectId) as { note: string } | undefined;
      if (row) conn.prepare('DELETE FROM notes WHERE project_id = ?').run(projectId);
      return row?.note ?? null;
    })
    .immediate();
}
