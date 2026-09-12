const D = require('better-sqlite3');
const fs = require('fs');
const db = new D('data/forge.db');
db.pragma('foreign_keys = ON');
const info = db.prepare("DELETE FROM projects WHERE id IN ('saved1','shared1')").run();
console.log('rows deleted:', info.changes);
for (const p of ['workspaces/saved1', 'workspaces/shared1']) {
  fs.rmSync(p, { recursive: true, force: true });
  console.log('removed', p, fs.existsSync(p) ? 'FAILED' : 'ok');
}
console.log('projects left:', db.prepare('SELECT id, name FROM projects ORDER BY updated_at DESC').all().map((r) => r.id).join(', '));
