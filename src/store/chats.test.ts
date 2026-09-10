import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** A throwaway database and workspaces folder; the modules read both locations when loaded. */

let chats: typeof import('./chats');
let projects: typeof import('./projects');
let database: typeof import('./db');
let tmp = '';
const saved = { FORGE_DATA_DIR: process.env.FORGE_DATA_DIR, FORGE_WORKSPACES_DIR: process.env.FORGE_WORKSPACES_DIR };

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-db-'));
  process.env.FORGE_DATA_DIR = tmp;
  process.env.FORGE_WORKSPACES_DIR = path.join(tmp, 'ws');
  database = await import('./db');
  projects = await import('./projects');
  chats = await import('./chats');
});

afterAll(async () => {
  database.closeDb();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
});

describe('project records', () => {
  it('creates, names and lists projects, most recent first', async () => {
    const created = await projects.createProject('recipe-box');
    expect(created.name).toBe('recipe-box');
    expect(projects.ensureProject('legacyproj1').name).toBe('legacyproj1');
    projects.touchProject('legacyproj1', 'lead-tracker');
    expect(projects.getProject('legacyproj1')?.name).toBe('lead-tracker');
    projects.touchProject('legacyproj1', 'another-name');
    expect(projects.getProject('legacyproj1')?.name).toBe('lead-tracker'); // a named project keeps its name
    expect(projects.listProjects().map((p) => p.id)).toEqual(['legacyproj1', created.id]);
  });

  it('derives a short name from the first request', () => {
    expect(projects.projectNameFrom('Build me a recipe box with cook times!')).toBe('recipe-box-cook');
    expect(projects.projectNameFrom('???')).toBe('untitled');
  });
});

describe('chats', () => {
  it('keeps messages and model history in order', () => {
    projects.ensureProject('chatproj1');
    chats.appendMessages('chatproj1', [{ id: 'u1', role: 'user', text: 'hi' }]);
    chats.appendMessages('chatproj1', [{ id: 'u2', role: 'user', text: 'again' }]);
    expect(chats.listMessages('chatproj1').map((m) => m.id)).toEqual(['u1', 'u2']);
    chats.appendHistory('chatproj1', [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    expect(chats.getHistory('chatproj1')).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('hands a pending note to the next turn exactly once', () => {
    projects.ensureProject('chatproj1');
    chats.addPendingNote('chatproj1', 'Restored v1.');
    chats.addPendingNote('chatproj1', 'Restored v2.');
    expect(chats.takePendingNote('chatproj1')).toBe('Restored v1.\nRestored v2.');
    expect(chats.takePendingNote('chatproj1')).toBeNull();
  });
});
