import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureWorkspace, listProjectFiles, newProjectId, safeRelativePath, workspaceDir } from './projects';

const created: string[] = [];
afterAll(async () => {
  for (const id of created) await fs.rm(workspaceDir(id), { recursive: true, force: true });
});

describe('ensureWorkspace', () => {
  it('survives concurrent callers and creates the template exactly once', async () => {
    const id = newProjectId();
    created.push(id);
    const results = await Promise.all([ensureWorkspace(id), ensureWorkspace(id), ensureWorkspace(id)]);
    expect(results.every((r) => r.created)).toBe(true); // one shared creation
    expect((await ensureWorkspace(id)).created).toBe(false);
    const files = await listProjectFiles(id);
    expect(files).toContain('package.json');
    expect(files).toContain('src/main.tsx');
    expect(files.some((f) => f.startsWith('node_modules/'))).toBe(false);
    const leftovers = (await fs.readdir(path.dirname(workspaceDir(id)))).filter((n) => n.startsWith(`${id}.init-`));
    expect(leftovers).toEqual([]);
  });
});

describe('safeRelativePath', () => {
  it('normalises harmless paths', () => {
    expect(safeRelativePath('./src/App.tsx')).toBe('src/App.tsx');
    expect(safeRelativePath('src\\pages\\Home.tsx')).toBe('src/pages/Home.tsx');
  });

  it('rejects paths that escape or touch managed folders', () => {
    for (const bad of ['../secrets.txt', '/etc/passwd', 'C:/Windows/x', 'src/../../x', 'node_modules/react/index.js', '.git/config', '']) {
      expect(() => safeRelativePath(bad)).toThrow();
    }
  });
});

describe('newProjectId', () => {
  it('is a valid preview-hostname label', () => {
    for (let i = 0; i < 50; i++) expect(newProjectId()).toMatch(/^[a-z][a-z0-9]{9}$/);
  });
});
