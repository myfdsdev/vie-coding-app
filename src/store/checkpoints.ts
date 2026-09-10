import fs from 'node:fs/promises';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { workspaceDir } from './projects';

/**
 * One git commit per turn (BUILD-PROMPT §7 stage 7): the version history,
 * restore points and free diffs. Each workspace is its own repository.
 *
 * Restoring brings back code only. Database rows and anything else outside
 * the workspace stay as they are — the UI must say so.
 */

export type VersionKind = 'template' | 'turn' | 'repair' | 'restore';

export interface Version {
  sha: string;
  /** v1 is the starter template; numbers only grow, a restore is a new version. */
  number: number;
  subject: string;
  kind: VersionKind;
  turnId?: string;
  createdAt: number;
  added: number;
  modified: number;
  deleted: number;
}

const KINDS = new Set<VersionKind>(['template', 'turn', 'repair', 'restore']);
const SHA_RE = /^[0-9a-f]{7,40}$/;

function git(projectId: string): SimpleGit {
  return simpleGit({
    baseDir: workspaceDir(projectId),
    maxConcurrentProcesses: 1,
    // Identity and line endings per command, so the user's global git config never matters.
    config: ['user.name=Forge', 'user.email=forge@localhost', 'core.autocrlf=false', 'core.safecrlf=false', 'core.quotepath=false'],
  });
}

// Git holds an index lock, so operations on one repository run one at a time.
const g = globalThis as typeof globalThis & { __forgeGitQueues?: Map<string, Promise<unknown>> };
const queues = (g.__forgeGitQueues ??= new Map());

function serial<T>(projectId: string, task: () => Promise<T>): Promise<T> {
  const next = (queues.get(projectId) ?? Promise.resolve()).then(task, task);
  queues.set(
    projectId,
    next.catch(() => undefined),
  );
  return next;
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

/** Make the workspace a repository whose first commit is the starter template. */
export function ensureRepo(projectId: string): Promise<void> {
  return serial(projectId, () => ensureRepoUnlocked(projectId));
}

async function ensureRepoUnlocked(projectId: string): Promise<void> {
  const dir = workspaceDir(projectId);
  if (await exists(path.join(dir, '.git'))) return;
  const repo = git(projectId);
  await repo.raw(['init', '--quiet', '--initial-branch=main']);
  // Excludes live in .git/info, not in a project file the model or sandbox would see.
  await fs.writeFile(path.join(dir, '.git', 'info', 'exclude'), 'node_modules/\ndist/\n.vite/\n');
  await repo.add(['-A']);
  await repo.commit(['Starter template', trailers('template')], undefined, { '--allow-empty': null });
}

function trailers(kind: VersionKind, turnId?: string): string {
  return turnId ? `Forge-Kind: ${kind}\nForge-Turn: ${turnId}` : `Forge-Kind: ${kind}`;
}

/** Commit whatever changed in the workspace. Returns null when nothing did. */
export function checkpoint(
  projectId: string,
  opts: { subject: string; kind: VersionKind; turnId?: string },
): Promise<Version | null> {
  return serial(projectId, async () => {
    await ensureRepoUnlocked(projectId);
    const repo = git(projectId);
    await repo.add(['-A']);
    if ((await repo.status()).isClean()) return null;
    await repo.commit([oneLine(opts.subject), trailers(opts.kind, opts.turnId)]);
    return (await listVersionsUnlocked(projectId))[0];
  });
}

/** Newest first. */
export function listVersions(projectId: string): Promise<Version[]> {
  return serial(projectId, async () => {
    await ensureRepoUnlocked(projectId);
    return listVersionsUnlocked(projectId);
  });
}

async function listVersionsUnlocked(projectId: string): Promise<Version[]> {
  const out = await git(projectId).raw(['log', '--no-color', '--name-status', '--format=%x1e%H%x1f%ct%x1f%s%x1f%b%x1f']);
  const chunks = out.split('\x1e').filter((c) => c.trim());
  return chunks.map((chunk, i) => {
    const [sha, ct, subject, body, rest = ''] = chunk.split('\x1f');
    const kind = /^Forge-Kind:\s*(\S+)/m.exec(body)?.[1] as VersionKind | undefined;
    const turnId = /^Forge-Turn:\s*(\S+)/m.exec(body)?.[1];
    const counts = { added: 0, modified: 0, deleted: 0 };
    for (const line of rest.split('\n')) {
      const status = line.trim()[0];
      if (status === 'A') counts.added++;
      else if (status === 'D') counts.deleted++;
      else if (status === 'M' || status === 'R' || status === 'C' || status === 'T') counts.modified++;
    }
    return {
      sha: sha.trim(),
      number: chunks.length - i,
      subject: subject.trim(),
      kind: kind && KINDS.has(kind) ? kind : 'turn',
      turnId,
      createdAt: Number(ct) * 1000,
      ...counts,
    };
  });
}

/**
 * Make the workspace match an earlier version, as a new version on top: the
 * history is never rewritten, so a restore can itself be undone. Files added
 * after that version are removed. Returns what changed so the sandbox can
 * receive exactly those files.
 */
export function restoreVersion(
  projectId: string,
  sha: string,
): Promise<{ version: Version; restoredFrom: Version; written: string[]; deleted: string[] }> {
  return serial(projectId, async () => {
    if (!SHA_RE.test(sha)) throw new Error('Not a version id.');
    await ensureRepoUnlocked(projectId);
    const versions = await listVersionsUnlocked(projectId);
    const target = versions.find((v) => v.sha === sha || v.sha.startsWith(sha));
    if (!target) throw new Error('That version is not in this project.');
    const repo = git(projectId);
    const before = versions[0].sha;
    await repo.raw(['restore', '--source', target.sha, '--staged', '--worktree', '--', '.']);
    await repo.add(['-A']);
    if ((await repo.status()).isClean()) return { version: versions[0], restoredFrom: target, written: [], deleted: [] };
    await repo.commit([`Restore v${target.number}: ${oneLine(target.subject)}`, trailers('restore')]);
    const diff = await repo.raw(['diff', '--name-status', '--no-renames', before, 'HEAD']);
    const written: string[] = [];
    const deleted: string[] = [];
    for (const line of diff.split('\n')) {
      const [status, file] = line.split('\t');
      if (!file) continue;
      if (status === 'D') deleted.push(file);
      else written.push(file);
    }
    return { version: (await listVersionsUnlocked(projectId))[0], restoredFrom: target, written, deleted };
  });
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return (line.length > 72 ? `${line.slice(0, 71)}…` : line) || 'Update';
}
