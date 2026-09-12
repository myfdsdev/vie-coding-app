/**
 * The data model of a generated app (BUILD-PROMPT M4): one JSON file per
 * entity in entities/<Name>.json, written by the model, read by everything
 * else.
 *
 * A closed schema is the whole point. Fields come from a fixed list of types
 * and access rules from a fixed list of answers, so both can be checked
 * statically before anything runs — which arbitrary SQL never could. The model
 * never sees a database; it declares what the app stores and who may touch it.
 */

export const FIELD_TYPES = ['string', 'text', 'number', 'boolean', 'date', 'select', 'list', 'ref'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface Field {
  type: FieldType;
  /** Refused on create/update when missing or empty. */
  required?: boolean;
  /** Used when the app creates a row without this field. */
  default?: string | number | boolean | string[];
  /** select: the allowed values. */
  options?: string[];
  /** ref: the entity this points at. */
  entity?: string;
  /** Shown to people in generated UI. */
  label?: string;
}

/**
 * Who may do each thing:
 *   everyone  anyone, even signed out
 *   user      any signed-in user
 *   owner     only the user who created the row (on create: any signed-in user)
 *   nobody    no one through the API
 */
export const ACCESS_LEVELS = ['everyone', 'user', 'owner', 'nobody'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];
export type Action = 'read' | 'create' | 'update' | 'delete';
export const ACTIONS: Action[] = ['read', 'create', 'update', 'delete'];

export interface Entity {
  name: string;
  label?: string;
  fields: Record<string, Field>;
  access: Record<Action, AccessLevel>;
}

/** Private by default: your own rows, visible to no one else. */
export const DEFAULT_ACCESS: Record<Action, AccessLevel> = { read: 'owner', create: 'user', update: 'owner', delete: 'owner' };

/** Columns every row has; an entity may not redefine them. */
export const RESERVED_FIELDS = ['id', 'ownerId', 'createdAt', 'updatedAt'] as const;

const ENTITY_NAME = /^[A-Z][A-Za-z0-9]{0,30}$/;
const FIELD_NAME = /^[a-z][A-Za-z0-9_]{0,30}$/;

export class EntityError extends Error {}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Read an entity file. Throws EntityError with a sentence the model can act
 * on. `filled` lists what was missing and was given a safe default.
 */
export function parseEntity(source: string, fileName?: string): { entity: Entity; filled: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (err) {
    throw new EntityError(`${fileName ?? 'The entity'} is not valid JSON: ${(err as Error).message}`);
  }
  if (!isPlainObject(raw)) throw new EntityError(`${fileName ?? 'An entity'} must be a JSON object with "name", "fields" and "access".`);

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!ENTITY_NAME.test(name)) {
    throw new EntityError(`"${name || 'missing name'}" is not a valid entity name: use a singular name in PascalCase, such as "Task" or "InvoiceLine".`);
  }
  if (!isPlainObject(raw.fields) || Object.keys(raw.fields).length === 0) {
    throw new EntityError(`Entity "${name}" needs a "fields" object with at least one field.`);
  }

  const fields: Record<string, Field> = {};
  for (const [fieldName, value] of Object.entries(raw.fields)) {
    if (!FIELD_NAME.test(fieldName)) {
      throw new EntityError(`"${fieldName}" is not a valid field name in ${name}: use camelCase letters and numbers, starting with a lowercase letter.`);
    }
    if ((RESERVED_FIELDS as readonly string[]).includes(fieldName)) {
      throw new EntityError(`${name}.${fieldName} is added to every row automatically — remove it from the entity's fields.`);
    }
    fields[fieldName] = parseField(name, fieldName, value);
  }

  const filled: string[] = [];
  const access = {} as Record<Action, AccessLevel>;
  const declared = isPlainObject(raw.access) ? raw.access : {};
  if (!isPlainObject(raw.access)) filled.push('access');
  for (const action of ACTIONS) {
    const value = declared[action];
    if (value === undefined) {
      access[action] = DEFAULT_ACCESS[action];
      if (isPlainObject(raw.access)) filled.push(`access.${action}`);
      continue;
    }
    // The spec's true | false, spelled the way the rest of the file reads.
    const level = value === true ? 'everyone' : value === false ? 'nobody' : value;
    if (typeof level !== 'string' || !(ACCESS_LEVELS as readonly string[]).includes(level)) {
      throw new EntityError(`${name}.access.${action} must be one of ${ACCESS_LEVELS.join(', ')} — "${String(value)}" is not.`);
    }
    // Nothing owns a row that does not exist yet.
    access[action] = level === 'owner' && action === 'create' ? 'user' : (level as AccessLevel);
  }

  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : undefined;
  return { entity: { name, label, fields, access }, filled };
}

function parseField(entityName: string, fieldName: string, value: unknown): Field {
  const where = `${entityName}.${fieldName}`;
  // "title": "string" is shorthand for { "type": "string" }.
  const raw = typeof value === 'string' ? { type: value } : value;
  if (!isPlainObject(raw)) throw new EntityError(`${where} must be a type name or an object with a "type".`);
  const type = raw.type;
  if (typeof type !== 'string' || !(FIELD_TYPES as readonly string[]).includes(type)) {
    throw new EntityError(`${where} has type "${String(type)}"; use one of: ${FIELD_TYPES.join(', ')}.`);
  }
  const field: Field = { type: type as FieldType };
  if (raw.required === true) field.required = true;
  if (typeof raw.label === 'string' && raw.label.trim()) field.label = raw.label.trim();

  if (field.type === 'select') {
    const options = raw.options;
    if (!Array.isArray(options) || options.length === 0 || options.some((o) => typeof o !== 'string')) {
      throw new EntityError(`${where} is a select, so it needs "options": a non-empty list of text values.`);
    }
    field.options = options as string[];
  }
  if (field.type === 'ref') {
    const entity = raw.entity;
    if (typeof entity !== 'string' || !ENTITY_NAME.test(entity)) {
      throw new EntityError(`${where} is a ref, so it needs "entity": the name of the entity it points at.`);
    }
    field.entity = entity;
  }
  if (raw.default !== undefined) {
    const check = checkValue(field, raw.default);
    if (!check.ok) throw new EntityError(`${where} has a default that is not a valid ${field.type}: ${check.error}`);
    field.default = check.value as Field['default'];
  }
  return field;
}

/** The file an entity belongs in. */
export function entityPath(name: string): string {
  return `entities/${name}.json`;
}

/** The entity's file content, formatted the way Forge writes it. */
export function serialiseEntity(entity: Entity): string {
  const body = { name: entity.name, ...(entity.label ? { label: entity.label } : {}), fields: entity.fields, access: entity.access };
  return JSON.stringify(body, null, 2) + '\n';
}

type Value = string | number | boolean | string[] | null;

function checkValue(field: Field, value: unknown): { ok: true; value: Value } | { ok: false; error: string } {
  switch (field.type) {
    case 'string':
    case 'text':
    case 'ref':
      return typeof value === 'string' ? { ok: true, value } : { ok: false, error: 'expected text' };
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? { ok: true, value } : { ok: false, error: 'expected a number' };
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false, error: 'expected true or false' };
    case 'date':
      return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? { ok: true, value } : { ok: false, error: 'expected a date as an ISO string' };
    case 'select':
      return typeof value === 'string' && field.options?.includes(value) ? { ok: true, value } : { ok: false, error: `expected one of ${field.options?.join(', ')}` };
    case 'list':
      return Array.isArray(value) && value.every((v) => typeof v === 'string') ? { ok: true, value: value as string[] } : { ok: false, error: 'expected a list of text values' };
  }
}

/** How long a text value may be; the app database is not a file store. */
const MAX_TEXT: Partial<Record<FieldType, number>> = { string: 2_000, text: 100_000, ref: 200 };

/**
 * Check one row against the entity before it is stored. Unknown fields are
 * refused rather than ignored, so a typo in the app surfaces immediately.
 */
export function validateRow(
  entity: Entity,
  input: unknown,
  opts: { partial?: boolean } = {},
): { ok: true; data: Record<string, Value> } | { ok: false; error: string } {
  if (!isPlainObject(input)) return { ok: false, error: 'Expected an object of fields.' };
  const data: Record<string, Value> = {};
  for (const [name, value] of Object.entries(input)) {
    if ((RESERVED_FIELDS as readonly string[]).includes(name)) continue; // set by the server, never by the app
    const field = entity.fields[name];
    if (!field) return { ok: false, error: `${entity.name} has no field "${name}".` };
    if (value === null || value === undefined) {
      if (field.required) return { ok: false, error: `${name} is required.` };
      data[name] = null;
      continue;
    }
    const check = checkValue(field, value);
    if (!check.ok) return { ok: false, error: `${name}: ${check.error}.` };
    const limit = MAX_TEXT[field.type];
    if (limit && typeof check.value === 'string' && check.value.length > limit) return { ok: false, error: `${name} is longer than ${limit} characters.` };
    if (field.type === 'list' && Array.isArray(check.value) && check.value.join('').length > 10_000) return { ok: false, error: `${name} is too long.` };
    data[name] = check.value;
  }
  if (!opts.partial) {
    for (const [name, field] of Object.entries(entity.fields)) {
      if (data[name] !== undefined && data[name] !== null) continue;
      if (field.default !== undefined) data[name] = field.default as Value;
      else if (field.required) return { ok: false, error: `${name} is required.` };
      else data[name] = null;
    }
  }
  return { ok: true, data };
}

/** The TypeScript type of a field, for the generated client. */
export function tsType(field: Field): string {
  switch (field.type) {
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'list':
      return 'string[]';
    case 'select':
      return field.options?.map((o) => JSON.stringify(o)).join(' | ') ?? 'string';
    default:
      return 'string';
  }
}

/** One plain sentence per entity, for the user and for the publish gate. */
export function describeAccess(entity: Entity): string {
  const say: Record<AccessLevel, string> = {
    everyone: 'anyone, even signed out',
    user: 'any signed-in user',
    owner: 'only the person who created it',
    nobody: 'no one',
  };
  return ACTIONS.map((a) => `${a}: ${say[entity.access[a]]}`).join(' · ');
}
