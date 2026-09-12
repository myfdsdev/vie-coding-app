import { readProjectFile, readProjectFiles } from '../store/projects';
import { DockerSandboxProvider } from './docker';
import { MockSandboxProvider } from './mock';
import type { Sandbox, SandboxProvider, SandboxStatus } from './types';

/**
 * Provider selection and sandbox lifecycle helpers.
 *
 * In-flight creations live on globalThis because Next's route bundles each
 * load their own copy of this module and must not race each other. The
 * provider itself is stateless and stays module-scoped, so a code reload in
 * dev never keeps running a stale class.
 */

const SANDBOX_TIMEOUT_MS = 30 * 60 * 1000;

interface SandboxRegistry {
  pending: Map<string, Promise<Sandbox>>;
}

const g = globalThis as typeof globalThis & { __forgeSandboxes?: SandboxRegistry };
const registry: SandboxRegistry = (g.__forgeSandboxes ??= { pending: new Map() });

let provider: SandboxProvider | undefined;

export function getSandboxProvider(): SandboxProvider {
  provider ??= process.env.SANDBOX === 'mock' ? new MockSandboxProvider() : new DockerSandboxProvider();
  return provider;
}

/**
 * Return a running sandbox for the project, creating it from the workspace if
 * needed. Concurrent callers (page warm-up + first chat turn) share one create.
 */
export function ensureSandbox(projectId: string): Promise<Sandbox> {
  const inflight = registry.pending.get(projectId);
  if (inflight) return inflight;
  const task = (async () => {
    const provider = getSandboxProvider();
    const existing = await provider.resume(projectId);
    if (existing) return existing;
    const files = await readProjectFiles(projectId);
    if (provider instanceof DockerSandboxProvider) {
      return provider.createWithFiles({ projectId, timeoutMs: SANDBOX_TIMEOUT_MS }, files);
    }
    const sandbox = await provider.create({ projectId, timeoutMs: SANDBOX_TIMEOUT_MS });
    await sandbox.writeFiles(files);
    return sandbox;
  })().finally(() => registry.pending.delete(projectId));
  registry.pending.set(projectId, task);
  return task;
}

/** Poll until the dev server answers, the container dies, or time runs out. */
export async function waitForReady(sandbox: Sandbox, timeoutMs = 60_000): Promise<SandboxStatus> {
  const deadline = Date.now() + timeoutMs;
  let status = await sandbox.status();
  while (status !== 'ready' && status !== 'crashed' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    status = await sandbox.status();
  }
  return status;
}

/**
 * Take a project's sandbox away with the project: the container and the
 * volume holding its copy of the code. Never throws — a project the user
 * deleted must disappear whether or not Docker is reachable.
 */
export async function destroySandbox(projectId: string): Promise<void> {
  try {
    await getSandboxProvider().remove(projectId);
  } catch (err) {
    console.error(`[forge] could not remove the sandbox for ${projectId}`, err);
  }
}

/**
 * Bring a sandbox up to date after the workspace changed outside a turn (a
 * version restore): exactly the given files, then dependencies if needed.
 */
export async function pushWorkspaceChanges(projectId: string, change: { written: string[]; deleted: string[] }): Promise<Sandbox> {
  const sandbox = await ensureSandbox(projectId);
  if (change.deleted.length) await sandbox.deleteFiles(change.deleted);
  const files = await Promise.all(
    change.written.map(async (path) => ({ path, content: (await readProjectFile(projectId, path)) ?? '' })),
  );
  // Dependencies first, so the dev server never sees code importing a package that is not installed yet.
  const manifest = files.filter((f) => f.path === 'package.json');
  if (manifest.length) {
    await sandbox.writeFiles(manifest);
    await sandbox.installDependencies();
  }
  const code = files.filter((f) => f.path !== 'package.json');
  if (code.length) await sandbox.writeFiles(code);
  return sandbox;
}
