import { Box, Zap } from 'lucide-react';

interface TopBarProps {
  projectId: string;
  provider: string;
  model: string;
}

export function TopBar({ projectId, provider, model }: TopBarProps) {
  const mock = provider === 'mock';
  return (
    <header className="flex h-12 shrink-0 items-center gap-3.5 border-b border-line bg-panel px-3.5">
      <div className="flex items-center gap-2">
        <Box size={18} strokeWidth={1.8} className="text-accent" />
        <span className="font-bold tracking-tight">Forge</span>
      </div>
      <div className="h-5 w-px bg-line" />
      <div className="flex items-center gap-2">
        <span className="font-medium">{projectId}</span>
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
        disabled
        title="Publishing arrives in milestone M5"
        className="cursor-not-allowed rounded-md border border-line bg-surface px-3.5 py-[7px] text-xs font-semibold text-dim-2"
      >
        Publish
      </button>
    </header>
  );
}
