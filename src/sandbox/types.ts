/**
 * Sandbox provider contract (BUILD-PROMPT §6a).
 *
 * Nothing outside src/sandbox/docker.ts may import dockerode. Moving to a
 * managed provider (E2B, Vercel, Cloudflare...) must be a config change.
 */
export interface SandboxProvider {
  create(opts: { projectId: string; timeoutMs: number }): Promise<Sandbox>;
  resume(projectId: string): Promise<Sandbox | null>;
  /**
   * Remove everything a project's sandbox left behind, whether or not it is
   * running — a stopped container still holds the volume with its code.
   */
  remove(projectId: string): Promise<void>;
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
  /**
   * Ask the dev server to build these modules now and return the ones that
   * fail. Optional: a provider with no HTTP route to its dev server omits it,
   * and the repair loop then relies on what the preview reports.
   */
  buildCheck?(paths: string[]): Promise<{ path: string; message: string; frame?: string }[]>;
  status(): Promise<SandboxStatus>;
  stop(): Promise<void>;
  destroy(): Promise<void>;
}
