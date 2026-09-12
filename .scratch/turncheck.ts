import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-dbg-'));
  Object.assign(process.env, { FORGE_WORKSPACES_DIR: tmp, FORGE_DATA_DIR: tmp, PROVIDER: 'mock', MOCK_DELAY_MS: '0', SANDBOX: 'mock' });
  const { runTurn } = await import('../src/agent/loop');
  const events: string[] = [];
  await runTurn({
    projectId: 'shared1',
    message: 'A shared team task list everyone signed in can see, with sign in',
    signal: new AbortController().signal,
    registry: { async lookup() { return null; } },
    emit: (e) => {
      if (e.type === 'file') events.push(`file ${e.status} ${e.path} ${e.error ?? ''}`);
      if (e.type === 'gate') events.push(`gate ${e.gate}: ${e.status} — ${e.detail}`);
      if (e.type === 'warning') events.push(`warning ${e.message}`);
      if (e.type === 'error') events.push(`error ${e.message}`);
      if (e.type === 'turn-end') events.push(`turn-end ${e.outcome}`);
    },
  });
  console.log(events.join('\n'));
  const walk = async (dir: string, rel = ''): Promise<string[]> => {
    const out: string[] = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) out.push(...(await walk(path.join(dir, entry.name), next)));
      else out.push(next);
    }
    return out;
  };
  console.log('---- files:', (await walk(path.join(tmp, 'shared1'))).filter((f) => f.includes('entities') || f.includes('forge') || f.includes('pages')).join(', '));
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
}
void main();
