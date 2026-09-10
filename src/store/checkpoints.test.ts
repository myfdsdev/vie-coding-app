import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Real git in a throwaway workspaces folder; the modules read the folder when loaded. */

let checkpoints: typeof import('./checkpoints');
let projects: typeof import('./projects');
let tmp = '';
const saved = process.env.FORGE_WORKSPACES_DIR;
const ID = 'gitproject1';

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-git-'));
  process.env.FORGE_WORKSPACES_DIR = tmp;
  projects = await import('./projects');
  checkpoints = await import('./checkpoints');
});

afterAll(async () => {
  if (saved === undefined) delete process.env.FORGE_WORKSPACES_DIR;
  else process.env.FORGE_WORKSPACES_DIR = saved;
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
});

describe('checkpoints', () => {
  it('starts with the template and commits one version per change', async () => {
    await projects.ensureWorkspace(ID);
    await checkpoints.ensureRepo(ID);
    expect((await checkpoints.listVersions(ID)).map((v) => [v.number, v.kind])).toEqual([[1, 'template']]);

    await projects.writeProjectFile(ID, 'src/pages/Home.tsx', 'export default function Home() { return null; }\n');
    await projects.writeProjectFile(ID, 'src/new.ts', 'export const x = 1;\n');
    const v2 = await checkpoints.checkpoint(ID, { subject: 'Add a thing', kind: 'turn', turnId: 't-1' });
    expect(v2).toMatchObject({ number: 2, subject: 'Add a thing', kind: 'turn', turnId: 't-1', added: 1, modified: 1, deleted: 0 });

    expect(await checkpoints.checkpoint(ID, { subject: 'Nothing changed', kind: 'turn' })).toBeNull();
  });

  it('restores an old version as a new one, removing files added since', async () => {
    const [latest, template] = await checkpoints.listVersions(ID);
    expect(latest.number).toBe(2);
    const result = await checkpoints.restoreVersion(ID, template.sha);
    expect(result.version).toMatchObject({ number: 3, kind: 'restore' });
    expect(result.restoredFrom.number).toBe(1);
    expect(result.deleted).toEqual(['src/new.ts']);
    expect(result.written).toEqual(['src/pages/Home.tsx']);
    expect(await projects.readProjectFile(ID, 'src/new.ts')).toBeNull();
    expect(await projects.readProjectFile(ID, 'src/pages/Home.tsx')).toContain('Ready to build');
  });

  it('rejects anything that is not a version of this project', async () => {
    await expect(checkpoints.restoreVersion(ID, '--help')).rejects.toThrow(/Not a version id/);
    await expect(checkpoints.restoreVersion(ID, 'abcdef1234')).rejects.toThrow(/not in this project/);
  });
});
