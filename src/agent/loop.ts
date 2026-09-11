import { randomUUID } from 'node:crypto';
import { dedupeErrors, toPreviewError, type PreviewError } from '../preview/events';
import { waitForReport } from '../preview/reports';
import { ensureSandbox, waitForReady } from '../sandbox';
import type { Sandbox } from '../sandbox/types';
import { appendHistory, getHistory, takePendingNote } from '../store/chats';
import { checkpoint, ensureRepo, listVersions } from '../store/checkpoints';
import { recordUsage, settleTurn, type LedgerKind } from '../store/meter';
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
import { LoopBudget } from './budget';
import { buildContext, historyEntryFor } from './context';
import { buildFixPrompt, diagnoseError, referencedFiles } from './diagnose';
import { ChangesParser, type ChangeOp, type ParseEvent } from './parser';
import { SYSTEM_PROMPT } from './prompt';
import { getProvider, type ModelMessage, type ModelProvider, type ModelUsage } from './providers';
import type { FileChange, TurnEvent } from './types';

/**
 * The agent turn (BUILD-PROMPT §7), M2 scope.
 *
 *   2 CONTEXT, then per attempt: 3 PLAN+EMIT, 5 APPLY, 7 CHECKPOINT,
 *   8 EXECUTE, 9 COLLECT, 10 DECIDE; finally 11 METER.
 *
 * DECIDE is deterministic: a clean check ends the turn, and LoopBudget — never
 * the model — ends a failing one. Repairs and retries are recorded but never
 * billed; the build is billed only when the turn ends with a working preview.
 * ROUTE, STREAM FIX and VALIDATE arrive in M3 at the positions their numbers
 * indicate.
 */

export interface TurnInput {
  projectId: string;
  message: string;
  emit: (event: TurnEvent) => void;
  signal: AbortSignal;
  /** The builder page reports what the preview shows after each change. Without it only the build check runs. */
  previewReports?: boolean;
  /** "Fix it" from the preview: repair this failure instead of building from the message. */
  repairOf?: PreviewError;
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

type Outcome = 'success' | 'failed' | 'stopped' | 'answered';

export async function runTurn(input: TurnInput): Promise<void> {
  const { projectId, message, emit, signal } = input;
  const started = Date.now();
  const turnId = randomUUID();
  const provider = getProvider();
  const budget = new LoopBudget();
  emit({ type: 'turn-start', turnId, provider: provider.name, model: provider.modelFor('code') });

  const touched = new Set<string>();
  const calls: { kind: LedgerKind; attempt: number; model: string; usage: ModelUsage | null }[] = [];
  let outcome: Outcome = 'failed';
  let record: { user: string; response: string; problem?: string } | null = null;
  let errors: PreviewError[] = input.repairOf ? [input.repairOf] : [];
  let rounds = 0;

  /** Start a repair round for a failure: count it, show it, return the label for its model call. */
  const startRepair = (error: PreviewError): string => {
    budget.record(error);
    rounds++;
    const d = diagnoseError(error);
    const attempt = budget.attempts(error);
    const stuck = budget.isStuck(error);
    emit({ type: 'repair', round: rounds, attempt, of: budget.maxPerSignature, signature: budget.signature(error), cause: d.cause, action: d.action, stuck, error });
    return `Attempt ${attempt} of ${budget.maxPerSignature} — ${d.action}`;
  };

  try {
    await ensureWorkspace(projectId);
    ensureProject(projectId);
    touchProject(projectId, input.repairOf ? undefined : projectNameFrom(message));
    // v1 must be the state before this turn, or the turn's changes would vanish into it.
    await ensureRepo(projectId).catch((err: Error) => emit({ type: 'warning', message: `Version history is unavailable: ${err.message}` }));
    // Offered as the way back if this turn's repairs run out.
    const rollback = await listVersions(projectId).then(
      (v) => (v[0] ? { number: v[0].number, sha: v[0].sha } : undefined),
      () => undefined,
    );

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
    const noted = (text: string) => (note ? `[${note}]\n\n${text}` : text);
    const userContent = noted(input.repairOf ? `Fix the error the preview shows: ${input.repairOf.message}` : message);
    const conversation: ModelMessage[] = [...getHistory(projectId)];
    let label: string | undefined;
    if (input.repairOf) {
      label = startRepair(input.repairOf);
      conversation.push({ role: 'user', content: noted(await fixPrompt(projectId, input.repairOf, false)) });
    } else {
      conversation.push({ role: 'user', content: userContent });
    }

    let wasServing: boolean | undefined;
    for (let attempt = 0; ; attempt++) {
      const repairing = attempt > 0 || !!input.repairOf;

      // 3 PLAN+EMIT and 5 APPLY
      const pass = await modelPass({ projectId, provider, conversation, emit, signal, label });
      calls.push({ kind: repairing ? 'repair' : 'build', attempt, model: pass.model, usage: pass.usage });
      let applied = pass.applied;
      const problems = [...pass.problems];
      // An <edit> that cannot be placed exactly is asked for once more as a
      // whole file (§6c), never applied approximately.
      if (applied.failedEdits.length) {
        const retry = await modelPass({
          projectId,
          provider,
          emit,
          signal,
          conversation: [...conversation, { role: 'assistant', content: pass.response }, { role: 'user', content: wholeFilePrompt(applied.failedEdits) }],
          label: `Rewriting ${applied.failedEdits.map((f) => f.path).join(', ')} in full`,
        });
        calls.push({ kind: 'retry', attempt, model: retry.model, usage: retry.usage });
        problems.push(...retry.problems);
        applied = mergeApplied(applied, retry.applied);
      }
      conversation.push({ role: 'assistant', content: pass.response });
      for (const path of applied.touched) touched.add(path);

      if (attempt === 0) {
        // The model sent changes but none could be used: say so rather than let
        // its own "done" sentence stand, and tell the model in its history.
        const nothingApplied = pass.sawChanges && applied.touched.length === 0 && problems.length > 0;
        record = { user: userContent, response: pass.response, problem: nothingApplied ? problems.join('; ') : undefined };
        if (!repairing) {
          if (nothingApplied) {
            throw new Error("The AI's reply contained changes Forge couldn't use, so nothing in your app changed. Send your message again.");
          }
          if (!pass.sawChanges) {
            outcome = 'answered'; // a plain answer: no code changed, nothing to check
            break;
          }
        }
      }

      if (applied.touched.length) {
        // 7 CHECKPOINT — a git commit before the sandbox ever sees the change
        emit({ type: 'stage', stage: 'checkpoint' });
        try {
          const version = await checkpoint(
            projectId,
            repairing ? { subject: `Fix: ${errors[0]?.message ?? 'preview error'}`, kind: 'repair', turnId } : { subject: message, kind: 'turn', turnId },
          );
          if (version) emit({ type: 'checkpoint', version: version.number, sha: version.sha, subject: version.subject });
        } catch (err) {
          emit({ type: 'warning', message: `This change was not saved as a version: ${(err as Error).message}` });
        }

        // 8 EXECUTE — push the change into the sandbox and wait for the dev server
        emit({ type: 'stage', stage: 'execute' });
        const sandbox = await sandboxPromise;
        wasServing ??= await servingBefore;
        // The preview pane unmounts the iframe while the sandbox is not ready, so
        // announcing a start for a server that is already serving would reload
        // the preview mid-write — the same race needsPreviewRemount() avoids.
        if (!wasServing && attempt === 0) emit({ type: 'sandbox', status: 'starting', detail: 'Starting the sandbox' });
        await syncToSandbox(sandbox, applied, emit);
        const status = await waitForReady(sandbox, 90_000);
        // 'ready' can mount the iframe for the first time and a remount may
        // follow it. Neither may load before Vite's polling watcher has
        // invalidated the files just written, or the page gets their previous
        // version from Vite's cache.
        if (status === 'ready') await new Promise((r) => setTimeout(r, WATCHER_SETTLE_MS));
        emit({ type: 'sandbox', status, previewUrl: sandbox.previewUrl(), detail: status === 'ready' ? 'Preview ready' : `Sandbox ${status}` });
        if (status !== 'ready') throw new Error(`The sandbox did not become ready (${status}).`);
        // A repair is verified on a fresh page load: an error boundary that caught
        // the old crash would otherwise keep showing it.
        const remount = repairing || needsPreviewRemount({ filesChanged: true, wasServing, dependenciesChanged: applied.dependenciesChanged });
        if (remount) emit({ type: 'preview-reload' });

        // 9 COLLECT
        errors = await collect({ sandbox, turnId, attempt, applied, remounted: remount, emit, signal, previewReports: !!input.previewReports });
      }
      // A repair that changed nothing leaves the failure as it was.
      emit({ type: 'check', attempt, errors: errors.slice(0, 3) });

      // 10 DECIDE
      if (!errors.length) {
        outcome = 'success';
        break;
      }
      const primary = errors[0];
      if (!budget.canRetry(primary)) {
        emit({ type: 'repair-stopped', error: primary, cause: diagnoseError(primary).cause, attempts: budget.attempts(primary), rollback });
        outcome = 'failed';
        break;
      }
      label = startRepair(primary);
      conversation.push({ role: 'user', content: await fixPrompt(projectId, primary, budget.isStuck(primary)) });
    }
  } catch (err) {
    if (signal.aborted) outcome = 'stopped';
    else {
      emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      outcome = 'failed';
    }
  }

  // The request and a condensed reply, so later turns know what happened (append-only).
  if (record) {
    const repairNote =
      rounds === 0
        ? ''
        : outcome === 'success'
          ? `\n[the preview failed after this change and was repaired automatically in ${rounds} attempt${rounds === 1 ? '' : 's'}]`
          : `\n[the preview still fails: ${errors[0]?.message ?? 'unknown error'} — automatic repair stopped]`;
    try {
      appendHistory(projectId, [
        { role: 'user', content: record.user },
        { role: 'assistant', content: historyEntryFor(record.response, [...touched], record.problem) + repairNote },
      ]);
    } catch (err) {
      console.error('[forge] could not save the model history', err);
    }
  }

  // 11 METER — every call is recorded; only a turn that leaves a working preview pays for its build.
  const total = sumUsage(calls.map((c) => c.usage));
  if (total) emit({ type: 'usage', model: calls[0]?.model ?? provider.modelFor('code'), ...total });
  try {
    for (const c of calls) if (c.usage) recordUsage({ projectId, turnId, attempt: c.attempt, kind: c.kind, model: c.model, usage: c.usage });
    emit({ type: 'meter', ...settleTurn(turnId, outcome === 'success' || outcome === 'answered') });
  } catch (err) {
    console.error('[forge] could not record usage', err);
  }

  emit({ type: 'turn-end', outcome, durationMs: Date.now() - started, filesChanged: touched.size });
}

/** Files the build check asks the dev server to compile. */
const BUILDABLE = /^src\/.+\.(?:tsx?|jsx?|css)$/;

/**
 * 9 COLLECT: build errors from the dev server itself (deterministic, needs no
 * browser), then — if nothing failed to build — what the preview reported
 * through the builder page within its watch window.
 */
async function collect(o: {
  sandbox: Sandbox;
  turnId: string;
  attempt: number;
  applied: Applied;
  remounted: boolean;
  emit: (e: TurnEvent) => void;
  signal: AbortSignal;
  previewReports: boolean;
}): Promise<PreviewError[]> {
  o.emit({ type: 'stage', stage: 'collect' });
  const found: PreviewError[] = [];
  const code = o.applied.written.map((w) => w.path).filter((p) => BUILDABLE.test(p));
  if (o.sandbox.buildCheck && code.length) {
    for (const f of await o.sandbox.buildCheck([...new Set([...code, 'src/main.tsx'])])) {
      found.push({ type: 'BUILD_ERROR', message: f.message, frame: f.frame, file: f.path });
    }
  }
  if (!found.length && o.previewReports) {
    const origin = new URL(o.sandbox.previewUrl()).origin;
    const watch = async (check: number, remounted: boolean, fresh: boolean): Promise<PreviewError[]> => {
      // A fresh load waits for the shim's verdict, RENDER_OK or BLANK_SCREEN,
      // 2.5s after load — later on a cold sandbox. The page ends the watch
      // early on RENDER_OK or a crash.
      const windowMs = remounted ? (fresh ? 8000 : 12_000) : 2500;
      o.emit({ type: 'collect', turnId: o.turnId, attempt: o.attempt, check, windowMs, remounted, fresh });
      const events = await waitForReport(o.turnId, check, windowMs + 8000, o.signal);
      return dedupeErrors((events ?? []).map((e) => toPreviewError(e, origin)).filter((e): e is PreviewError => e !== null));
    };
    // Check ids: 2 per attempt, one look and one possible second look.
    let seen = await watch(o.attempt * 2, o.remounted, false);
    // "Blank" and nothing else may only mean the first load was slower than the
    // shim's 2.5s deadline. Look once more on a fresh load, which is warm by now.
    if (seen.length === 1 && seen[0].type === 'BLANK_SCREEN') {
      o.emit({ type: 'preview-reload' });
      seen = await watch(o.attempt * 2 + 1, true, true);
    }
    found.push(...seen);
  }
  return dedupeErrors(found);
}

/** The §10 fix prompt, with the files the failure points at. */
async function fixPrompt(projectId: string, error: PreviewError, stuck: boolean): Promise<string> {
  const files: { path: string; content: string }[] = [];
  for (const path of referencedFiles(error)) {
    const content = await readProjectFile(projectId, path).catch(() => null);
    if (content !== null) files.push({ path, content });
  }
  return buildFixPrompt(error, diagnoseError(error), files, { stuck });
}

/** 3 PLAN+EMIT and 5 APPLY for one model call. */
async function modelPass(opts: {
  projectId: string;
  provider: ModelProvider;
  conversation: ModelMessage[];
  emit: (e: TurnEvent) => void;
  signal: AbortSignal;
  /** Set for repairs and whole-file retries, whose prose stays out of the chat; only their files show. */
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
