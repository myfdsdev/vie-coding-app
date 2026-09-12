import { randomUUID } from 'node:crypto';
import { appDb } from './db';
import { validateRow, type Action, type Entity } from './entities';

/**
 * Row storage for generated apps (BUILD-PROMPT M4), with the access rules
 * enforced here and nowhere else. The browser is never trusted: the app's code
 * asks for rows, this decides which rows it may have.
 *
 * Every query is built from the entity's own field list — never from a string
 * the app or the model supplied — so there is no place for SQL to be injected.
 */

export interface AppUser {
  id: string;
  email: string;
}

/** Whoever is asking: a signed-in app user, or nobody. */
export type Caller = AppUser | null;

export interface Row {
  id: string;
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
  [field: string]: unknown;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const OPERATORS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'in'] as const;
export type Operator = (typeof OPERATORS)[number];

export type Condition = string | number | boolean | null | { op: Operator; value: unknown };

export interface Query {
  where?: Record<string, Condition>;
  /** "title" or "-createdAt" (descending). */
  sort?: string;
  limit?: number;
  /** From a previous result; opaque to the app. */
  cursor?: string;
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/** Row columns the app may sort and filter on besides its own fields. */
const BUILT_IN = { id: 'id', ownerId: 'owner_id', createdAt: 'created_at', updatedAt: 'updated_at' } as const;

/** Whether this caller may act at all, before any row is touched. */
function allowed(entity: Entity, action: Action, caller: Caller): boolean {
  const level = entity.access[action];
  if (level === 'nobody') return false;
  if (level === 'everyone') return true;
  return caller !== null; // 'user' and 'owner' both need a signed-in user
}

function deny(entity: Entity, action: Action, caller: Caller): never {
  if (!caller && entity.access[action] !== 'nobody') throw new ApiError(401, `You need to sign in to ${action} ${entity.name}.`);
  throw new ApiError(403, `This app does not allow anyone to ${action} ${entity.name}.`);
}

/** SQL for "rows this caller may read/change", from the entity's own rules. */
function ownerClause(entity: Entity, action: Action, caller: Caller): { sql: string; params: unknown[] } {
  if (entity.access[action] === 'owner') return { sql: ' AND owner_id = ?', params: [caller?.id ?? ''] };
  return { sql: '', params: [] };
}

interface StoredRow {
  id: string;
  owner_id: string | null;
  data: string;
  created_at: number;
  updated_at: number;
}

function toRow(r: StoredRow): Row {
  return {
    ...(JSON.parse(r.data) as Record<string, unknown>),
    id: r.id,
    ownerId: r.owner_id,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

/** A field the app may filter or sort on, as SQL. Anything else is refused. */
function column(entity: Entity, field: string): { sql: string; params: unknown[] } {
  const builtIn = BUILT_IN[field as keyof typeof BUILT_IN];
  if (builtIn) return { sql: builtIn, params: [] };
  if (!entity.fields[field]) throw new ApiError(400, `${entity.name} has no field "${field}".`);
  return { sql: 'json_extract(data, ?)', params: [`$.${field}`] };
}

/** SQLite stores JSON booleans as 1/0; everything else compares as it is. */
function bind(value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === null || typeof value === 'string' || typeof value === 'number') return value;
  throw new ApiError(400, 'Filters take text, numbers, true/false or null.');
}

function condition(entity: Entity, field: string, cond: Condition): { sql: string; params: unknown[] } {
  const col = column(entity, field);
  const isObject = typeof cond === 'object' && cond !== null && !Array.isArray(cond);
  const op: Operator = isObject ? (cond as { op: Operator }).op : 'eq';
  const value = isObject ? (cond as { value: unknown }).value : cond;
  if (!OPERATORS.includes(op)) throw new ApiError(400, `"${String(op)}" is not a filter Forge supports.`);

  if (op === 'in') {
    const list = Array.isArray(value) ? value.slice(0, 50) : [];
    if (!list.length) return { sql: '0', params: [] };
    return { sql: `${col.sql} IN (${list.map(() => '?').join(', ')})`, params: [...col.params, ...list.map(bind)] };
  }
  if (op === 'contains') {
    return { sql: `LOWER(${col.sql}) LIKE ?`, params: [...col.params, `%${String(value).toLowerCase().replace(/[%_]/g, ' ')}%`] };
  }
  if (value === null) return { sql: `${col.sql} IS ${op === 'ne' ? 'NOT ' : ''}NULL`, params: col.params };
  const sql = { eq: '=', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
  return { sql: `${col.sql} ${sql} ?`, params: [...col.params, bind(value)] };
}

function orderBy(entity: Entity, sort: string | undefined): { sql: string; params: unknown[] } {
  if (!sort) return { sql: 'created_at DESC', params: [] };
  const desc = sort.startsWith('-');
  const col = column(entity, desc ? sort.slice(1) : sort);
  return { sql: `${col.sql} ${desc ? 'DESC' : 'ASC'}, created_at DESC`, params: col.params };
}

export function listRows(projectId: string, entity: Entity, caller: Caller, query: Query = {}): { rows: Row[]; nextCursor?: string } {
  if (!allowed(entity, 'read', caller)) deny(entity, 'read', caller);
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const offset = Math.max(0, Number.parseInt(query.cursor ?? '0', 10) || 0);
  const scope = ownerClause(entity, 'read', caller);
  const params: unknown[] = [entity.name, ...scope.params];
  let sql = `SELECT id, owner_id, data, created_at, updated_at FROM rows_ WHERE entity = ?${scope.sql}`;
  for (const [field, cond] of Object.entries(query.where ?? {})) {
    const c = condition(entity, field, cond);
    sql += ` AND ${c.sql}`;
    params.push(...c.params);
  }
  const order = orderBy(entity, query.sort);
  sql += ` ORDER BY ${order.sql} LIMIT ? OFFSET ?`;
  params.push(...order.params, limit + 1, offset);
  const found = appDb(projectId).prepare(sql).all(...(params as never[])) as StoredRow[];
  const rows = found.slice(0, limit).map(toRow);
  return { rows, nextCursor: found.length > limit ? String(offset + limit) : undefined };
}

export function getRow(projectId: string, entity: Entity, caller: Caller, id: string): Row {
  if (!allowed(entity, 'read', caller)) deny(entity, 'read', caller);
  const scope = ownerClause(entity, 'read', caller);
  const found = appDb(projectId)
    .prepare(`SELECT id, owner_id, data, created_at, updated_at FROM rows_ WHERE entity = ? AND id = ?${scope.sql}`)
    .get(entity.name, id, ...(scope.params as never[])) as StoredRow | undefined;
  // "Not yours" and "not there" answer the same, so a list of ids tells no one anything.
  if (!found) throw new ApiError(404, `That ${entity.name} does not exist.`);
  return toRow(found);
}

export function createRow(projectId: string, entity: Entity, caller: Caller, input: unknown): Row {
  if (!allowed(entity, 'create', caller)) deny(entity, 'create', caller);
  const checked = validateRow(entity, input);
  if (!checked.ok) throw new ApiError(400, checked.error);
  const now = Date.now();
  const row: StoredRow = {
    id: randomUUID(),
    owner_id: caller?.id ?? null,
    data: JSON.stringify(checked.data),
    created_at: now,
    updated_at: now,
  };
  appDb(projectId)
    .prepare('INSERT INTO rows_ (entity, id, owner_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(entity.name, row.id, row.owner_id, row.data, row.created_at, row.updated_at);
  return toRow(row);
}

export function updateRow(projectId: string, entity: Entity, caller: Caller, id: string, input: unknown): Row {
  if (!allowed(entity, 'update', caller)) deny(entity, 'update', caller);
  const checked = validateRow(entity, input, { partial: true });
  if (!checked.ok) throw new ApiError(400, checked.error);
  const db = appDb(projectId);
  const scope = ownerClause(entity, 'update', caller);
  const current = db
    .prepare(`SELECT id, owner_id, data, created_at, updated_at FROM rows_ WHERE entity = ? AND id = ?${scope.sql}`)
    .get(entity.name, id, ...(scope.params as never[])) as StoredRow | undefined;
  if (!current) throw new ApiError(404, `That ${entity.name} does not exist.`);
  const merged = { ...(JSON.parse(current.data) as Record<string, unknown>), ...checked.data };
  const updatedAt = Date.now();
  db.prepare('UPDATE rows_ SET data = ?, updated_at = ? WHERE entity = ? AND id = ?').run(JSON.stringify(merged), updatedAt, entity.name, id);
  return toRow({ ...current, data: JSON.stringify(merged), updated_at: updatedAt });
}

export function deleteRow(projectId: string, entity: Entity, caller: Caller, id: string): void {
  if (!allowed(entity, 'delete', caller)) deny(entity, 'delete', caller);
  const scope = ownerClause(entity, 'delete', caller);
  const result = appDb(projectId)
    .prepare(`DELETE FROM rows_ WHERE entity = ? AND id = ?${scope.sql}`)
    .run(entity.name, id, ...(scope.params as never[]));
  if (result.changes === 0) throw new ApiError(404, `That ${entity.name} does not exist.`);
}

/** How many rows each entity holds, for the builder's data panel. */
export function rowCounts(projectId: string): Record<string, number> {
  const rows = appDb(projectId).prepare('SELECT entity, COUNT(*) AS n FROM rows_ GROUP BY entity').all() as { entity: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.entity, r.n]));
}
