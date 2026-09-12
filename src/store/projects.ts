import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { db } from './db';

/**
 * Project file store. The workspace folder on the host is the source of truth
 * for a project's code; sandboxes receive copies of it.
 *
 * M0 has no database: a project is just workspaces/<id>/.
 */

// FORGE_WORKSPACES_DIR lets tests (or a deployment) keep projects elsewhere.
export const WORKSPACES_DIR = process.env.FORGE_WORKSPACES_DIR || path.join(process.cwd(), 'workspaces');
export const TEMPLATE_DIR = path.join(process.cwd(), 'docker', 'template');

/** Lowercase alphanumeric only — it becomes part of the preview hostname sbx-<id>. */
const PROJECT_ID_RE = /^[a-z0-9]{4,32}$/;

/** Never copied into a workspace, listed, or sent to the model or sandbox. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.vite']);

/**
 * Infrastructure the builder relies on. The model may not overwrite these:
 * the preview shim and error boundary are how failures get reported at all.
 */
export const PROTECTED_PATHS = new Set([
  'vite.config.ts',
  'vite-plugin-preview-instrumentation.ts',
  'src/ErrorBoundary.tsx',
  'package-lock.json',
]);

/** Folders Forge generates and keeps in step with the data model (M4). */
const PROTECTED_DIRS = ['src/forge/'];

/** Whether the model may write this path. It may read all of them. */
export function isProtectedPath(rel: string): boolean {
  return PROTECTED_PATHS.has(rel) || PROTECTED_DIRS.some((dir) => rel.startsWith(dir));
}

export function newProjectId(): string {
  // 10 base-36 characters; the first is a letter so ids never look numeric.
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const rest = BigInt('0x' + randomBytes(8).toString('hex')).toString(36).padStart(9, '0').slice(-9);
  return letters[randomBytes(1)[0] % 26] + rest;
}

export function isProjectId(id: string): boolean {
  return PROJECT_ID_RE.test(id);
}

export function assertProjectId(id: string): string {
  if (!isProjectId(id)) throw new Error(`Invalid project id: ${JSON.stringify(id)}`);
  return id;
}

export function workspaceDir(projectId: string): string {
  return path.join(WORKSPACES_DIR, assertProjectId(projectId));
}

/**
 * Normalise a model-supplied path to a safe, project-relative POSIX path.
 * Throws on anything that could escape the workspace or touch managed folders.
 */
export function safeRelativePath(input: string): string {
  const cleaned = input.trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!cleaned) throw new Error('Empty file path');
  if (cleaned.startsWith('/') || /^[a-zA-Z]:/.test(cleaned)) throw new Error(`Absolute path not allowed: ${input}`);
  const normalised = path.posix.normalize(cleaned);
  if (normalised === '.' || normalised.startsWith('../') || normalised === '..') {
    throw new Error(`Path escapes the project: ${input}`);
  }
  const first = normalised.split('/')[0];
  if (SKIP_DIRS.has(first)) throw new Error(`Writing into ${first}/ is not allowed: ${input}`);
  return normalised;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// Concurrent callers (page warm-up, React StrictMode's double effect, the first
// chat turn) must share one copy: two fs.cp runs into the same folder collide
// on Windows with EBUSY. Kept on globalThis so every module copy shares it.
const g = globalThis as typeof globalThis & { __forgeWorkspaceInit?: Map<string, Promise<{ created: boolean }>> };
const workspaceInit = (g.__forgeWorkspaceInit ??= new Map());

/** Create workspaces/<id> from the starter template if it does not exist yet. */
export function ensureWorkspace(projectId: string): Promise<{ created: boolean }> {
  const inflight = workspaceInit.get(projectId);
  if (inflight) return inflight;
  const task = createWorkspace(projectId).finally(() => workspaceInit.delete(projectId));
  workspaceInit.set(projectId, task);
  return task;
}

async function createWorkspace(projectId: string): Promise<{ created: boolean }> {
  const dir = workspaceDir(projectId);
  if (await exists(path.join(dir, 'package.json'))) return { created: false };
  const copyTemplate = (to: string) =>
    fs.cp(TEMPLATE_DIR, to, { recursive: true, filter: (src) => !SKIP_DIRS.has(path.basename(src)) });

  // Copy into a private folder, then rename into place, so a half-copied
  // workspace is never visible under its real name.
  const staging = `${dir}.init-${process.pid}-${Date.now()}`;
  await copyTemplate(staging);
  try {
    await fs.rename(staging, dir);
  } catch {
    // The folder already exists (e.g. left partial by a crash): fill it in place.
    await fs.rm(staging, { recursive: true, force: true });
    await copyTemplate(dir);
  }
  return { created: true };
}

export async function projectExists(projectId: string): Promise<boolean> {
  return isProjectId(projectId) && exists(path.join(workspaceDir(projectId), 'package.json'));
}

/** All project files as sorted, project-relative POSIX paths. */
export async function listProjectFiles(projectId: string): Promise<string[]> {
  const root = workspaceDir(projectId);
  const out: string[] = [];
  async function walk(dir: string, rel: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
      } else if (entry.isFile()) {
        out.push(rel ? `${rel}/${entry.name}` : entry.name);
      }
    }
  }
  await walk(root, '');
  // Deterministic order matters: context assembly depends on it for cache hits.
  return out.sort();
}

export async function readProjectFile(projectId: string, rel: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(workspaceDir(projectId), safeRelativePath(rel)), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Every project file with its content, sorted by path. */
export async function readProjectFiles(projectId: string): Promise<{ path: string; content: string }[]> {
  const paths = await listProjectFiles(projectId);
  return Promise.all(
    paths.map(async (p) => ({ path: p, content: await fs.readFile(path.join(workspaceDir(projectId), p), 'utf8') })),
  );
}

export async function writeProjectFile(projectId: string, rel: string, content: string): Promise<void> {
  const target = path.join(workspaceDir(projectId), safeRelativePath(rel));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

export async function deleteProjectFile(projectId: string, rel: string): Promise<boolean> {
  try {
    await fs.unlink(path.join(workspaceDir(projectId), safeRelativePath(rel)));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export async function renameProjectFile(projectId: string, from: string, to: string): Promise<void> {
  const root = workspaceDir(projectId);
  const target = path.join(root, safeRelativePath(to));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rename(path.join(root, safeRelativePath(from)), target);
}

// ---------------------------------------------------------------------------
// Project records (database). The workspace folder holds the code; the row
// holds what the project list needs.
// ---------------------------------------------------------------------------

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

type ProjectRow = { id: string; name: string; created_at: number; updated_at: number };

const toProject = (r: ProjectRow): Project => ({ id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at });

const NAME_STOP_WORDS = new Set(
  'a an the me my our your i we you to for of and or with that this app application build make create please can could would want need simple small little tool website site page which where who will so it in on some just'.split(
    ' ',
  ),
);

/** "Build me a recipe box with cook times!" -> "recipe-box-cook" */
export function projectNameFrom(prompt: string): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !NAME_STOP_WORDS.has(w))
    .slice(0, 3);
  return words.join('-') || 'untitled';
}

/** A new project: its workspace from the template and its row. */
export async function createProject(name = 'untitled'): Promise<Project> {
  const id = newProjectId();
  await ensureWorkspace(id);
  return ensureProject(id, name);
}

/** The project's row, created on first sight (workspaces from before M1 have none). */
export function ensureProject(id: string, name?: string): Project {
  assertProjectId(id);
  const now = Date.now();
  const conn = db();
  conn
    .prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
    .run(id, name ?? id, now, now);
  return toProject(conn.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow);
}

export function getProject(id: string): Project | null {
  if (!isProjectId(id)) return null;
  const row = db().prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  return row ? toProject(row) : null;
}

/** Most recently active first. */
export function listProjects(limit = 24): Project[] {
  const rows = db().prepare('SELECT * FROM projects ORDER BY updated_at DESC, rowid DESC LIMIT ?').all(limit) as ProjectRow[];
  return rows.map(toProject);
}

/** Record activity. A project still named after its id (or "untitled") takes `name`. */
/**
 * Remove a project for good: its code, its chat, its versions and its
 * ledger rows. The caller deals with the sandbox and the app database.
 * There is no undo, which is why the button asks twice.
 */
export async function deleteProject(id: string): Promise<void> {
  assertProjectId(id);
  await fs.rm(workspaceDir(id), { recursive: true, force: true, maxRetries: 3 });
  const conn = db();
  conn.transaction(() => {
    conn.prepare('DELETE FROM ledger WHERE project_id = ?').run(id);
    conn.prepare('DELETE FROM projects WHERE id = ?').run(id); // messages, history and notes cascade
  })();
}

export function touchProject(id: string, name?: string): void {
  db()
    .prepare(
      `UPDATE projects SET updated_at = ?,
         name = CASE WHEN ? IS NOT NULL AND (name = id OR name = 'untitled') THEN ? ELSE name END
       WHERE id = ?`,
    )
    .run(Date.now(), name ?? null, name ?? null, id);
}
