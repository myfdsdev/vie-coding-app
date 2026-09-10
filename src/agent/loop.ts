import { randomUUID } from 'node:crypto';
import { ensureSandbox, waitForReady } from '../sandbox';
import type { Sandbox } from '../sandbox/types';
import {
  PROTECTED_PATHS,
  deleteProjectFile,
  ensureWorkspace,
  readProjectFile,
  readProjectFiles,
  renameProjectFile,
  safeRelativePath,
  writeProjectFile,
} from '../store/projects';
import { buildContext, historyEntryFor } from './context';
import { ChangesParser, type ChangeOp, type ParseEvent } from './parser';
import { SYSTEM_PROMPT } from './prompt';
import { getProvider, type ModelMessage, type ModelUsage } from './providers';
import type { FileChange, TurnEvent } from './types';

/**
 * The agent turn (BUILD-PROMPT §7), M0 scope.
 *
 * M0 proves the loop: prompt -> model -> parse tags -> files -> sandbox ->
 * preview. The numbered stage comments below are the §7 stages this
 * milestone implements; ROUTE, STREAM FIX, VALIDATE, CHECKPOINT, COLLECT and
 * DECIDE arrive in M1-M3 at the positions their numbers indicate.
 */

export interface TurnInput {
  projectId: string;
  message: string;
  emit: (event: TurnEvent) => void;
  signal: AbortSignal;
}

// M0 has no persistence: history lives in memory for the life of the server.
const g = globalThis as typeof globalThis & { __forgeHistory?: Map<string, ModelMessage[]> };
const histories = (g.__forgeHistory ??= new Map<string, ModelMessage[]>());

interface Applied {
  written: { path: string; content: string }[];
  deleted: string[];
  dependenciesChanged: boolean;
  touched: string[];
}

export async function runTurn({ projectId, message, emit, signal }: TurnInput): Promise<void> {
  const started = Date.now();
  const provider = getProvider();
  const model = provider.modelFor('code');
  emit({ type: 'turn-start', turnId: randomUUID(), provider: provider.name, model });

  let filesChanged = 0;
  try {
    await ensureWorkspace(projectId);

    // Boot (or resume) the sandbox now, in parallel with the model call —
    // the user should never wait for a cold start after the code is written.
    const sandboxPromise = ensureSandbox(projectId);
    sandboxPromise.catch(() => undefined); // observed below; avoid an unhandled rejection meanwhile

    // 2 CONTEXT — cache-stable: system prompt, files sorted by path, history, message
    emit({ type: 'stage', stage: 'context' });
    const files = await readProjectFiles(projectId);
    const known = new Set(files.map((f) => f.path));
    const history = histories.get(projectId) ?? [];
    const messages: ModelMessage[] = [...history, { role: 'user', content: message }];

    // 3 PLAN+EMIT — stream from the model, parsing <changes> incrementally
    emit({ type: 'stage', stage: 'emit', detail: model });
    const parser = new ChangesParser();
    const ops: ChangeOp[] = [];
    let response = '';
    let usage: ModelUsage | null = null;
    let usedModel = model;

    const onParse = (events: ParseEvent[]) => {
      for (const e of events) {
        if (e.type === 'text') emit({ type: 'text', text: e.text, phase: e.phase });
        else if (e.type === 'file-start') {
          emit({ type: 'file', path: e.path, status: 'writing', change: known.has(normalise(e.path)) ? 'modified' : 'created' });
        } else if (e.type === 'op') ops.push(e.op);
        else if (e.type === 'warning') emit({ type: 'warning', message: e.message });
      }
    };

    for await (const ev of provider.stream({ system: SYSTEM_PROMPT, context: buildContext(files), messages, signal })) {
      if (ev.type === 'text') {
        response += ev.text;
        onParse(parser.push(ev.text));
      } else {
        usage = ev.usage;
        usedModel = ev.model;
      }
    }
    onParse(parser.end());
    if (usage) emit({ type: 'usage', model: usedModel, ...usage });

    // 5 APPLY — the full response arrived intact; now write it to the store
    emit({ type: 'stage', stage: 'apply' });
    const applied = await applyOps(projectId, ops, known, emit);
    filesChanged = applied.touched.length;
    histories.set(projectId, [
      ...messages,
      { role: 'assistant', content: historyEntryFor(response, applied.touched) },
    ]);

    // 8 EXECUTE — push the change into the sandbox and wait for the dev server
    emit({ type: 'stage', stage: 'execute' });
    emit({ type: 'sandbox', status: 'starting', detail: 'Starting the sandbox' });
    const sandbox = await sandboxPromise;
    await syncToSandbox(sandbox, applied, emit);
    const status = await waitForReady(sandbox, 90_000);
    emit({ type: 'sandbox', status, previewUrl: sandbox.previewUrl(), detail: status === 'ready' ? 'Preview ready' : `Sandbox ${status}` });
    if (status !== 'ready') throw new Error(`The sandbox did not become ready (${status}).`);
    if (applied.touched.length) emit({ type: 'preview-reload' });

    emit({ type: 'turn-end', outcome: ops.length ? 'success' : 'answered', durationMs: Date.now() - started, filesChanged });
  } catch (err) {
    if (signal.aborted) {
      emit({ type: 'turn-end', outcome: 'stopped', durationMs: Date.now() - started, filesChanged });
      return;
    }
    emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    emit({ type: 'turn-end', outcome: 'failed', durationMs: Date.now() - started, filesChanged });
  }
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
  const applied: Applied = { written: [], deleted: [], dependenciesChanged: false, touched: [] };
  const fail = (path: string, change: FileChange, error: string) => emit({ type: 'file', path, status: 'failed', change, error });

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
        applied.written.push({ path, content: op.content });
        applied.touched.push(path);
        known.add(path);
        if (path === 'package.json') applied.dependenciesChanged = true;
        emit({ type: 'file', path, status: 'done', change, lines: op.content.split('\n').length - 1 });
      } catch (err) {
        fail(op.path, change, (err as Error).message);
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
    } else {
      // Lazy-diff <edit> application is the M1 applier; M0 fails it loudly.
      fail(op.path, 'modified', 'Partial <edit> changes are not supported yet (arrives in M1). Nothing was applied.');
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
