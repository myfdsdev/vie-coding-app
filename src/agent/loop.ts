import { randomUUID } from 'node:crypto';
import { ensureSandbox, waitForReady } from '../sandbox';
import type { Sandbox } from '../sandbox/types';
import { appendHistory, getHistory, takePendingNote } from '../store/chats';
import { checkpoint, ensureRepo } from '../store/checkpoints';
import {
  PROTECTED_PATHS,
  deleteProjectFile,
  ensureProject,
  ensureWorkspace,
  projectNameFrom,
  readProjectFile,
  readProjectFiles,
  renameProjectFile,
  safeRelativePath,
  touchProject,
  writeProjectFile,
} from '../store/projects';
import { applyEdit } from './apply-edit';
import { buildContext, historyEntryFor } from './context';
import { ChangesParser, type ChangeOp, type ParseEvent } from './parser';
import { SYSTEM_PROMPT } from './prompt';
import { getProvider, type ModelMessage, type ModelProvider, type ModelUsage } from './providers';
import type { FileChange, TurnEvent } from './types';

/**
 * The agent turn (BUILD-PROMPT §7), M1 scope.
 *
 * Stages here: 2 CONTEXT, 3 PLAN+EMIT, 5 APPLY (whole files and placed
 * edits), 7 CHECKPOINT (a git commit per turn) and 8 EXECUTE. ROUTE, STREAM
 * FIX, VALIDATE, COLLECT, DECIDE and METER arrive in M2-M3 at the positions
 * their numbers indicate.
 */

export interface TurnInput {
  projectId: string;
  message: string;
  emit: (event: TurnEvent) => void;
  signal: AbortSignal;
}

interface Applied {
  written: { path: string; content: string }[];
  deleted: string[];
  dependenciesChanged: boolean;
  touched: string[];
  /** <edit>s apply-edit.ts could not place; they are asked for again as whole files. */
  failedEdits: { path: string; reason: string }[];
}

/** One model call and the file operations it produced. */
interface Pass {
  response: string;
  applied: Applied;
  problems: string[];
  sawChanges: boolean;
  usage: ModelUsage | null;
  model: string;
}

export async function runTurn({ projectId, message, emit, signal }: TurnInput): Promise<void> {
  const started = Date.now();
  const turnId = randomUUID();
  const provider = getProvider();
  emit({ type: 'turn-start', turnId, provider: provider.name, model: provider.modelFor('code') });

  let filesChanged = 0;
  try {
    await ensureWorkspace(projectId);
    ensureProject(projectId);
    touchProject(projectId, projectNameFrom(message));
    // v1 must be the state before this turn, or the turn's changes would vanish into it.
    await ensureRepo(projectId).catch((err: Error) => emit({ type: 'warning', message: `Version history is unavailable: ${err.message}` }));

    // Boot (or resume) the sandbox now, in parallel with the model call —
    // the user should never wait for a cold start after the code is written.
    const sandboxPromise = ensureSandbox(projectId);
    sandboxPromise.catch(() => undefined); // observed below; avoid an unhandled rejection meanwhile
    // Whether a dev server was already serving before this turn, so the open
    // preview is live over HMR. Checked now: a sandbox (re)created during the
    // turn is usually serving by the time files are written, yet no preview is
    // attached to it.
    const servingBefore = sandboxPromise.then((s) => s.status()).then((st) => st === 'ready', () => false);

    // 2 CONTEXT — cache-stable: system prompt, files sorted by path, history, message
    emit({ type: 'stage', stage: 'context' });
    const note = takePendingNote(projectId);
    const userContent = note ? `[${note}]\n\n${message}` : message;
    const conversation: ModelMessage[] = [...getHistory(projectId), { role: 'user', content: userContent }];

    // 3 PLAN+EMIT and 5 APPLY
    const first = await modelPass({ projectId, provider, conversation, emit, signal });
    let applied = first.applied;
    const problems = [...first.problems];
    const usages = [first.usage];

    // An <edit> that cannot be placed exactly is asked for once more as a
    // whole file (§6c), never applied approximately.
    if (applied.failedEdits.length) {
      const retry = await modelPass({
        projectId,
        provider,
        emit,
        signal,
        conversation: [
          ...conversation,
          { role: 'assistant', content: first.response },
          { role: 'user', content: wholeFilePrompt(applied.failedEdits) },
        ],
        label: `Rewriting ${applied.failedEdits.map((f) => f.path).join(', ')} in full`,
      });
      usages.push(retry.usage);
      problems.push(...retry.problems);
      applied = mergeApplied(applied, retry.applied);
    }
    filesChanged = applied.touched.length;
    const usage = sumUsage(usages);
    if (usage) emit({ type: 'usage', model: first.model, ...usage });

    // The model sent changes but none could be used: say so rather than let its
    // own "done" sentence stand, and tell the model in its history.
    const nothingApplied = first.sawChanges && applied.touched.length === 0 && problems.length > 0;
    appendHistory(projectId, [
      { role: 'user', content: userContent },
      { role: 'assistant', content: historyEntryFor(first.response, applied.touched, nothingApplied ? problems.join('; ') : undefined) },
    ]);
    if (nothingApplied) {
      throw new Error("The AI's reply contained changes Forge couldn't use, so nothing in your app changed. Send your message again.");
    }

    // 7 CHECKPOINT — a git commit before the sandbox ever sees the change
    if (applied.touched.length) {
      emit({ type: 'stage', stage: 'checkpoint' });
      try {
        const version = await checkpoint(projectId, { subject: message, kind: 'turn', turnId });
        if (version) emit({ type: 'checkpoint', version: version.number, sha: version.sha, subject: version.subject });
      } catch (err) {
        emit({ type: 'warning', message: `This change was not saved as a version: ${(err as Error).message}` });
      }
    }

    // 8 EXECUTE — push the change into the sandbox and wait for the dev server
    emit({ type: 'stage', stage: 'execute' });
    const sandbox = await sandboxPromise;
    const wasServing = await servingBefore;
    // The preview pane unmounts the iframe while the sandbox is not ready, so
    // announcing a start for a server that is already serving would reload the
    // preview mid-write — the same race needsPreviewRemount() avoids.
    if (!wasServing) emit({ type: 'sandbox', status: 'starting', detail: 'Starting the sandbox' });
    await syncToSandbox(sandbox, applied, emit);
    const status = await waitForReady(sandbox, 90_000);
    // 'ready' can mount the iframe for the first time (e.g. after a failed
    // warm-up) and a remount may follow it. Neither may load before Vite's
    // polling watcher has invalidated the files just written, or the page gets
    // their previous version from Vite's cache.
    if (status === 'ready' && applied.touched.length) await new Promise((r) => setTimeout(r, WATCHER_SETTLE_MS));
    emit({ type: 'sandbox', status, previewUrl: sandbox.previewUrl(), detail: status === 'ready' ? 'Preview ready' : `Sandbox ${status}` });
    if (status !== 'ready') throw new Error(`The sandbox did not become ready (${status}).`);
    if (needsPreviewRemount({ filesChanged: applied.touched.length > 0, wasServing, dependenciesChanged: applied.dependenciesChanged })) {
      emit({ type: 'preview-reload' });
    }

    emit({ type: 'turn-end', outcome: first.sawChanges ? 'success' : 'answered', durationMs: Date.now() - started, filesChanged });
  } catch (err) {
    if (signal.aborted) {
      emit({ type: 'turn-end', outcome: 'stopped', durationMs: Date.now() - started, filesChanged });
      return;
    }
    emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    emit({ type: 'turn-end', outcome: 'failed', durationMs: Date.now() - started, filesChanged });
  }
}

/** 3 PLAN+EMIT and 5 APPLY for one model call. */
async function modelPass(opts: {
  projectId: string;
  provider: ModelProvider;
  conversation: ModelMessage[];
  emit: (e: TurnEvent) => void;
  signal: AbortSignal;
  /** Set for the whole-file retry, whose prose stays out of the chat; only its files show. */
  label?: string;
}): Promise<Pass> {
  const { projectId, provider, conversation, emit, signal, label } = opts;
  const files = await readProjectFiles(projectId);
  const known = new Set(files.map((f) => f.path));
  emit({ type: 'stage', stage: 'emit', detail: label });

  const parser = new ChangesParser();
  const ops: ChangeOp[] = [];
  // Parse problems and failed file operations: if they leave nothing
  // applied, the turn must not end looking like a success.
  const problems: string[] = [];
  let response = '';
  let usage: ModelUsage | null = null;
  let model = provider.modelFor('code');

  const onParse = (events: ParseEvent[]) => {
    for (const e of events) {
      if (e.type === 'text') {
        if (!label) emit({ type: 'text', text: e.text, phase: e.phase });
      } else if (e.type === 'file-start') {
        emit({ type: 'file', path: e.path, status: 'writing', change: known.has(normalise(e.path)) ? 'modified' : 'created' });
      } else if (e.type === 'op') ops.push(e.op);
      else if (e.type === 'warning') {
        problems.push(e.message);
        emit({ type: 'warning', message: e.message });
      }
    }
  };

  for await (const ev of provider.stream({ system: SYSTEM_PROMPT, context: buildContext(files), messages: conversation, signal })) {
    if (ev.type === 'text') {
      response += ev.text;
      onParse(parser.push(ev.text));
    } else {
      usage = ev.usage;
      model = ev.model;
    }
  }
  onParse(parser.end());

  emit({ type: 'stage', stage: 'apply' });
  const applied = await applyOps(projectId, ops, known, (e) => {
    if (e.type === 'file' && e.status === 'failed') problems.push(`${e.path}: ${e.error}`);
    emit(e);
  });
  return { response, applied, problems, sawChanges: parser.sawChanges, usage, model };
}

function wholeFilePrompt(failed: { path: string; reason: string }[]): string {
  return [
    'These edits could not be placed exactly, so they were NOT applied:',
    ...failed.map((f) => `- ${f.path}: ${f.reason}`),
    '',
    'The project files above show the current content. Send each of these files again as a COMPLETE file with <write path="...">, including every change you intended. Change nothing else.',
  ].join('\n');
}

/** The retry's results win for any file both passes touched. */
function mergeApplied(a: Applied, b: Applied): Applied {
  const rewritten = new Set(b.written.map((w) => w.path));
  const removed = new Set(b.deleted);
  return {
    written: [...a.written.filter((w) => !rewritten.has(w.path) && !removed.has(w.path)), ...b.written],
    deleted: [...new Set([...a.deleted.filter((d) => !rewritten.has(d)), ...b.deleted])],
    dependenciesChanged: a.dependenciesChanged || b.dependenciesChanged,
    touched: [...new Set([...a.touched, ...b.touched])],
    failedEdits: b.failedEdits,
  };
}

function sumUsage(usages: (ModelUsage | null)[]): ModelUsage | null {
  const real = usages.filter((u): u is ModelUsage => u !== null);
  if (!real.length) return null;
  return real.reduce((a, b) => ({
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  }));
}

function normalise(path: string): string {
  try {
    return safeRelativePath(path);
  } catch {
    return path;
  }
}

async function applyOps(
  projectId: string,
  ops: ChangeOp[],
  known: Set<string>,
  emit: (e: TurnEvent) => void,
): Promise<Applied> {
  const applied: Applied = { written: [], deleted: [], dependenciesChanged: false, touched: [], failedEdits: [] };
  const fail = (path: string, change: FileChange, error: string) => emit({ type: 'file', path, status: 'failed', change, error });
  const record = (path: string, content: string, change: FileChange) => {
    applied.written.push({ path, content });
    applied.touched.push(path);
    known.add(path);
    if (path === 'package.json') applied.dependenciesChanged = true;
    emit({ type: 'file', path, status: 'done', change, lines: content.split('\n').length - 1 });
  };

  for (const op of ops) {
    if (op.type === 'write') {
      const change: FileChange = known.has(normalise(op.path)) ? 'modified' : 'created';
      try {
        const path = safeRelativePath(op.path);
        if (PROTECTED_PATHS.has(path)) {
          fail(path, change, 'This file is managed by the builder and cannot be changed.');
          continue;
        }
        await writeProjectFile(projectId, path, op.content);
        record(path, op.content, change);
      } catch (err) {
        fail(op.path, change, (err as Error).message);
      }
    } else if (op.type === 'edit') {
      try {
        const path = safeRelativePath(op.path);
        if (PROTECTED_PATHS.has(path)) {
          fail(path, 'modified', 'This file is managed by the builder and cannot be changed.');
          continue;
        }
        const current = await readProjectFile(projectId, path);
        const result = current === null ? { ok: false as const, reason: "The file doesn't exist yet, so it can't be edited." } : applyEdit(current, op.body);
        if (!result.ok) {
          applied.failedEdits.push({ path, reason: result.reason });
          fail(path, 'modified', result.reason);
          continue;
        }
        await writeProjectFile(projectId, path, result.content);
        record(path, result.content, 'modified');
      } catch (err) {
        fail(op.path, 'modified', (err as Error).message);
      }
    } else if (op.type === 'delete') {
      try {
        const path = safeRelativePath(op.path);
        if (PROTECTED_PATHS.has(path)) {
          fail(path, 'deleted', 'This file is managed by the builder and cannot be deleted.');
          continue;
        }
        if (await deleteProjectFile(projectId, path)) {
          applied.deleted.push(path);
          applied.touched.push(path);
          known.delete(path);
          emit({ type: 'file', path, status: 'done', change: 'deleted' });
        }
      } catch (err) {
        fail(op.path, 'deleted', (err as Error).message);
      }
    } else if (op.type === 'rename') {
      try {
        const from = safeRelativePath(op.from);
        const to = safeRelativePath(op.to);
        if (PROTECTED_PATHS.has(from) || PROTECTED_PATHS.has(to)) {
          fail(to, 'renamed', 'Builder-managed files cannot be renamed.');
          continue;
        }
        await renameProjectFile(projectId, from, to);
        const content = (await readProjectFile(projectId, to)) ?? '';
        applied.deleted.push(from);
        applied.written.push({ path: to, content });
        applied.touched.push(from, to);
        known.delete(from);
        known.add(to);
        emit({ type: 'file', path: to, from, status: 'done', change: 'renamed' });
      } catch (err) {
        fail(op.to, 'renamed', (err as Error).message);
      }
    } else if (op.type === 'add-dependency') {
      const result = await addDependency(projectId, op.spec);
      emit({ type: 'dependency', spec: op.spec, status: result.ok ? 'added' : 'rejected', detail: result.detail });
      if (result.ok && result.content) {
        applied.written = applied.written.filter((w) => w.path !== 'package.json');
        applied.written.push({ path: 'package.json', content: result.content });
        applied.dependenciesChanged = true;
        if (!applied.touched.includes('package.json')) applied.touched.push('package.json');
      }
    }
  }
  return applied;
}

/** "date-fns@^3" -> ["date-fns", "^3"]; "@scope/pkg" -> ["@scope/pkg", "latest"] */
export function splitSpec(spec: string): [string, string] {
  const at = spec.lastIndexOf('@');
  if (at > 0) return [spec.slice(0, at), spec.slice(at + 1) || 'latest'];
  return [spec, 'latest'];
}

async function addDependency(projectId: string, spec: string): Promise<{ ok: boolean; detail?: string; content?: string }> {
  const [name, range] = splitSpec(spec.trim());
  if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(name)) return { ok: false, detail: `"${name}" is not a valid package name` };
  const raw = await readProjectFile(projectId, 'package.json');
  if (!raw) return { ok: false, detail: 'package.json is missing' };
  const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
  pkg.dependencies = { ...(pkg.dependencies ?? {}), [name]: range };
  const content = JSON.stringify(pkg, null, 2) + '\n';
  await writeProjectFile(projectId, 'package.json', content);
  return { ok: true, content, detail: `${name}@${range}` };
}

async function syncToSandbox(sandbox: Sandbox, applied: Applied, emit: (e: TurnEvent) => void): Promise<void> {
  const deleted = applied.deleted.filter((p) => !applied.written.some((w) => w.path === p));
  if (deleted.length) await sandbox.deleteFiles(deleted);
  if (applied.written.length) await sandbox.writeFiles(applied.written);
  if (applied.dependenciesChanged) {
    emit({ type: 'sandbox', status: 'starting', detail: 'Installing dependencies' });
    const install = await sandbox.installDependencies();
    if (!install.ok) emit({ type: 'warning', message: `Dependency install failed:\n${install.log.slice(-1200)}` });
  }
}

/** Four polling intervals of the sandbox's file watcher (300ms, docker/template/vite.config.ts). */
export const WATCHER_SETTLE_MS = 1200;

/**
 * Whether the preview iframe must be remounted once this turn's files are in
 * the sandbox. A dev server that was already serving pushes the change to the
 * open preview over HMR, keeping app state; remounting there raced Vite's
 * polling watcher and loaded the previous version of the changed modules.
 */
export function needsPreviewRemount(p: { filesChanged: boolean; wasServing: boolean; dependenciesChanged: boolean }): boolean {
  return p.filesChanged && (!p.wasServing || p.dependenciesChanged);
}
