'use client';

import { useState } from 'react';
import { AlertCircle, Box, Check, Package, X } from 'lucide-react';
import { Prose } from './Prose';
import type { AssistantTurn, FileRow, RepairRow } from './turn-state';

const fmt = (n: number) => n.toLocaleString('en-US');
const credits = (n: number) => (n < 10 ? n.toFixed(1) : fmt(Math.round(n)));
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function FileLine({ file }: { file: FileRow }) {
  const dot = file.change === 'created' ? 'bg-ok' : file.change === 'deleted' ? 'bg-err' : 'bg-accent';
  return (
    <div className={'flex flex-col gap-1 px-3 py-[7px] ' + (file.status === 'writing' ? 'bg-surface' : '')}>
      <div className="flex items-center gap-2">
        {file.status === 'writing' && <span className="spinner" />}
        {file.status === 'done' && <Check size={12} strokeWidth={2.5} className="shrink-0 text-ok" />}
        {file.status === 'failed' && <X size={12} strokeWidth={2.5} className="shrink-0 text-err" />}
        <span className={'min-w-0 flex-1 truncate font-mono text-[11.5px] ' + (file.status === 'writing' ? 'text-text' : 'text-dim')}>
          {file.from ? `${file.from} → ${file.path}` : file.path}
        </span>
        <span className={`h-[5px] w-[5px] shrink-0 rounded-full ${dot}`} title={file.change} />
      </div>
      {file.error && <span className="pl-5 text-[11.5px] leading-snug text-[#e8b4b2]">{file.error}</span>}
    </div>
  );
}

const TITLE: Record<RepairRow['error']['type'], string> = {
  BUILD_ERROR: 'Build error caught',
  REACT_RENDER_ERROR: 'Runtime error caught',
  UNCAUGHT_EXCEPTION: 'Runtime error caught',
  UNHANDLED_REJECTION: 'Runtime error caught',
  BLANK_SCREEN: 'Blank screen caught',
};

/** One repair round (ErrorFix design): the diagnosed error, then the attempt to fix it. */
function RepairCard({ repair, onStop }: { repair: RepairRow; onStop?: () => void }) {
  const [open, setOpen] = useState(false);
  const e = repair.error;
  const where = e.file ? `${e.file.split('/').pop()}${e.line ? `:${e.line}` : ''}` : null;
  // Stack traces live behind a disclosure; the diagnosis is what the user reads.
  const details = [e.componentStack && `Component stack:\n${e.componentStack}`, e.stack && `Stack:\n${e.stack}`, e.frame].filter(Boolean).join('\n\n');
  const state = repair.status === 'fixing' ? 'Fixing' : repair.status === 'fixed' ? 'Fixed' : 'Did not hold';

  return (
    <div className="flex flex-col gap-2.5">
      <div className="overflow-hidden rounded-[10px] border border-[#4a2a28] bg-[#1e1615]">
        <div className="flex items-center gap-2 border-b border-[#3a2321] bg-[#251817] px-3 py-2.5">
          <AlertCircle size={14} className="text-err" />
          <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-err">{TITLE[e.type]}</span>
          <span className="flex-1" />
          {where && <span className="font-mono text-[10.5px] text-[#8b6360]">{where}</span>}
        </div>
        <div className="flex flex-col gap-[11px] p-3">
          <div className="break-words font-mono text-[11.5px] leading-[1.55] text-[#e8b4b2]">{e.message}</div>
          <div className="flex flex-col gap-[5px] rounded-[7px] border border-[#33221f] bg-[#1a1413] px-2.5 py-[9px]">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-[#a08a6a]">Likely cause</span>
            <span className="text-xs leading-[1.55] text-text-2">{repair.cause}</span>
          </div>
          {details && (
            <button onClick={() => setOpen((o) => !o)} className="self-start text-[11px] text-dim hover:text-text-2">
              {open ? 'Hide details' : 'Show details'}
            </button>
          )}
          {open && (
            <pre className="thin-scroll max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-[#141312] p-2.5 font-mono text-[10.5px] leading-relaxed text-dim">
              {details}
            </pre>
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-[10px] border border-line bg-panel-2">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
          {repair.status === 'fixing' && <span className="spinner" />}
          {repair.status === 'fixed' && <Check size={12} strokeWidth={2.5} className="text-ok" />}
          {repair.status === 'failed' && <X size={12} strokeWidth={2.5} className="text-err" />}
          <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-dim">{state}</span>
          <span className="flex-1" />
          <span className="flex items-center gap-[3px]">
            {Array.from({ length: repair.of }, (_, i) => (
              <span key={i} className={'block h-[3px] w-3.5 rounded-sm ' + (i < repair.attempt ? 'bg-accent' : 'bg-line')} />
            ))}
          </span>
          <span className="font-mono text-[10.5px] text-dim-2">
            {repair.attempt} of {repair.of}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-[11px] text-xs text-text">
          <span>{capitalise(repair.action)}</span>
          {repair.stuck && <span className="text-[11px] text-dim">— the last fix didn&apos;t hold, trying a different approach</span>}
        </div>
        <div className="flex items-center gap-[7px] border-t border-[#24301f] bg-[#161d16] px-3 py-[9px]">
          <Check size={12} className="shrink-0 text-ok" />
          <span className="text-[11.5px] font-medium text-[#93c197]">Fix attempts aren&apos;t billed — you pay for the first build only</span>
        </div>
      </div>

      {repair.status === 'fixing' && onStop && (
        <button onClick={onStop} className="rounded-[7px] border border-line py-2 text-xs font-medium text-[#a49c92] transition hover:border-line-raised">
          Stop and let me look
        </button>
      )}
    </div>
  );
}

function FailureCard({ failure, onRollback }: { failure: NonNullable<AssistantTurn['failure']>; onRollback?: (sha: string) => void }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border border-[#4a2a28] bg-[#1e1615] p-3">
      <div className="flex items-center gap-2">
        <AlertCircle size={14} className="text-err" />
        <span className="text-[12.5px] font-semibold text-[#e8b4b2]">Forge couldn&apos;t fix this automatically</span>
      </div>
      <span className="text-xs leading-relaxed text-text-2">{failure.cause}</span>
      <span className="text-[11.5px] text-dim">
        Tried {failure.attempts} {failure.attempts === 1 ? 'time' : 'times'}. None of it was billed. Describe what you see and Forge will try again with that.
      </span>
      {failure.rollback && onRollback && (
        <button
          onClick={() => onRollback(failure.rollback!.sha)}
          className="rounded-[7px] border border-line py-2 text-xs font-medium text-[#a49c92] transition hover:border-line-raised"
        >
          Roll back to v{failure.rollback.number}
        </button>
      )}
    </div>
  );
}

interface AssistantMessageProps {
  turn: AssistantTurn;
  onStop?: () => void;
  onRollback?: (sha: string) => void;
}

export function AssistantMessage({ turn, onStop, onRollback }: AssistantMessageProps) {
  const done = turn.files.filter((f) => f.status !== 'writing').length;
  const total = turn.files.length;
  const writing = turn.status === 'streaming' && turn.files.some((f) => f.status === 'writing');
  const repairs = turn.repairs ?? [];

  return (
    <div className="flex flex-col gap-3">
      {(turn.plan.trim() || turn.status === 'streaming') && (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center gap-[7px] text-[11px] font-medium uppercase tracking-[0.04em] text-dim">
            <Box size={12} className="text-accent" />
            Plan
            {turn.status === 'streaming' && turn.stage && (
              <span className="ml-auto flex items-center gap-1.5 normal-case tracking-normal text-dim-2">
                <span className="spinner" />
                {turn.stage}
              </span>
            )}
          </div>
          {turn.plan.trim() && <Prose text={turn.plan.trim()} className="leading-relaxed text-text-2" />}
        </div>
      )}

      {total > 0 && (
        <div className="overflow-hidden rounded-[9px] border border-line bg-panel-2">
          <div className="flex items-center gap-2 border-b border-line px-3 py-[9px]">
            <span className={'h-1.5 w-1.5 rounded-full ' + (writing ? 'bg-accent' : 'bg-ok')} />
            <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-dim">{writing ? 'Writing files' : 'Files'}</span>
            <span className="flex-1" />
            <span className="font-mono text-[11px] text-dim-2">
              {done} / {total}
            </span>
          </div>
          <div className="flex flex-col">
            {turn.files.map((f) => (
              <FileLine key={f.path} file={f} />
            ))}
          </div>
          <div className="h-0.5 bg-line">
            <div className="h-0.5 bg-accent transition-all" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
          </div>
        </div>
      )}

      {turn.dependencies.map((d) => (
        <div key={d.spec} className="flex items-center gap-2 text-xs text-dim">
          <Package size={12} className={d.status === 'added' ? 'text-ok' : 'text-err'} />
          <span className="font-mono">{d.detail ?? d.spec}</span>
          {d.status === 'rejected' && <span className="text-err">rejected</span>}
        </div>
      ))}

      {turn.summary.trim() && <Prose text={turn.summary.trim()} className="leading-relaxed text-text" />}

      {repairs.map((r) => (
        <RepairCard key={r.round} repair={r} onStop={turn.status === 'streaming' ? onStop : undefined} />
      ))}
      {repairs.length > 0 && turn.status === 'success' && (
        <div className="flex items-center gap-2 text-xs font-medium text-ok">
          <Check size={13} strokeWidth={2.5} />
          Fixed automatically — the preview works now.
        </div>
      )}
      {turn.failure && <FailureCard failure={turn.failure} onRollback={onRollback} />}

      {turn.warnings.map((w, i) => (
        <div key={i} className="whitespace-pre-wrap rounded-md border border-[#3a3020] bg-[#1d1810] px-2.5 py-2 text-xs leading-snug text-[#d8c39c]">
          {w}
        </div>
      ))}

      {turn.error && (
        <div className="flex gap-2 rounded-[9px] border border-[#4a2a28] bg-[#1e1615] px-3 py-2.5">
          <AlertCircle size={14} className="mt-px shrink-0 text-err" />
          <span className="text-[12.5px] leading-normal text-[#e8b4b2]">{turn.error}</span>
        </div>
      )}

      {turn.status !== 'streaming' && (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[10.5px] text-dim-2">
          {turn.status === 'stopped' && <span>stopped</span>}
          {turn.usage && (
            <span>
              {fmt(turn.usage.inputTokens)} in · {fmt(turn.usage.outputTokens)} out
              {turn.usage.cacheReadTokens > 0 && ` · ${fmt(turn.usage.cacheReadTokens)} cached`}
            </span>
          )}
          {turn.durationMs !== undefined && <span>{(turn.durationMs / 1000).toFixed(1)}s</span>}
          {turn.model && <span>{turn.model}</span>}
          {turn.version && <span className="text-ok">saved as v{turn.version.number}</span>}
          {turn.meter &&
            (turn.meter.billed > 0 ? (
              <span className="text-text-2">≈ {credits(turn.meter.billed)} credits</span>
            ) : (
              turn.meter.free > 0 && <span className="text-ok">not billed</span>
            ))}
          {turn.meter && turn.meter.billed > 0 && turn.meter.free > 0 && <span className="text-ok">repairs not billed</span>}
        </div>
      )}
    </div>
  );
}
