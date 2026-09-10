import type { ModelRequest } from './providers';

/**
 * Canned model output for PROVIDER=mock. It exercises the real pipeline —
 * streaming parse, file writes, edits, checkpoints, sandbox sync, preview —
 * with no API key.
 *
 * The first build request in a project always produces the same small task
 * app (titled from the user's words). A follow-up request gets one demo
 * change, sent as an <edit>: the header badge swaps colour. If the loop
 * reports that an edit could not be placed, the mock sends the whole file.
 */
export function mockResponse(req: ModelRequest): string {
  const last = req.messages[req.messages.length - 1]?.content ?? '';
  if (req.context.includes('src/hooks/useTasks.ts')) {
    const color: Badge = req.context.includes(`rounded-xl ${BADGE.rose}`) ? 'indigo' : 'rose';
    return /could not be placed exactly/.test(last) ? headerRewrite(color) : headerEdit(color);
  }
  return taskApp(titleFrom(last), last);
}

/** "build me a recipe tracker for my family" -> "Recipe Tracker" */
export function titleFrom(prompt: string): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP_WORDS.has(w))
    .slice(0, 3);
  if (!words.length) return 'Task Board';
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

const STOP_WORDS = new Set(
  'a an the me my our your i we you to for of and or with that this app application build make create please can could would want need simple small little tool website site page which where who will so it in on some just'.split(
    ' ',
  ),
);

const BADGE = { indigo: 'bg-indigo-600', rose: 'bg-rose-500' } as const;
type Badge = keyof typeof BADGE;

function badgeLine(color: Badge): string {
  return `      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${BADGE[color]} text-white shadow-sm">`;
}

function headerFile(color: Badge): string {
  return `import { ListChecks } from 'lucide-react';

interface HeaderProps {
  title: string;
  brief: string;
  remaining: number;
}

export function Header({ title, brief, remaining }: HeaderProps) {
  return (
    <header className="flex items-start gap-4">
${badgeLine(color)}
        <ListChecks size={22} />
      </span>
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
        <p className="mt-1 text-sm text-slate-500">{brief}</p>
        <p className="mt-2 text-xs font-medium uppercase tracking-wide text-indigo-600">
          {remaining === 0 ? 'All done' : \`\${remaining} left to do\`}
        </p>
      </div>
    </header>
  );
}`;
}

function headerEdit(color: Badge): string {
  return `I'm the offline mock model, so a follow-up request gets one demo change: the header badge turns ${color}.

<changes>
<edit path="src/components/Header.tsx" instruction="I change the header badge colour to ${color}.">
// ... existing code ...
export function Header({ title, brief, remaining }: HeaderProps) {
  return (
    <header className="flex items-start gap-4">
${badgeLine(color)}
        <ListChecks size={22} />
      </span>
// ... existing code ...
</edit>
</changes>

The header badge is ${color} now. Add an ANTHROPIC_API_KEY or GEMINI_API_KEY to .env.local for real changes.`;
}

function headerRewrite(color: Badge): string {
  return `Here is the whole header file instead.

<changes>
<write path="src/components/Header.tsx">
${headerFile(color)}
</write>
</changes>

The header badge is ${color} now.`;
}

function taskApp(title: string, brief: string): string {
  // "<" is escaped so user text can never form a tag (e.g. "</write>") inside the stream.
  const briefLiteral = JSON.stringify(brief.trim().slice(0, 140) || 'A place to keep track of things to do.').replace(
    /</g,
    '\\u003c',
  );
  const titleLiteral = JSON.stringify(title);
  return `I'll build a clean task board you can add to, check off and filter, and save it in the browser so nothing is lost on refresh.

Files: \`src/types.ts\`, \`src/hooks/useTasks.ts\`, \`src/components/Header.tsx\`, \`src/components/TaskInput.tsx\`, \`src/components/FilterTabs.tsx\`, \`src/components/TaskItem.tsx\`, and \`src/pages/Home.tsx\`.

<changes>
<write path="src/types.ts">
export type Filter = 'all' | 'active' | 'done';

export interface Task {
  id: string;
  title: string;
  done: boolean;
  createdAt: number;
}
</write>

<write path="src/hooks/useTasks.ts">
import { useEffect, useState } from 'react';
import type { Task } from '../types';

const STORAGE_KEY = 'forge-tasks';

const STARTER: Task[] = [
  { id: 't1', title: 'Sketch the first screen', done: true, createdAt: 1 },
  { id: 't2', title: 'Invite the team', done: false, createdAt: 2 },
  { id: 't3', title: 'Ship something small today', done: false, createdAt: 3 },
];

function load(): Task[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Task[]) : STARTER;
  } catch (err) {
    console.log('[tasks] could not read saved tasks', err);
    return STARTER;
  }
}

// crypto.randomUUID needs a secure context; the preview is plain http.
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>(load);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    console.log('[tasks] saved', tasks.length);
  }, [tasks]);

  const add = (title: string) =>
    setTasks((prev) => [{ id: newId(), title, done: false, createdAt: Date.now() }, ...prev]);
  const toggle = (id: string) =>
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  const remove = (id: string) => setTasks((prev) => prev.filter((t) => t.id !== id));

  return { tasks, add, toggle, remove };
}
</write>

<write path="src/components/Header.tsx">
${headerFile('indigo')}
</write>

<write path="src/components/TaskInput.tsx">
import { useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';

export function TaskInput({ onAdd }: { onAdd: (title: string) => void }) {
  const [value, setValue] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const title = value.trim();
    if (!title) return;
    console.log('[tasks] add', title);
    onAdd(title);
    setValue('');
  };

  return (
    <form onSubmit={submit} className="flex gap-2">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="What needs doing?"
        className="flex-1 rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
      />
      <button
        type="submit"
        className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-500"
      >
        <Plus size={16} />
        Add
      </button>
    </form>
  );
}
</write>

<write path="src/components/FilterTabs.tsx">
import type { Filter } from '../types';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'done', label: 'Done' },
];

interface FilterTabsProps {
  value: Filter;
  onChange: (filter: Filter) => void;
}

export function FilterTabs({ value, onChange }: FilterTabsProps) {
  return (
    <div className="inline-flex rounded-lg bg-slate-100 p-1">
      {FILTERS.map((f) => (
        <button
          key={f.value}
          onClick={() => onChange(f.value)}
          className={
            'rounded-md px-3 py-1.5 text-xs font-medium transition ' +
            (value === f.value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700')
          }
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}
</write>

<write path="src/components/TaskItem.tsx">
import { Check, Trash2 } from 'lucide-react';
import type { Task } from '../types';

interface TaskItemProps {
  task: Task;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
}

export function TaskItem({ task, onToggle, onRemove }: TaskItemProps) {
  return (
    <li className="group flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3.5 py-3 shadow-sm">
      <button
        onClick={() => onToggle(task.id)}
        aria-label={task.done ? 'Mark as not done' : 'Mark as done'}
        className={
          'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition ' +
          (task.done ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-slate-300 hover:border-indigo-400')
        }
      >
        {task.done && <Check size={13} strokeWidth={3} />}
      </button>
      <span className={'flex-1 text-sm ' + (task.done ? 'text-slate-400 line-through' : 'text-slate-800')}>
        {task.title}
      </span>
      <button
        onClick={() => onRemove(task.id)}
        aria-label="Delete task"
        className="rounded-md p-1 text-slate-300 opacity-0 transition hover:text-rose-500 group-hover:opacity-100"
      >
        <Trash2 size={15} />
      </button>
    </li>
  );
}
</write>

<write path="src/pages/Home.tsx">
import { useState } from 'react';
import { Header } from '../components/Header';
import { TaskInput } from '../components/TaskInput';
import { FilterTabs } from '../components/FilterTabs';
import { TaskItem } from '../components/TaskItem';
import { useTasks } from '../hooks/useTasks';
import type { Filter } from '../types';

const TITLE = ${titleLiteral};
const BRIEF = ${briefLiteral};

export default function Home() {
  const { tasks, add, toggle, remove } = useTasks();
  const [filter, setFilter] = useState<Filter>('all');

  const visible = tasks.filter((t) => (filter === 'all' ? true : filter === 'done' ? t.done : !t.done));
  const remaining = tasks.filter((t) => !t.done).length;

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-indigo-50/40 px-6 py-12">
      <div className="mx-auto flex max-w-xl flex-col gap-6">
        <Header title={TITLE} brief={BRIEF} remaining={remaining} />
        <TaskInput onAdd={add} />
        <div className="flex items-center justify-between">
          <FilterTabs value={filter} onChange={setFilter} />
          <span className="text-xs text-slate-400">{tasks.length} total</span>
        </div>
        {visible.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-200 py-10 text-center text-sm text-slate-400">
            Nothing here yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {visible.map((task) => (
              <TaskItem key={task.id} task={task} onToggle={toggle} onRemove={remove} />
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
</write>
</changes>

Your ${title.toLowerCase()} app is ready — add tasks, tick them off and filter the list.`;
}
