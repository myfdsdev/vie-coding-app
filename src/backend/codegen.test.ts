import { describe, expect, it } from 'vitest';
import { AUTH_FILE, DATA_FILE, generateAuth, generateClient, generateData } from './codegen';
import { parseEntity } from './entities';

const task = parseEntity(
  JSON.stringify({
    name: 'Task',
    fields: {
      title: { type: 'string', required: true },
      done: { type: 'boolean', default: false },
      priority: { type: 'select', options: ['low', 'high'] },
      tags: 'list',
    },
    access: { read: 'owner', create: 'user', update: 'owner', delete: 'owner' },
  }),
).entity;

const note = parseEntity(JSON.stringify({ name: 'Note', fields: { body: 'text' }, access: { read: 'everyone' } })).entity;

describe('generated data client', () => {
  const code = generateData([note, task]);

  it('types every row and its input from the entity', () => {
    expect(code).toContain('export interface Task {');
    expect(code).toContain('  title: string;');
    expect(code).toContain('  done: boolean | null;');
    expect(code).toContain('  priority: "low" | "high" | null;');
    expect(code).toContain('  tags: string[] | null;');
    expect(code).toContain('export interface TaskInput {');
    expect(code).toContain('  title: string;');
    expect(code).toContain('  done?: boolean | null;');
    expect(code).toContain("export const Task = collection<Task, TaskInput>('Task');");
  });

  it('says who may do what, so the file explains itself', () => {
    expect(code).toContain('read — the owner only');
    expect(code).toContain('read — anyone');
  });

  it('talks to the app’s own origin and nothing else', () => {
    expect(code).toContain("const BASE = '/_forge/data'");
    expect(code).toContain("credentials: 'same-origin'");
    expect(code).not.toMatch(/https?:\/\//);
  });

  it('is stable: the same entities produce the same file, in name order', () => {
    expect(generateData([task, note])).toBe(code);
    expect(code.indexOf('interface Note')).toBeLessThan(code.indexOf('interface Task'));
  });
});

describe('generated sign-in', () => {
  const code = generateAuth();

  it('gives the app a user hook, a form and a guard', () => {
    for (const api of ['export function useUser(', 'export function SignIn(', 'export function RequireSignIn(', 'export async function signOut(']) {
      expect(code).toContain(api);
    }
    expect(code).toContain("const BASE = '/_forge/auth'");
  });

  it('shows the code in the form only when the server sends one', () => {
    expect(code).toContain("res.code ? 'Preview mode — your code is ' + res.code : 'Check your email for the code.'");
  });
});

describe('generateClient', () => {
  it('writes both files for a project with a data model, and nothing for one without', () => {
    expect(generateClient([task]).map((f) => f.path)).toEqual([DATA_FILE, AUTH_FILE]);
    expect(generateClient([])).toEqual([]);
  });
});
