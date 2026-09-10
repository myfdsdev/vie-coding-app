'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type KeyboardEvent } from 'react';
import { ArrowRight, Box } from 'lucide-react';
import { firstPromptKey } from './first-prompt';
import { timeAgo } from './time';

interface LandingProps {
  projects: { id: string; name: string; updatedAt: number }[];
  provider: string;
  model: string;
}

const IDEAS: { label: string; prompt: string }[] = [
  { label: 'Client portal', prompt: 'A client portal where my clients see their invoices and which ones are overdue' },
  { label: 'Internal dashboard', prompt: 'An internal dashboard showing this week’s sales, orders and top products' },
  { label: 'Landing page + waitlist', prompt: 'A landing page for my product with a waitlist signup form' },
  { label: 'CRUD admin tool', prompt: 'An admin tool to add, edit and delete customers with a searchable table' },
  { label: 'Booking form', prompt: 'A booking form where people pick a service, a date and a time slot' },
];

export function Landing({ projects, provider, model }: LandingProps) {
  const router = useRouter();
  const [prompt, setPrompt] = useState('');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    const text = prompt.trim();
    if (!text || starting) return;
    setStarting(true);
    setError(null);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: text }),
      });
      const data = (await res.json()) as { project?: { id: string }; error?: string };
      if (!res.ok || !data.project) throw new Error(data.error ?? `Could not create the project (${res.status})`);
      try {
        sessionStorage.setItem(firstPromptKey(data.project.id), text);
      } catch {
        /* storage blocked: the builder opens with an empty chat */
      }
      router.push(`/${data.project.id}`);
    } catch (err) {
      setError((err as Error).message);
      setStarting(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void start();
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-bg text-text">
      <header className="flex h-12 shrink-0 items-center gap-3.5 px-5">
        <div className="flex items-center gap-2">
          <Box size={18} strokeWidth={1.8} className="text-accent" />
          <span className="font-bold tracking-tight">Forge</span>
        </div>
        <span className="flex-1" />
        <span className="font-mono text-[11px] text-dim-2" title={provider === 'mock' ? 'No API key configured' : `Provider: ${provider}`}>
          {model}
          {provider === 'mock' && ' · offline mock'}
        </span>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-[34px] px-10 pb-16">
        <div className="flex flex-col items-center gap-3">
          <h1 className="m-0 text-center text-[42px] font-bold leading-[1.1] tracking-[-0.03em]">What are we building?</h1>
          <p className="m-0 max-w-[520px] text-center text-[15px] leading-normal text-[#8b847b]">
            Describe it in plain language. You&apos;ll have something running in the preview in under a minute.
          </p>
        </div>

        <div className="flex w-full max-w-[760px] flex-col gap-3.5">
          <div className="flex flex-col gap-4 rounded-[14px] border border-line-raised bg-panel-2 px-[18px] pb-[13px] pt-[18px] shadow-[0_18px_50px_-22px_rgba(0,0,0,0.9)]">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={onKeyDown}
              rows={3}
              autoFocus
              placeholder="A tool where my clients upload a spreadsheet of invoices and see which ones are overdue…"
              className="w-full resize-none bg-transparent text-[15px] leading-normal text-text outline-none placeholder:text-[#5f584f]"
            />
            <div className="flex items-center gap-2">
              {error && <span className="text-xs text-err">{error}</span>}
              <span className="flex-1" />
              <button
                onClick={() => void start()}
                disabled={!prompt.trim() || starting}
                className="flex items-center gap-[7px] rounded-lg bg-accent px-[18px] py-[9px] text-[13px] font-semibold text-accent-ink transition disabled:bg-line disabled:text-dim"
              >
                {starting ? 'Starting…' : 'Start building'}
                <ArrowRight size={14} strokeWidth={2.2} />
              </button>
            </div>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            {IDEAS.map((idea) => (
              <button
                key={idea.label}
                onClick={() => setPrompt(idea.prompt)}
                className="rounded-full border border-line px-3.5 py-1.5 text-[12.5px] text-[#a49c92] transition hover:border-line-raised hover:text-text-2"
              >
                {idea.label}
              </button>
            ))}
          </div>
        </div>

        {projects.length > 0 && (
          <div className="flex w-full max-w-[760px] flex-col gap-[11px]">
            <div className="flex items-center gap-2.5">
              <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-dim-2">Recent</span>
              <span className="h-px flex-1 bg-surface" />
            </div>
            <div className="grid grid-cols-3 gap-3">
              {projects.map((p) => (
                <Link
                  key={p.id}
                  href={`/${p.id}`}
                  className="flex flex-col gap-[9px] rounded-[10px] border border-surface bg-panel px-3.5 py-[13px] transition hover:border-line-raised"
                >
                  <div className="h-16 rounded-md bg-surface" />
                  <div className="flex min-w-0 flex-col gap-[3px]">
                    <span className="truncate text-[13px] font-semibold">{p.name}</span>
                    <span className="text-[11.5px] text-dim-2" suppressHydrationWarning>
                      edited {timeAgo(p.updatedAt)}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
