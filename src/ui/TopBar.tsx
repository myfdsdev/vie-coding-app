import Link from 'next/link';
import { Box, History, Zap } from 'lucide-react';

interface TopBarProps {
  project: { id: string; name: string };
  provider: string;
  model: string;
  historyOpen: boolean;
  onToggleHistory: () => void;
}

export function TopBar({ project, provider, model, historyOpen, onToggleHistory }: TopBarProps) {
  const mock = provider === 'mock';
  return (
    <header className="flex h-12 shrink-0 items-center gap-3.5 border-b border-line bg-panel px-3.5">
      <Link href="/" title="All projects" className="flex items-center gap-2">
        <Box size={18} strokeWidth={1.8} className="text-accent" />
        <span className="font-bold tracking-tight">Forge</span>
      </Link>
      <div className="h-5 w-px bg-line" />
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-medium" title={project.id}>
          {project.name}
        </span>
        <span className="rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[11px] text-dim">main</span>
      </div>
      <div className="flex-1" />
      <div
        className="flex items-center gap-1.5 rounded-md border border-line bg-panel-2 px-2.5 py-1.5"
        title={mock ? 'No API key configured — using the offline mock model' : `Provider: ${provider}`}
      >
        <Zap size={13} className="text-accent" />
        <span className="font-mono text-[11px] text-text-2">{model}</span>
        {mock && <span className="text-[11px] text-dim-2">offline mock</span>}
      </div>
      <button
        onClick={onToggleHistory}
        className={
          'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition ' +
          (historyOpen ? 'border-line-raised bg-surface text-text' : 'border-line text-text-2 hover:border-line-raised')
        }
      >
        <History size={13} />
        History
      </button>
      <button
        disabled
        title="Publishing arrives in milestone M5"
        className="cursor-not-allowed rounded-md border border-line bg-surface px-3.5 py-[7px] text-xs font-semibold text-dim-2"
      >
        Publish
      </button>
    </header>
  );
}
