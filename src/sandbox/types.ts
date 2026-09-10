/**
 * Sandbox provider contract (BUILD-PROMPT §6a).
 *
 * Nothing outside src/sandbox/docker.ts may import dockerode. Moving to a
 * managed provider (E2B, Vercel, Cloudflare...) must be a config change.
 */
export interface SandboxProvider {
  create(opts: { projectId: string; timeoutMs: number }): Promise<Sandbox>;
  resume(projectId: string): Promise<Sandbox | null>;
}

export type SandboxStatus = 'starting' | 'ready' | 'crashed' | 'stopped';

export interface Sandbox {
  id: string;
  writeFiles(files: { path: string; content: string }[]): Promise<void>;
  deleteFiles(paths: string[]): Promise<void>;
  readFile(path: string): Promise<string | null>;
  listFiles(): Promise<string[]>;
  exec(cmd: string, opts?: { timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
  previewUrl(): string;
  installDependencies(): Promise<{ ok: boolean; log: string }>;
  status(): Promise<SandboxStatus>;
  stop(): Promise<void>;
  destroy(): Promise<void>;
}
