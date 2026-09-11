'use client';

import { useState } from 'react';
import { AlertCircle, Lock, Monitor, RotateCw, Smartphone, Tablet, Wrench } from 'lucide-react';
import type { PreviewError } from '@/preview/events';
import type { SandboxState } from './Builder';
import type { RepairRow, Usage } from './turn-state';

type Device = 'desktop' | 'tablet' | 'mobile';
const WIDTH: Record<Device, string> = { desktop: '100%', tablet: '768px', mobile: '390px' };
const fmt = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

interface PreviewPaneProps {
  previewUrl: string;
  previewKey: number;
  sandbox: SandboxState;
  onReload: () => void;
  lastUsage?: Usage;
  /** The repair in progress, shown over the preview. */
  repair?: RepairRow;
  /** Failures found by the latest check. */
  errors?: PreviewError[];
  /** A failure the preview reported while no turn was running, and a way to have it fixed. */
  idleError?: PreviewError;
  onFix?: () => void;
}

function headline(e: PreviewError): string {
  if (e.type === 'BUILD_ERROR') return 'The preview can’t be built';
  if (e.type === 'BLANK_SCREEN') return 'The preview is blank';
  return 'The preview crashed while rendering';
}

/** The first frames that point into the project, for the overlay. */
function frames(e: PreviewError): string[] {
  return (e.componentStack ?? e.stack ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('src/'))
    .slice(0, 2);
}

export function PreviewPane({ previewUrl, previewKey, sandbox, onReload, lastUsage, repair, errors, idleError, onFix }: PreviewPaneProps) {
  const [device, setDevice] = useState<Device>('desktop');
  const ready = sandbox.status === 'ready';
  const failed = sandbox.status === 'crashed';
  const host = previewUrl.replace(/^https?:\/\//, '');
  const shown = errors?.length ? errors : idleError ? [idleError] : [];
  const buildErrors = shown.filter((e) => e.type === 'BUILD_ERROR').length;
  const runtimeErrors = shown.length - buildErrors;

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-bg">
      <div className="flex h-[42px] shrink-0 items-center gap-2.5 border-b border-line px-3">
        <button onClick={onReload} title="Reload preview" className="flex h-[26px] w-[26px] items-center justify-center rounded-md bg-surface text-dim hover:text-text-2">
          <RotateCw size={13} />
        </button>
        <div className="flex max-w-[420px] flex-1 items-center gap-2 rounded-md border border-line bg-panel-2 px-2.5 py-[5px]">
          {failed || shown.length ? <span className="h-[7px] w-[7px] rounded-full bg-err" /> : <Lock size={12} className={ready ? 'text-ok' : 'text-dim-2'} />}
          <span className="truncate font-mono text-[11px] text-[#8b847b]">{host}</span>
        </div>
        <span className="flex-1" />
        <div className="flex gap-px rounded-md border border-line bg-panel-2 p-0.5">
          {([['desktop', Monitor], ['tablet', Tablet], ['mobile', Smartphone]] as const).map(([d, Icon]) => (
            <button
              key={d}
              onClick={() => setDevice(d)}
              title={d}
              className={'flex rounded px-2 py-1 ' + (device === d ? 'bg-line text-text' : 'text-dim-2 hover:text-dim')}
            >
              <Icon size={13} />
            </button>
          ))}
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 justify-center overflow-hidden bg-[#1c1917]">
        {ready ? (
          <iframe
            key={previewKey}
            src={previewUrl}
            title="App preview"
            // The preview is a different origin (sbx-<id>.<domain>), which is what
            // makes allow-scripts + allow-same-origin safe here.
            sandbox="allow-scripts allow-forms allow-popups allow-modals allow-same-origin"
            allow="clipboard-write"
            className="h-full border-0 bg-white transition-[width]"
            style={{ width: WIDTH[device] }}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center p-10">
            {failed ? (
              <div className="flex max-w-[520px] gap-3 rounded-[14px] border border-[#4a2a28] bg-[#191413] px-5 py-4">
                <AlertCircle size={16} className="mt-0.5 shrink-0 text-err" />
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-semibold">The preview sandbox isn’t available</span>
                  <span className="text-[12.5px] leading-relaxed text-dim">{sandbox.error ?? sandbox.detail ?? 'Unknown error'}</span>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2.5 text-dim">
                <span className="spinner" />
                {sandbox.detail ?? 'Starting the sandbox'}
              </div>
            )}
          </div>
        )}

        {ready && repair && repair.status === 'fixing' && (
          // ErrorFix design: the crash, diagnosed, over the preview while it is being fixed.
          <div className="absolute inset-0 flex items-center justify-center bg-[#1c1917]/85 p-10">
            <div className="w-full max-w-[560px] overflow-hidden rounded-[14px] border border-[#4a2a28] bg-[#191413] shadow-[0_24px_70px_-30px_rgba(0,0,0,0.95)]">
              <div className="flex flex-col gap-3.5 border-b border-[#2f211f] px-[22px] py-5">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg bg-[#2c1b1a]">
                    <AlertCircle size={15} className="text-err" />
                  </span>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-semibold">{headline(repair.error)}</span>
                    <span className="text-xs text-[#8b847b]">Forge caught it and is already fixing.</span>
                  </div>
                </div>
                <div className="overflow-hidden rounded-lg border border-[#2a201f] bg-[#141312] px-[13px] py-3 font-mono text-[11.5px] leading-[1.7] text-[#a49c92]">
                  <div className="break-words text-[#e8b4b2]">{repair.error.message}</div>
                  {frames(repair.error).map((line) => (
                    <div key={line} className="truncate text-dim-2">
                      {line}
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2.5 px-[22px] py-3.5">
                <span className="spinner" />
                <span className="text-[12.5px] text-text-2">
                  Attempt {repair.attempt} of {repair.of} — {repair.action}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      <footer className="flex h-7 shrink-0 items-center gap-3.5 border-t border-line bg-panel px-3 font-mono text-[11px]">
        {shown.length > 0 ? (
          <>
            <span className="flex items-center gap-1.5 text-err">
              <span className="h-[5px] w-[5px] rounded-full bg-err" />
              {plural(runtimeErrors, 'runtime error')}
            </span>
            <span className="text-dim-2">{plural(buildErrors, 'build error')}</span>
          </>
        ) : (
          <span className={'flex items-center gap-1.5 ' + (ready ? 'text-ok' : failed ? 'text-err' : 'text-dim')}>
            <span className={'h-[5px] w-[5px] rounded-full ' + (ready ? 'bg-ok' : failed ? 'bg-err' : 'bg-dim')} />
            {ready ? 'vite ready' : failed ? 'sandbox unavailable' : sandbox.detail ?? 'starting'}
          </span>
        )}
        <span className="text-dim-2">sandbox docker · 1 vCPU</span>
        <span className="flex-1" />
        {repair?.status === 'fixing' && <span className="text-ok">repair turn — not billed</span>}
        {!repair && idleError && onFix && (
          <button
            onClick={onFix}
            className="flex items-center gap-1 rounded border border-line px-2 py-0.5 font-sans text-[11px] font-medium text-accent transition hover:border-line-raised"
          >
            <Wrench size={11} />
            Fix it
          </button>
        )}
        {lastUsage && !repair && (
          <span className="text-dim-2">
            {fmt(lastUsage.inputTokens)} in · {fmt(lastUsage.outputTokens)} out
          </span>
        )}
      </footer>
    </section>
  );
}
