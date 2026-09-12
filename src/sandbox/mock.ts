import type { Sandbox, SandboxProvider, SandboxStatus } from './types';

/**
 * In-process sandbox for tests. Files live in memory; nothing executes.
 * `exec` results can be scripted per command to simulate typecheck output etc.
 */
export class MockSandbox implements Sandbox {
  readonly files = new Map<string, string>();
  readonly execLog: string[] = [];
  private state: SandboxStatus = 'ready';

  constructor(
    readonly id: string,
    private readonly scripted: Record<string, { code: number; stdout: string; stderr: string }> = {},
  ) {}

  async writeFiles(files: { path: string; content: string }[]): Promise<void> {
    for (const f of files) this.files.set(f.path, f.content);
  }

  async deleteFiles(paths: string[]): Promise<void> {
    for (const p of paths) this.files.delete(p);
  }

  async readFile(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async listFiles(): Promise<string[]> {
    return [...this.files.keys()].sort();
  }

  async exec(cmd: string): Promise<{ code: number; stdout: string; stderr: string }> {
    this.execLog.push(cmd);
    return this.scripted[cmd] ?? { code: 0, stdout: '', stderr: '' };
  }

  previewUrl(): string {
    return `http://sbx-${this.id}.mock.invalid`;
  }

  async installDependencies(): Promise<{ ok: boolean; log: string }> {
    this.execLog.push('npm install');
    return { ok: true, log: 'mock install: nothing to do' };
  }

  async status(): Promise<SandboxStatus> {
    return this.state;
  }

  async stop(): Promise<void> {
    this.state = 'stopped';
  }

  async destroy(): Promise<void> {
    this.files.clear();
    this.state = 'stopped';
  }
}

export class MockSandboxProvider implements SandboxProvider {
  readonly sandboxes = new Map<string, MockSandbox>();

  async create(opts: { projectId: string; timeoutMs: number }): Promise<Sandbox> {
    const sbx = new MockSandbox(opts.projectId);
    this.sandboxes.set(opts.projectId, sbx);
    return sbx;
  }

  async resume(projectId: string): Promise<Sandbox | null> {
    return this.sandboxes.get(projectId) ?? null;
  }

  async remove(projectId: string): Promise<void> {
    await this.sandboxes.get(projectId)?.destroy();
    this.sandboxes.delete(projectId);
  }
}
