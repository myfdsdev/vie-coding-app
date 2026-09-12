const D = require('better-sqlite3');
const fs = require('fs');
const db = new D('data/forge.db', { readonly: true });
console.log('stray rows:', db.prepare("SELECT id, name, created_at FROM projects WHERE id IN ('saved1','shared1')").all());
console.log('total projects:', db.prepare('SELECT COUNT(*) AS n FROM projects').get());
for (const p of ['workspaces/saved1', 'workspaces/shared1']) {
  const s = fs.statSync(p);
  console.log(p, 'created', s.birthtime.toISOString(), 'modified', s.mtime.toISOString());
}
console.log('now', new Date().toISOString());
