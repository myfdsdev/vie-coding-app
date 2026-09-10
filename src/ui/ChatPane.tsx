'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { AssistantMessage } from './AssistantMessage';
import type { ChatMessage } from './turn-state';

interface ChatPaneProps {
  messages: ChatMessage[];
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}

const SUGGESTIONS = ['A task board for my team', 'A recipe box with cook times', 'A client portal for invoices'];

export function ChatPane({ messages, busy, onSend, onStop }: ChatPaneProps) {
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  const submit = () => {
    const text = draft.trim();
    if (!text || busy) return;
    onSend(text);
    setDraft('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <aside className="flex w-[376px] shrink-0 flex-col border-r border-line bg-panel">
      <div ref={listRef} className="thin-scroll flex flex-1 flex-col gap-4 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="flex flex-1 flex-col justify-center gap-3 px-2">
            <h1 className="text-xl font-bold tracking-tight">What are we building?</h1>
            <p className="leading-relaxed text-dim">Describe it in plain language. It will appear in the preview on the right.</p>
            <div className="flex flex-wrap gap-2 pt-1">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => setDraft(s)}
                  className="rounded-full border border-line px-3 py-1.5 text-xs text-[#a49c92] transition hover:border-line-raised hover:text-text-2"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[270px] whitespace-pre-wrap rounded-[10px_10px_3px_10px] border border-[#35301f] bg-[#252119] px-3 py-2.5 leading-normal">
                {m.text}
              </div>
            </div>
          ) : (
            <AssistantMessage key={m.id} turn={m} />
          ),
        )}
      </div>

      <div className="shrink-0 border-t border-line p-3">
        <div className="flex flex-col gap-2.5 rounded-[10px] border border-line-raised bg-panel-2 px-3 py-2.5">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={3}
            placeholder={busy ? 'Working — you can keep typing…' : 'Describe the next change…'}
            className="w-full resize-none bg-transparent leading-normal text-text outline-none placeholder:text-[#5f584f]"
          />
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-dim-2">Enter to send · Shift+Enter for a new line</span>
            <span className="flex-1" />
            {busy ? (
              <button onClick={onStop} title="Stop" className="flex h-[26px] w-[26px] items-center justify-center rounded-md bg-line text-text-2 hover:bg-line-raised">
                <Square size={11} fill="currentColor" />
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={!draft.trim()}
                title="Send"
                className="flex h-[26px] w-[26px] items-center justify-center rounded-md bg-accent text-accent-ink transition disabled:bg-line disabled:text-dim"
              >
                <ArrowUp size={13} strokeWidth={2.4} />
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
