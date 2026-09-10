import { AlertCircle, Box, Check, Package, X } from 'lucide-react';
import { Prose } from './Prose';
import type { AssistantTurn, FileRow } from './turn-state';

const fmt = (n: number) => n.toLocaleString('en-US');

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

export function AssistantMessage({ turn }: { turn: AssistantTurn }) {
  const done = turn.files.filter((f) => f.status !== 'writing').length;
  const total = turn.files.length;
  const writing = turn.status === 'streaming' && turn.files.some((f) => f.status === 'writing');

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
            <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-dim">
              {writing ? 'Writing files' : 'Files'}
            </span>
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
        </div>
      )}
    </div>
  );
}
