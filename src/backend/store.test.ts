import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEntity, type Entity } from './entities';
import type { ApiError as ApiErrorClass, AppUser } from './store';

/**
 * Access rules (BUILD-PROMPT M4). The acceptance for the milestone lives
 * here: one user's rows are not readable by another, and the app cannot ask
 * its way around it.
 */

const saved = process.env.FORGE_DATA_DIR;
let tmp = '';
let store: typeof import('./store');
let ApiError: typeof ApiErrorClass;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-store-'));
  process.env.FORGE_DATA_DIR = tmp;
  store = await import('./store');
  ApiError = store.ApiError;
});

afterAll(async () => {
  (await import('./db')).closeAppDbs();
  if (saved === undefined) delete process.env.FORGE_DATA_DIR;
  else process.env.FORGE_DATA_DIR = saved;
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
});

const entity = (access: Record<string, string> = {}): Entity =>
  parseEntity(
    JSON.stringify({
      name: 'Task',
      fields: { title: { type: 'string', required: true }, done: { type: 'boolean', default: false }, rank: { type: 'number' } },
      access: { read: 'owner', create: 'user', update: 'owner', delete: 'owner', ...access },
    }),
  ).entity;

const alice: AppUser = { id: 'u_alice', email: 'alice@example.com' };
const bob: AppUser = { id: 'u_bob', email: 'bob@example.com' };

describe('rows and access rules', () => {
  it('keeps one user’s rows away from another, however they ask', () => {
    const task = entity();
    const mine = store.createRow('isolate1', task, alice, { title: 'Alice plan' });
    store.createRow('isolate1', task, bob, { title: 'Bob plan' });

    // Each sees exactly their own.
    expect(store.listRows('isolate1', task, alice, {}).rows.map((r) => r.title)).toEqual(['Alice plan']);
    expect(store.listRows('isolate1', task, bob, {}).rows.map((r) => r.title)).toEqual(['Bob plan']);
    // Asking for the other's row by id, filtering by owner, or writing to it: all refused.
    expect(() => store.getRow('isolate1', task, bob, mine.id)).toThrow(/does not exist/);
    expect(store.listRows('isolate1', task, bob, { where: { ownerId: alice.id } }).rows).toEqual([]);
    expect(() => store.updateRow('isolate1', task, bob, mine.id, { title: 'stolen' })).toThrow(/does not exist/);
    expect(() => store.deleteRow('isolate1', task, bob, mine.id)).toThrow(/does not exist/);
    // And the row is untouched.
    expect(store.getRow('isolate1', task, alice, mine.id).title).toBe('Alice plan');
  });

  it('refuses a signed-out caller, with 401 rather than 403', () => {
    const task = entity();
    expect(() => store.listRows('signedout1', task, null, {})).toThrow(expect.objectContaining({ status: 401 }) as Error);
    expect(() => store.createRow('signedout1', task, null, { title: 'x' })).toThrow(expect.objectContaining({ status: 401 }) as Error);
  });

  it('honours read: everyone and delete: nobody', () => {
    const open = entity({ read: 'everyone', delete: 'nobody' });
    const row = store.createRow('public1', open, alice, { title: 'Notice' });
    expect(store.listRows('public1', open, null, {}).rows.map((r) => r.title)).toEqual(['Notice']);
    expect(store.getRow('public1', open, bob, row.id).title).toBe('Notice');
    const denied = (() => {
      try {
        store.deleteRow('public1', open, alice, row.id);
      } catch (err) {
        return err as InstanceType<typeof ApiError>;
      }
    })();
    expect(denied?.status).toBe(403);
  });

  it('lets any signed-in user read when read: user, while owners still control changes', () => {
    const shared = entity({ read: 'user' });
    const row = store.createRow('shared1', shared, alice, { title: 'Team note' });
    expect(store.getRow('shared1', shared, bob, row.id).title).toBe('Team note');
    expect(() => store.updateRow('shared1', shared, bob, row.id, { title: 'edited' })).toThrow(/does not exist/);
    expect(store.updateRow('shared1', shared, alice, row.id, { done: true }).done).toBe(true);
  });

  it('stamps ownership and timestamps itself, ignoring whatever the app sends', () => {
    const task = entity();
    const row = store.createRow('stamp1', task, alice, { title: 'Mine', ownerId: bob.id, id: 'chosen', createdAt: '2000-01-01' });
    expect(row.ownerId).toBe(alice.id);
    expect(row.id).not.toBe('chosen');
    expect(Date.parse(row.createdAt)).toBeGreaterThan(Date.now() - 10_000);
  });

  it('applies defaults, requires required fields and refuses unknown ones', () => {
    const task = entity();
    expect(store.createRow('fields1', task, alice, { title: 'With defaults' }).done).toBe(false);
    expect(() => store.createRow('fields1', task, alice, { done: true })).toThrow(/title is required/);
    expect(() => store.createRow('fields1', task, alice, { title: 'x', colour: 'red' })).toThrow(/has no field "colour"/);
    expect(() => store.createRow('fields1', task, alice, { title: 'x', rank: 'high' })).toThrow(/rank: expected a number/);
  });

  it('filters, sorts and pages through the closed set of operators', () => {
    const task = entity();
    for (const [i, title] of ['alpha', 'beta', 'gamma'].entries()) store.createRow('query1', task, alice, { title, rank: i });
    const done = store.createRow('query1', task, alice, { title: 'delta', done: true, rank: 9 });

    expect(store.listRows('query1', task, alice, { where: { done: true } }).rows.map((r) => r.id)).toEqual([done.id]);
    expect(store.listRows('query1', task, alice, { where: { rank: { op: 'gte', value: 2 } }, sort: 'rank' }).rows.map((r) => r.title)).toEqual(['gamma', 'delta']);
    expect(store.listRows('query1', task, alice, { where: { title: { op: 'contains', value: 'ET' } } }).rows.map((r) => r.title)).toEqual(['beta']);
    expect(store.listRows('query1', task, alice, { sort: 'title', limit: 2 }).rows.map((r) => r.title)).toEqual(['alpha', 'beta']);
    const page = store.listRows('query1', task, alice, { sort: 'title', limit: 2 });
    expect(page.nextCursor).toBeDefined();
    expect(store.listRows('query1', task, alice, { sort: 'title', limit: 2, cursor: page.nextCursor }).rows.map((r) => r.title)).toEqual(['delta', 'gamma']);
  });

  it('refuses a filter on a field the entity does not have', () => {
    const task = entity();
    expect(() => store.listRows('query2', task, alice, { where: { secretColumn: 'x' } })).toThrow(/has no field "secretColumn"/);
    expect(() => store.listRows('query2', task, alice, { sort: "title'; DROP TABLE rows_;--" })).toThrow(/has no field/);
  });

  it('counts rows per entity for the builder panel', () => {
    const task = entity();
    store.createRow('counts1', task, alice, { title: 'one' });
    store.createRow('counts1', task, bob, { title: 'two' });
    expect(store.rowCounts('counts1')).toEqual({ Task: 2 });
  });
});
