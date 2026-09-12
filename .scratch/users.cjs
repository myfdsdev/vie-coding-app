const D = require('better-sqlite3');
const fs = require('fs');
const file = 'workspaces/_verify/apps/u02mb7gid6.db';
console.log('exists:', fs.existsSync(file));
const db = new D(file, { readonly: true });
for (const u of db.prepare('SELECT id, email, created_at, last_seen_at FROM users ORDER BY created_at').all()) {
  console.log(new Date(u.created_at).toISOString(), u.email);
}
console.log('--- rows:');
for (const r of db.prepare('SELECT id, owner_id, data, created_at FROM rows_ ORDER BY created_at').all()) {
  console.log(new Date(r.created_at).toISOString(), r.owner_id, r.data);
}
