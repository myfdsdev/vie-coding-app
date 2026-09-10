import { readProjectFiles } from '../store/projects';
import { DockerSandboxProvider } from './docker';
import { MockSandboxProvider } from './mock';
import type { Sandbox, SandboxProvider, SandboxStatus } from './types';

/**
 * Provider selection and sandbox lifecycle helpers.
 *
 * State lives on globalThis because the custom server and Next's route bundles
 * load separate copies of this module; both must see the same sandboxes.
 */

const SANDBOX_TIMEOUT_MS = 30 * 60 * 1000;

interface SandboxRegistry {
  provider?: SandboxProvider;
  pending: Map<string, Promise<Sandbox>>;
}

const g = globalThis as typeof globalThis & { __forgeSandboxes?: SandboxRegistry };
const registry: SandboxRegistry = (g.__forgeSandboxes ??= { pending: new Map() });

export function getSandboxProvider(): SandboxProvider {
  if (!registry.provider) {
    registry.provider = process.env.SANDBOX === 'mock' ? new MockSandboxProvider() : new DockerSandboxProvider();
  }
  return registry.provider;
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
