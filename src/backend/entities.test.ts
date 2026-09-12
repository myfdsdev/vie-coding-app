import { describe, expect, it } from 'vitest';
import { DEFAULT_ACCESS, EntityError, parseEntity, serialiseEntity, validateRow } from './entities';

const entity = (body: Record<string, unknown>) => parseEntity(JSON.stringify(body));

describe('parseEntity', () => {
  it('reads fields and rules, and accepts the short form for a plain field', () => {
    const { entity: task } = entity({
      name: 'Task',
      fields: { title: 'string', done: { type: 'boolean', default: false }, status: { type: 'select', options: ['todo', 'done'] } },
      access: { read: 'user', create: 'user', update: 'owner', delete: 'nobody' },
    });
    expect(task.fields.title).toEqual({ type: 'string' });
    expect(task.fields.done).toEqual({ type: 'boolean', default: false });
    expect(task.access).toEqual({ read: 'user', create: 'user', update: 'owner', delete: 'nobody' });
  });

  it('fills missing rules with private-by-default and says which', () => {
    const { entity: note, filled } = entity({ name: 'Note', fields: { body: 'text' } });
    expect(note.access).toEqual(DEFAULT_ACCESS);
    expect(filled).toEqual(['access']);
    const partial = entity({ name: 'Note', fields: { body: 'text' }, access: { read: 'everyone' } });
    expect(partial.entity.access).toEqual({ ...DEFAULT_ACCESS, read: 'everyone' });
    expect(partial.filled).toEqual(['access.create', 'access.update', 'access.delete']);
  });

  it('accepts the spec’s true and false as rules, and never lets create mean owner', () => {
    const { entity: post } = entity({ name: 'Post', fields: { body: 'text' }, access: { read: true, delete: false, create: 'owner' } });
    expect(post.access).toMatchObject({ read: 'everyone', delete: 'nobody', create: 'user' });
  });

  it('explains what is wrong in a sentence the model can act on', () => {
    expect(() => entity({ name: 'task', fields: { a: 'string' } })).toThrow(/PascalCase/);
    expect(() => entity({ name: 'Task' })).toThrow(/needs a "fields" object/);
    expect(() => entity({ name: 'Task', fields: { title: 'str' } })).toThrow(/use one of: string, text, number/);
    expect(() => entity({ name: 'Task', fields: { id: 'string' } })).toThrow(/added to every row automatically/);
    expect(() => entity({ name: 'Task', fields: { Title: 'string' } })).toThrow(/camelCase/);
    expect(() => entity({ name: 'Task', fields: { s: { type: 'select' } } })).toThrow(/needs "options"/);
    expect(() => entity({ name: 'Task', fields: { a: 'string' }, access: { read: 'maybe' } })).toThrow(/must be one of everyone, user, owner, nobody/);
    expect(() => parseEntity('{oops', 'entities/Task.json')).toThrow(EntityError);
  });

  it('round-trips through the canonical file form', () => {
    const { entity: task } = entity({ name: 'Task', label: 'Tasks', fields: { title: { type: 'string', required: true } } });
    const text = serialiseEntity(task);
    expect(JSON.parse(text)).toEqual({
      name: 'Task',
      label: 'Tasks',
      fields: { title: { type: 'string', required: true } },
      access: DEFAULT_ACCESS,
    });
    expect(parseEntity(text).entity).toEqual(task);
    expect(serialiseEntity(parseEntity(text).entity)).toBe(text);
  });
});

describe('validateRow', () => {
  const { entity: task } = entity({
    name: 'Task',
    fields: {
      title: { type: 'string', required: true },
      done: { type: 'boolean', default: false },
      due: 'date',
      tags: 'list',
      priority: { type: 'select', options: ['low', 'high'] },
    },
  });

  it('fills defaults and nulls, and checks each type', () => {
    expect(validateRow(task, { title: 'Write it down' })).toEqual({ ok: true, data: { title: 'Write it down', done: false, due: null, tags: null, priority: null } });
    expect(validateRow(task, { title: 'x', due: 'yesterday' })).toEqual({ ok: false, error: 'due: expected a date as an ISO string.' });
    expect(validateRow(task, { title: 'x', priority: 'urgent' })).toEqual({ ok: false, error: 'priority: expected one of low, high.' });
    expect(validateRow(task, { title: 'x', tags: ['a', 'b'] })).toMatchObject({ ok: true });
  });

  it('leaves out untouched fields when updating', () => {
    expect(validateRow(task, { done: true }, { partial: true })).toEqual({ ok: true, data: { done: true } });
  });
});
