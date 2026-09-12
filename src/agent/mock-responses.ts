import path from 'node:path';
import type { ModelRequest } from './providers';

/**
 * Canned model output for PROVIDER=mock. It exercises the real pipeline —
 * streaming parse, stream fixer, file writes, edits, validation gates,
 * checkpoints, sandbox sync, preview and the repair loop — with no API key.
 *
 * - A first build request: a small task app, titled from the user's words.
 * - A follow-up request: one demo change sent as an <edit> (the header badge
 *   swaps colour), or the whole file if the loop reports it could not be placed.
 * - A request mentioning "data.map" or rendering before the data loads: a
 *   recipe list that crashes on its first render, and a real fix when the
 *   repair loop asks. With "unfixable" in the request, the fixes never work,
 *   which exercises the repair budget.
 * - A request for a "dashboard" or "invoices": an invoice dashboard written
 *   with the mistakes models really make — an invented icon, an "@/" import,
 *   an import one folder off, an undeclared package and a made-up one. The
 *   stream fixer and the gates correct all five with no second model call.
 *   With "sidebar" it also imports a component it never writes, which only
 *   the model can fix: one more pass creates it.
 * - A request to hard-code a key: code containing one, which the secrets gate
 *   stops.
 * - A request mentioning sign-in, accounts, saving or a database: a task list
 *   with a real backend — an <entity> with no access rules (Forge fills in
 *   private-by-default) and pages built on the generated client. With
 *   "shared" or "everyone" the tasks are readable by any signed-in user
 *   instead, which is what a deliberate choice looks like.
 */
export function mockResponse(req: ModelRequest): string {
  const last = req.messages[req.messages.length - 1]?.content ?? '';
  if (/^ERROR TYPE: /m.test(last)) return repair(req.context, last);
  if (SECRET_REQUEST.test(last)) return paymentsWithKey();
  if (BREAKING_REQUEST.test(last)) return recipeApp(/unfixable/i.test(last));
  if (DASHBOARD_REQUEST.test(last)) return dashboardApp(/sidebar/i.test(last));
  if (BACKEND_REQUEST.test(last)) return savedTasksApp(SHARED_REQUEST.test(last));
  if (req.context.includes('src/hooks/useTasks.ts')) {
    const color: Badge = req.context.includes(`rounded-xl ${BADGE.rose}`) ? 'indigo' : 'rose';
    return /could not be placed exactly/.test(last) ? headerRewrite(color) : headerEdit(color);
  }
  return taskApp(titleFrom(last), last);
}

const BREAKING_REQUEST = /data\.map|before the (?:fetch|data)|unfixable/i;
const DASHBOARD_REQUEST = /dashboard|invoice/i;
const BACKEND_REQUEST = /\b(sign ?-?in|sign ?-?up|log ?-?in|account|accounts|users|their own|my own|private|saved?|stores?|storage|database|back ?end)\b/i;
const SHARED_REQUEST = /\b(shared|share|everyone|together|team board|whole team)\b/i;
const SECRET_REQUEST = /hard-?cod(?:e|ed|ing)\b[^.]*\bkey\b/i;
const UNFIXABLE_MARK = '// forge-mock: unfixable';

/** A fix prompt (diagnose.ts buildFixPrompt): repair the demo failures it knows. */
function repair(context: string, prompt: string): string {
  const missing = prompt.match(/Failed to resolve import "(.+?)" from "(.+?)"/);
  if (missing) return createMissing(missing[1], missing[2]);
  if (/reading 'map'/.test(prompt)) return recipeRepair(context);
  return "I'm the offline mock model: I can only repair the demo crashes.";
}

const RECIPES_LIB = `export interface Recipe {
  id: string;
  title: string;
  minutes: number;
  tag: string;
}

const RECIPES: Recipe[] = [
  { id: 'r1', title: 'Lemon orzo with dill', minutes: 22, tag: 'vegetarian' },
  { id: 'r2', title: 'Charred cabbage steaks', minutes: 28, tag: 'one pot' },
  { id: 'r3', title: 'Miso butter noodles', minutes: 15, tag: 'vegetarian' },
  { id: 'r4', title: 'Tomato galette', minutes: 55, tag: 'baking' },
];

/** Stands in for a real API: the data arrives a moment after the first render. */
export function fetchRecipes(): Promise<Recipe[]> {
  console.log('[recipes] loading');
  return new Promise((resolve) => setTimeout(() => resolve(RECIPES), 600));
}`;

const RECIPE_CARD = `import { Clock } from 'lucide-react';
import type { Recipe } from '../lib/recipes';

export function RecipeCard({ recipe }: { recipe: Recipe }) {
  return (
    <article className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
      <div className="h-24 bg-gradient-to-br from-amber-100 to-orange-100" />
      <div className="flex flex-col gap-1.5 p-4">
        <h2 className="font-semibold text-stone-900">{recipe.title}</h2>
        <p className="flex items-center gap-1.5 text-xs text-stone-500">
          <Clock size={13} />
          {recipe.minutes} min · {recipe.tag}
        </p>
      </div>
    </article>
  );
}`;

/**
 * The recipes page. "broken" maps over data that has not loaded yet (the
 * classic first-render crash); "stubborn" only asserts it away, so it still
 * crashes; "guarded" waits for the data.
 */
function recipeHome(variant: 'broken' | 'stubborn' | 'guarded', unfixable: boolean): string {
  const list =
    variant === 'guarded'
      ? `        {isLoading ? (
          <p className="mt-6 text-sm text-stone-500">Loading recipes…</p>
        ) : (
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {(data ?? []).map((recipe) => (
              <RecipeCard key={recipe.id} recipe={recipe} />
            ))}
          </div>
        )}`
      : `        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {${variant === 'stubborn' ? 'data!' : 'data'}.map((recipe) => (
            <RecipeCard key={recipe.id} recipe={recipe} />
          ))}
        </div>`;
  return `import { useQuery } from '@tanstack/react-query';
import { RecipeCard } from '../components/RecipeCard';
import { fetchRecipes, type Recipe } from '../lib/recipes';
${unfixable ? `${UNFIXABLE_MARK}\n` : ''}
export default function Home() {
  const { data, isLoading } = useQuery<Recipe[]>({ queryKey: ['recipes'], queryFn: fetchRecipes });
  console.log('[recipes] render, loading:', isLoading);

  return (
    <main className="min-h-screen bg-amber-50/50 px-6 py-12">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight text-stone-900">Recipe Box</h1>
        <p className="mt-1 text-sm text-stone-500">Quick dinners, sorted by cook time.</p>
${list}
      </div>
    </main>
  );
}`;
}

function recipeApp(unfixable: boolean): string {
  return `I'll build a recipe list that loads your recipes and shows each one as a card.

<changes>
<write path="src/lib/recipes.ts">
${RECIPES_LIB}
</write>
<write path="src/components/RecipeCard.tsx">
${RECIPE_CARD}
</write>
<write path="src/pages/Home.tsx">
${recipeHome('broken', unfixable)}
</write>
</changes>

Your recipes now show as cards with their cook times.`;
}

function recipeRepair(context: string): string {
  const unfixable = context.includes(UNFIXABLE_MARK);
  return `${unfixable ? 'Telling TypeScript the data is there before the list renders.' : 'Adding a loading state so the list waits for the data.'}

<changes>
<write path="src/pages/Home.tsx">
${recipeHome(unfixable ? 'stubborn' : 'guarded', unfixable)}
</write>
</changes>

${unfixable ? 'The list renders the data directly.' : 'The recipes page shows a loading message until the data arrives.'}`;
}

// ---------------------------------------------------------------------------
// Invoice dashboard (M3). Each file carries one of the mistakes models make.
// ---------------------------------------------------------------------------

const INVOICES_LIB = `export type InvoiceStatus = 'paid' | 'open' | 'overdue';

export interface Invoice {
  id: string;
  client: string;
  amount: number;
  due: string;
  status: InvoiceStatus;
}

export const INVOICES: Invoice[] = [
  { id: 'INV-1042', client: 'Northwind Studio', amount: 4200, due: '2026-09-02', status: 'paid' },
  { id: 'INV-1043', client: 'Kestrel & Co', amount: 1850, due: '2026-09-18', status: 'open' },
  { id: 'INV-1044', client: 'Blue Harbor Cafe', amount: 640, due: '2026-08-28', status: 'overdue' },
  { id: 'INV-1045', client: 'Aster Health', amount: 9300, due: '2026-09-30', status: 'open' },
  { id: 'INV-1046', client: 'Lumen Books', amount: 1275, due: '2026-09-05', status: 'paid' },
];`;

// Mistake: date-fns is a real package, but it is not in package.json.
const FORMAT_LIB = `import { format } from 'date-fns';

export function formatMoney(amount: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amount);
}

export function formatDate(iso: string): string {
  return format(new Date(iso), 'd MMM yyyy');
}`;

const STATUS_BADGE = `import type { InvoiceStatus } from '../lib/invoices';

const STYLES: Record<InvoiceStatus, string> = {
  paid: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  open: 'bg-sky-50 text-sky-700 ring-sky-200',
  overdue: 'bg-rose-50 text-rose-700 ring-rose-200',
};

export function StatusBadge({ status }: { status: InvoiceStatus }) {
  return (
    <span className={'inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset ' + STYLES[status]}>
      {status}
    </span>
  );
}`;

// Mistake: "./lib/format" from src/components — one folder off.
const INVOICE_TABLE = `import type { Invoice } from '../lib/invoices';
import { formatDate, formatMoney } from './lib/format';
import { StatusBadge } from './StatusBadge';

export function InvoiceTable({ invoices }: { invoices: Invoice[] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2.5 font-medium">Invoice</th>
            <th className="px-4 py-2.5 font-medium">Client</th>
            <th className="px-4 py-2.5 font-medium">Due</th>
            <th className="px-4 py-2.5 text-right font-medium">Amount</th>
            <th className="px-4 py-2.5 font-medium">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {invoices.map((invoice) => (
            <tr key={invoice.id} className="text-slate-700">
              <td className="px-4 py-3 font-mono text-xs text-slate-500">{invoice.id}</td>
              <td className="px-4 py-3 font-medium text-slate-900">{invoice.client}</td>
              <td className="px-4 py-3">{formatDate(invoice.due)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{formatMoney(invoice.amount)}</td>
              <td className="px-4 py-3">
                <StatusBadge status={invoice.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}`;

// Mistake: "lucide-react-icons" does not exist on npm; every name imported from it is a real lucide icon.
const STAT_CARD = `import { ArrowUpRight, TriangleAlert } from 'lucide-react-icons';

interface StatCardProps {
  label: string;
  value: string;
  hint: string;
  tone?: 'default' | 'alert';
}

export function StatCard({ label, value, hint, tone = 'default' }: StatCardProps) {
  const Icon = tone === 'alert' ? TriangleAlert : ArrowUpRight;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={'mt-2 text-2xl font-semibold ' + (tone === 'alert' ? 'text-rose-600' : 'text-slate-900')}>{value}</p>
      <p className="mt-1 flex items-center gap-1 text-xs text-slate-500">
        <Icon size={13} />
        {hint}
      </p>
    </div>
  );
}`;

const SIDEBAR = `import { FileText, LayoutDashboard, Settings, Users } from 'lucide-react';

const LINKS = [
  { label: 'Overview', icon: LayoutDashboard, active: true },
  { label: 'Invoices', icon: FileText, active: false },
  { label: 'Clients', icon: Users, active: false },
  { label: 'Settings', icon: Settings, active: false },
];

export function Sidebar() {
  return (
    <aside className="hidden w-52 shrink-0 flex-col gap-1 border-r border-slate-200 bg-white p-4 sm:flex">
      <p className="px-2 pb-3 text-sm font-semibold text-slate-900">Ledgerly</p>
      {LINKS.map(({ label, icon: Icon, active }) => (
        <a
          key={label}
          href="#"
          className={'flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ' + (active ? 'bg-slate-100 font-medium text-slate-900' : 'text-slate-500 hover:text-slate-800')}
        >
          <Icon size={15} />
          {label}
        </a>
      ))}
    </aside>
  );
}`;

// Mistakes: "LayoutDashbaord" is not an icon, and "@/" has no alias in the template's Vite config.
function dashboardHome(sidebar: boolean): string {
  return `import { LayoutDashbaord, Plus } from 'lucide-react';
import { InvoiceTable } from '@/components/InvoiceTable';
${sidebar ? "import { Sidebar } from '../components/Sidebar';\n" : ''}import { StatCard } from '../components/StatCard';
import { formatMoney } from '../lib/format';
import { INVOICES, type Invoice } from '../lib/invoices';

const total = (list: Invoice[]) => list.reduce((sum, invoice) => sum + invoice.amount, 0);

export default function Home() {
  const open = INVOICES.filter((i) => i.status !== 'paid');
  const paid = INVOICES.filter((i) => i.status === 'paid');
  const overdue = INVOICES.filter((i) => i.status === 'overdue');
  console.log('[invoices] render', INVOICES.length, 'invoices');

  return (
    <div className="flex min-h-screen bg-slate-50">
${sidebar ? '      <Sidebar />\n' : ''}      <main className="flex-1 px-6 py-10">
        <div className="mx-auto flex max-w-4xl flex-col gap-6">
          <header className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white">
              <LayoutDashbaord size={20} />
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="text-xl font-semibold tracking-tight text-slate-900">Invoices</h1>
              <p className="text-sm text-slate-500">What is owed, what is paid and what is late.</p>
            </div>
            <button className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-slate-700">
              <Plus size={15} />
              New invoice
            </button>
          </header>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="Outstanding" value={formatMoney(total(open))} hint={open.length + ' open invoices'} />
            <StatCard label="Paid" value={formatMoney(total(paid))} hint={paid.length + ' settled this month'} />
            <StatCard label="Overdue" value={formatMoney(total(overdue))} hint={overdue.length + ' past the due date'} tone="alert" />
          </div>
          <InvoiceTable invoices={INVOICES} />
        </div>
      </main>
    </div>
  );
}`;
}

function dashboardApp(sidebar: boolean): string {
  return `I'll build an invoice dashboard: totals for what is outstanding, paid and overdue at the top, and every invoice with its status below.

<changes>
<write path="src/pages/Home.tsx">
${dashboardHome(sidebar)}
</write>
<write path="src/components/InvoiceTable.tsx">
${INVOICE_TABLE}
</write>
<write path="src/components/StatusBadge.tsx">
${STATUS_BADGE}
</write>
<write path="src/components/StatCard.tsx">
${STAT_CARD}
</write>
<write path="src/lib/format.ts">
${FORMAT_LIB}
</write>
<write path="src/lib/invoices.ts">
${INVOICES_LIB}
</write>
</changes>

Your invoice dashboard is ready — totals at the top, every invoice below.`;
}

// ---------------------------------------------------------------------------
// Saved tasks with sign-in (M4): the model declares what to store and who may
// see it; Forge generates src/forge/*, so none of that is written here.
// ---------------------------------------------------------------------------

const TASK_COMPOSER = `import { useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';

export function TaskComposer({ onAdd, busy }: { onAdd: (title: string) => void; busy: boolean }) {
  const [title, setTitle] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = title.trim();
    if (!value) return;
    console.log('[tasks] add', value);
    onAdd(value);
    setTitle('');
  };

  return (
    <form onSubmit={submit} className="flex gap-2">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="What needs doing?"
        className="flex-1 rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-indigo-400"
      />
      <button
        type="submit"
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-500 disabled:opacity-60"
      >
        <Plus size={16} />
        Add
      </button>
    </form>
  );
}`;

const TASK_ROW = `import { Check, Trash2 } from 'lucide-react';
import type { Task } from '../forge/data';

interface TaskRowProps {
  task: Task;
  onToggle: () => void;
  onRemove: () => void;
}

export function TaskRow({ task, onToggle, onRemove }: TaskRowProps) {
  return (
    <li className="group flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3.5 py-3 shadow-sm">
      <button
        onClick={onToggle}
        aria-label={task.done ? 'Mark as not done' : 'Mark as done'}
        className={
          'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition ' +
          (task.done ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-slate-300 hover:border-indigo-400')
        }
      >
        {task.done && <Check size={13} strokeWidth={3} />}
      </button>
      <span className={'flex-1 text-sm ' + (task.done ? 'text-slate-400 line-through' : 'text-slate-800')}>{task.title}</span>
      <button
        onClick={onRemove}
        aria-label="Delete task"
        className="rounded-md p-1 text-slate-300 opacity-0 transition hover:text-rose-500 group-hover:opacity-100"
      >
        <Trash2 size={15} />
      </button>
    </li>
  );
}`;

function savedTasksHome(shared: boolean): string {
  return `import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import { TaskComposer } from '../components/TaskComposer';
import { TaskRow } from '../components/TaskRow';
import { RequireSignIn, useUser } from '../forge/auth';
import { Task } from '../forge/data';

export default function Home() {
  return (
    <RequireSignIn title="Your tasks" description="Sign in with your email and your list follows you anywhere.">
      <TaskList />
    </RequireSignIn>
  );
}

function TaskList() {
  const { user, signOut } = useUser();
  const client = useQueryClient();
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: () => Task.list({ sort: '-createdAt' }) });
  const refresh = () => client.invalidateQueries({ queryKey: ['tasks'] });
  const add = useMutation({ mutationFn: (title: string) => Task.create({ title }), onSuccess: refresh });
  const toggle = useMutation({ mutationFn: (task: Task) => Task.update(task.id, { done: !task.done }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => Task.remove(id), onSuccess: refresh });
  const rows = tasks.data ?? [];
  console.log('[tasks] showing', rows.length, 'tasks for', user?.email);

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-indigo-50/40 px-6 py-12">
      <div className="mx-auto flex max-w-xl flex-col gap-6">
        <header className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">${shared ? 'Team tasks' : 'Your tasks'}</h1>
            <p className="mt-1 text-sm text-slate-500">
              ${shared ? 'Everyone signed in sees the same list.' : 'Saved to your account — only you can see them.'}
            </p>
          </div>
          <button
            onClick={() => void signOut()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 transition hover:border-slate-300"
          >
            <LogOut size={13} />
            {user?.email}
          </button>
        </header>
        <TaskComposer onAdd={(title) => add.mutate(title)} busy={add.isPending} />
        {tasks.isLoading ? (
          <p className="text-sm text-slate-500">Loading your tasks…</p>
        ) : rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-200 py-10 text-center text-sm text-slate-400">Nothing here yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((task) => (
              <TaskRow key={task.id} task={task} onToggle={() => toggle.mutate(task)} onRemove={() => remove.mutate(task.id)} />
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}`;
}

/**
 * The default leaves "access" out entirely, so the data-model gate fills in
 * private-by-default and says so; "shared" asks for the deliberate opposite.
 */
function savedTasksApp(shared: boolean): string {
  const entity = shared
    ? `{
  "name": "Task",
  "fields": {
    "title": { "type": "string", "required": true },
    "done": { "type": "boolean", "default": false }
  },
  "access": { "read": "user", "create": "user", "update": "owner", "delete": "owner" }
}`
    : `{
  "name": "Task",
  "fields": {
    "title": { "type": "string", "required": true },
    "done": { "type": "boolean", "default": false }
  }
}`;
  return `I'll save the tasks to an account, so they are still there on the next visit${shared ? ' and everyone signed in sees the same list' : ' and only the person who wrote them can see them'}.

<changes>
<entity name="Task">
${entity}
</entity>
<write path="src/components/TaskComposer.tsx">
${TASK_COMPOSER}
</write>
<write path="src/components/TaskRow.tsx">
${TASK_ROW}
</write>
<write path="src/pages/Home.tsx">
${savedTasksHome(shared)}
</write>
</changes>

Sign in with your email and your tasks are saved${shared ? ' for the whole team' : ' to your account'}.`;
}

/** The repair for "Failed to resolve import": write the file that was imported but never created. */
function createMissing(spec: string, from: string): string {
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)) + '.tsx';
  const name = path.posix.basename(spec).replace(/[^A-Za-z0-9]/g, '') || 'Section';
  const content =
    name === 'Sidebar'
      ? SIDEBAR
      : `export function ${name}() {\n  return <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">${name}</section>;\n}`;
  return `${target} was imported but never written — adding it.

<changes>
<write path="${target}">
${content}
</write>
</changes>

Added the missing ${name}.`;
}

/** Code with a key in it, for the secrets gate. Built at runtime so no key-shaped string sits in this source. */
function paymentsWithKey(): string {
  const key = ['sk', 'live', 'forgeDemo' + '0'.repeat(16)].join('_');
  return `I'll add checkout with your Stripe key.

<changes>
<write path="src/lib/payments.ts">
const STRIPE_SECRET_KEY = '${key}';

export async function startCheckout(amount: number): Promise<void> {
  console.log('[payments] checkout', amount, STRIPE_SECRET_KEY.length);
}
</write>
</changes>

Checkout now uses your Stripe key.`;
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
