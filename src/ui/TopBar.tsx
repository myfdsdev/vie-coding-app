import Link from 'next/link';
import { Box, Cpu, Database, History, Zap } from 'lucide-react';

/** Which side panel is showing instead of the chat. */
export type Panel = 'chat' | 'history' | 'data';

interface TopBarProps {
  project: { id: string; name: string };
  provider: string;
  model: string;
  credits: number;
  panel: Panel;
  onPanel: (panel: Panel) => void;
}

export function TopBar({ project, provider, model, credits, panel, onPanel }: TopBarProps) {
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
        className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5"
        title={mock ? 'No API key configured — using the offline mock model' : `Provider: ${provider}`}
      >
        <Cpu size={13} className="text-dim" />
        <span className="font-mono text-[11px] text-text-2">{model}</span>
        {mock && <span className="text-[11px] text-dim-2">offline mock</span>}
      </div>
      <div
        className="flex items-center gap-1.5 rounded-md border border-line bg-panel-2 px-2.5 py-1.5"
        title="Credits left. Repair attempts and builds that end broken are never billed."
      >
        <Zap size={13} className="text-accent" />
        <span className="font-mono text-[11px] text-text-2">{Math.floor(credits).toLocaleString('en-US')}</span>
        <span className="text-[11px] text-dim-2">credits</span>
      </div>
      {(
        [
          { id: 'data', label: 'Data', icon: Database, title: 'What this app stores, who signed in, and its keys' },
          { id: 'history', label: 'History', icon: History, title: 'Every version, and a way back' },
        ] as const
      ).map(({ id, label, icon: Icon, title }) => (
        <button
          key={id}
          title={title}
          onClick={() => onPanel(panel === id ? 'chat' : id)}
          className={
            'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition ' +
            (panel === id ? 'border-line-raised bg-surface text-text' : 'border-line text-text-2 hover:border-line-raised')
          }
        >
          <Icon size={13} />
          {label}
        </button>
      ))}
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
