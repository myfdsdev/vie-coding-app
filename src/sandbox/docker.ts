import fs from 'node:fs';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import Docker from 'dockerode';
import tar from 'tar-stream';
import type { Sandbox, SandboxProvider, SandboxStatus } from './types';

/**
 * Docker implementation of the sandbox contract. The ONLY file allowed to
 * import dockerode.
 *
 * Every isolation flag mirrors docker/run-sandbox.sh. One deliberate
 * difference: /app is a per-project named volume instead of a bind mount of
 * workspaces/<id>. On Docker Desktop (Windows/macOS) bind mounts from the host
 * filesystem are 10-50x slower and drop file-watch events (SETUP-GUIDE §2), so
 * files are pushed in through the Docker API instead — the same model managed
 * sandbox providers use. The workspace on the host stays the source of truth.
 */

const IMAGE = () => process.env.SANDBOX_IMAGE || 'vibe-sandbox:latest';
const NETWORK = 'vibe-sandboxes';
const APP_UID = 10001;
const APP_DIR = '/app';

export function previewDomain(): string {
  return process.env.PREVIEW_DOMAIN || 'lvh.me';
}

export function publicPort(): number {
  return Number(process.env.PORT || 3000);
}

export function previewHost(projectId: string): string {
  return `sbx-${projectId}.${previewDomain()}`;
}

function gatewayUrl(): URL {
  return new URL(process.env.PREVIEW_GATEWAY_URL || 'http://127.0.0.1:3100');
}

const containerName = (projectId: string) => `vibe-sbx-${projectId}`;
const volumeName = (projectId: string) => `vibe-ws-${projectId}`;

/** Docker Desktop on Windows exposes the Linux engine on its own named pipe. */
function connectDocker(): Docker {
  if (process.env.DOCKER_HOST) return new Docker();
  if (process.platform === 'win32') {
    const desktop = '//./pipe/dockerDesktopLinuxEngine';
    return new Docker({ socketPath: fs.existsSync('\\\\.\\pipe\\dockerDesktopLinuxEngine') ? desktop : '//./pipe/docker_engine' });
  }
  return new Docker({ socketPath: '/var/run/docker.sock' });
}

/** Actionable error text for the three setup steps people skip. */
export class SandboxSetupError extends Error {}

/** HTTP status of the preview as seen through the gateway, or 0 if unreachable. */
function probePreview(projectId: string, timeoutMs = 3000): Promise<number> {
  const gw = gatewayUrl();
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: gw.hostname,
        port: gw.port || 80,
        path: '/',
        method: 'GET',
        headers: { host: `${previewHost(projectId)}:${publicPort()}` },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(0));
    req.end();
  });
}

class DockerSandbox implements Sandbox {
  constructor(
    private readonly docker: Docker,
    readonly id: string,
    private readonly container: Docker.Container,
  ) {}

  async writeFiles(files: { path: string; content: string }[]): Promise<void> {
    if (!files.length) return;
    const pack = tar.pack();
    const dirs = new Set<string>();
    for (const f of files) {
      const parts = f.path.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    // Explicit directory entries so new folders are owned by the app user, not root.
    for (const dir of [...dirs].sort()) {
      pack.entry({ name: `${dir}/`, type: 'directory', mode: 0o755, uid: APP_UID, gid: APP_UID });
    }
    for (const f of files) {
      pack.entry({ name: f.path, mode: 0o644, uid: APP_UID, gid: APP_UID, mtime: new Date() }, f.content);
    }
    pack.finalize();
    const chunks: Buffer[] = [];
    for await (const chunk of pack) chunks.push(Buffer.from(chunk as Uint8Array));
    await this.container.putArchive(Buffer.concat(chunks), { path: APP_DIR });
  }

  async deleteFiles(paths: string[]): Promise<void> {
    if (!paths.length) return;
    await this.run(['rm', '-f', '--', ...paths.map((p) => `${APP_DIR}/${p}`)]);
  }

  async readFile(path: string): Promise<string | null> {
    const res = await this.run(['cat', `${APP_DIR}/${path}`]);
    return res.code === 0 ? res.stdout : null;
  }

  async listFiles(): Promise<string[]> {
    const res = await this.run([
      'sh',
      '-c',
      "find . \\( -path ./node_modules -o -path ./.git -o -path ./dist \\) -prune -o -type f -print | sed 's|^\\./||' | sort",
    ]);
    return res.stdout.split('\n').filter(Boolean);
  }

  exec(cmd: string, opts?: { timeoutMs?: number }) {
    return this.run(['sh', '-c', cmd], opts?.timeoutMs);
  }

  previewUrl(): string {
    return `http://${previewHost(this.id)}:${publicPort()}`;
  }

  async installDependencies(): Promise<{ ok: boolean; log: string }> {
    const res = await this.run(['npm', 'install', '--no-audit', '--no-fund'], 300_000);
    const log = (res.stdout + res.stderr).slice(-4000);
    return { ok: res.code === 0, log };
  }

  async status(): Promise<SandboxStatus> {
    let info: Docker.ContainerInspectInfo;
    try {
      info = await this.container.inspect();
    } catch {
      return 'stopped';
    }
    if (info.State.Running) {
      const code = await probePreview(this.id);
      return code > 0 && code < 500 ? 'ready' : 'starting';
    }
    if (info.State.Restarting) return 'starting';
    return info.State.ExitCode !== 0 || info.State.OOMKilled ? 'crashed' : 'stopped';
  }

  async stop(): Promise<void> {
    await this.container.stop({ t: 5 }).catch(ignoreNotModified);
  }

  async destroy(): Promise<void> {
    await this.container.remove({ force: true }).catch(ignoreNotFound);
    await this.docker.getVolume(volumeName(this.id)).remove().catch(ignoreNotFound);
  }

  /** Run a command in the container as the app user; never through a host shell. */
  private async run(cmd: string[], timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
    const exec = await this.container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: APP_DIR,
      User: `${APP_UID}:${APP_UID}`,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const out = new PassThrough();
    const err = new PassThrough();
    let stdout = '';
    let stderr = '';
    out.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    err.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    this.docker.modem.demuxStream(stream, out, err);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        stream.destroy();
        reject(new Error(`Command timed out after ${timeoutMs}ms: ${cmd.join(' ')}`));
      }, timeoutMs);
      stream.on('end', () => {
        clearTimeout(timer);
        resolve();
      });
      stream.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    const info = await exec.inspect();
    return { code: info.ExitCode ?? -1, stdout, stderr };
  }
}

function ignoreNotFound(err: { statusCode?: number }) {
  if (err?.statusCode !== 404) throw err;
}
function ignoreNotModified(err: { statusCode?: number }) {
  if (err?.statusCode !== 304 && err?.statusCode !== 404) throw err;
}

export class DockerSandboxProvider implements SandboxProvider {
  private readonly docker = connectDocker();

  /**
   * The engine itself answers; otherwise a setup error naming Docker's reason.
   * Docker Desktop's API proxy can answer while its engine VM is down and then
   * return 503 for real calls, so every call site maps errors via engineDown().
   */
  private async ensureEngine(): Promise<void> {
    try {
      await this.docker.version();
    } catch (err) {
      throw engineDown(err) ?? err;
    }
  }

  /** Fail loudly, with the fix, when a setup step was skipped. */
  async preflight(): Promise<void> {
    await this.ensureEngine();
    try {
      await this.docker.getImage(IMAGE()).inspect();
    } catch {
      throw new SandboxSetupError(`Sandbox image ${IMAGE()} is missing. Run: npm run docker:build`);
    }
    try {
      await this.docker.getNetwork(NETWORK).inspect();
    } catch {
      throw new SandboxSetupError(`Docker network ${NETWORK} is missing. Run: npm run docker:up`);
    }
  }

  /**
   * Create the container, push the project files into its volume, then start
   * it. Writing before start means the entrypoint sees package.json and skips
   * template seeding, so it can never race with (and overwrite) project files.
   */
  async createWithFiles(
    opts: { projectId: string; timeoutMs: number },
    files: { path: string; content: string }[],
  ): Promise<Sandbox> {
    await this.preflight();
    const { projectId } = opts;
    await this.docker.createVolume({ Name: volumeName(projectId), Labels: { 'vibe.sandbox': '1', 'vibe.id': projectId } });
    const container = await this.docker.createContainer({
      name: containerName(projectId),
      Image: IMAGE(),
      User: `${APP_UID}:${APP_UID}`,
      Labels: { 'vibe.sandbox': '1', 'vibe.id': projectId, 'vibe.timeoutMs': String(opts.timeoutMs) },
      Env: [
        // egress through the allowlisting proxy
        'HTTP_PROXY=http://egress:8888',
        'HTTPS_PROXY=http://egress:8888',
        'NO_PROXY=localhost,127.0.0.1',
        'NPM_CONFIG_PROXY=http://egress:8888',
        'NPM_CONFIG_HTTPS_PROXY=http://egress:8888',
        // Vite needs its public hostname for allowedHosts and the HMR client
        `PREVIEW_HOST=${previewHost(projectId)}`,
        `PREVIEW_PUBLIC_PORT=${publicPort()}`,
        'PREVIEW_PROTO=ws',
      ],
      ExposedPorts: { '5173/tcp': {} },
      HostConfig: {
        NetworkMode: NETWORK, // no direct internet; proxy only
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        Memory: 1024 ** 3, // no swap: OOM-kill instead of thrash
        MemorySwap: 1024 ** 3,
        NanoCpus: 1_000_000_000,
        PidsLimit: 256, // fork-bomb guard
        Ulimits: [{ Name: 'nofile', Soft: 4096, Hard: 4096 }],
        Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=256m' },
        Mounts: [{ Type: 'volume', Source: volumeName(projectId), Target: APP_DIR }],
        // Never mount the Docker socket into a sandbox.
      },
    });
    const sandbox = new DockerSandbox(this.docker, projectId, container);
    await sandbox.writeFiles(files);
    await container.start();
    return sandbox;
  }

  create(opts: { projectId: string; timeoutMs: number }): Promise<Sandbox> {
    return this.createWithFiles(opts, []);
  }

  async resume(projectId: string): Promise<Sandbox | null> {
    await this.ensureEngine();
    const container = this.docker.getContainer(containerName(projectId));
    let info: Docker.ContainerInspectInfo;
    try {
      info = await container.inspect();
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return null;
      throw engineDown(err) ?? err;
    }
    if (!info.State.Running) await container.start().catch(ignoreNotModified);
    return new DockerSandbox(this.docker, projectId, container);
  }
}

/** A friendly setup error if `err` means the Docker engine is unreachable, else null. */
function engineDown(err: unknown): SandboxSetupError | null {
  const e = err as { statusCode?: number; code?: string; json?: { message?: string }; message?: string } | undefined;
  const reason = String(e?.json?.message ?? e?.message ?? '');
  const unreachable = e?.code === 'ENOENT' || e?.code === 'ECONNREFUSED' || e?.code === 'EPIPE';
  if (!unreachable && e?.statusCode !== 503 && !/unable to start/i.test(reason)) return null;
  const detail = /unable to start/i.test(reason) ? ' (Docker Desktop reports it is unable to start)' : '';
  return new SandboxSetupError(`Docker is not running${detail}. Start Docker Desktop, wait for "Engine running", then reload.`);
}
