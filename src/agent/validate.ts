import { CODE_FILE, importSpecifiers, isLucideExport, resolveImport } from './stream-fixer';

/**
 * Pre-execution gates (BUILD-PROMPT §9b), run after APPLY and before the
 * sandbox sees anything. Deterministic code, never a model call: each one
 * turns what would have been a repair turn into zero turns, and each leaves a
 * log line.
 *
 *   secrets       a key in app code ships to every visitor — the turn stops
 *   packages      every imported package exists on npm; a made-up one is
 *                 corrected when the fix is certain, never installed
 *   package-json  real packages the code imports are declared
 *   imports       every relative import points at a file that exists
 *   providers     query and router hooks have their provider in the tree
 *
 * The typecheck gate needs the sandbox's node_modules, so the loop runs it in
 * COLLECT; parseTypeErrors() reads its output.
 */

export type GateName = 'stream-fix' | 'secrets' | 'packages' | 'package-json' | 'imports' | 'providers' | 'typecheck';

export interface GateResult {
  gate: GateName;
  /** warn: something is off but the app is not blocked (a type error left in a working app). */
  status: 'pass' | 'fixed' | 'fail' | 'warn';
  detail: string;
}

/** A problem only the model can fix. Worded like the build error it would become, so diagnose() explains it. */
export interface Issue {
  message: string;
  file?: string;
}

export interface Validation {
  results: GateResult[];
  /** Files the gates rewrote: package.json, src/main.tsx, a corrected import. */
  changed: { path: string; content: string }[];
  /** Packages added to package.json, as name@range. */
  added: string[];
  issues: Issue[];
  /** Keys found in files this turn wrote: the turn must not run. */
  secrets: { path: string; label: string }[];
}

/** Looks a package up; null when the registry cannot be reached. */
export interface Registry {
  lookup(name: string): Promise<{ exists: boolean; latest?: string } | null>;
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

const KEY_PATTERNS: [RegExp, string][] = [
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/, 'an OpenAI or Anthropic API key'],
  [/\bsk_live_[0-9a-zA-Z]{24,}/, 'a Stripe live secret key'],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, 'a signed token (JWT), possibly a service key'],
  [/\bAIza[0-9A-Za-z_-]{35}/, 'a Google API key'],
  [/\bghp_[0-9a-zA-Z]{36}/, 'a GitHub token'],
  [/\bxox[baprs]-[0-9A-Za-z-]{10,}/, 'a Slack token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key'],
];

/** Kinds of secret found in text. */
export function scanForSecrets(text: string): string[] {
  return KEY_PATTERNS.filter(([re]) => re.test(text)).map(([, label]) => label);
}

/** The text with every secret replaced, safe to store. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, label] of KEY_PATTERNS) out = out.replace(new RegExp(re.source, 'g'), `[removed: ${label}]`);
  return out;
}

/** Why a message with a key in it is refused, for the person who sent it. */
export function secretRefusal(labels: string[]): string {
  return `Your message contains ${labels.join(' and ')}. Forge never sends keys to the AI or puts them in app code, where anyone using the app could read them. Remove it and send your message again — and if the key is real, consider replacing it.`;
}

// ---------------------------------------------------------------------------
// The npm registry, cached: package existence is the defence against made-up
// ("slopsquatted") names, which models invent often enough to be squatted.
// ---------------------------------------------------------------------------

type Lookup = { exists: boolean; latest?: string };
const g = globalThis as typeof globalThis & { __forgeRegistry?: Map<string, { at: number; value: Lookup }> };
const cache = (g.__forgeRegistry ??= new Map());

export const npmRegistry: Registry = {
  async lookup(name) {
    const hit = cache.get(name);
    if (hit && Date.now() - hit.at < 3_600_000) return hit.value;
    try {
      const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}/latest`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      const value: Lookup | null =
        res.status === 404 ? { exists: false } : res.ok ? { exists: true, latest: ((await res.json()) as { version?: string }).version } : null;
      if (value) cache.set(name, { at: Date.now(), value });
      return value;
    } catch {
      return null;
    }
  },
};

export function packageName(spec: string): string {
  return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
}

/** An npm package import, as opposed to a file, an alias, a URL or a Vite virtual module. */
function isPackage(spec: string): boolean {
  return !spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('@/') && !/^[a-z][\w+.-]*:/.test(spec);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A made-up package whose every import is a named import of real lucide
 * icons ("lucide-react-icons") is certainly meant to be lucide-react.
 */
function lucideStandIn(pkg: string, contents: string[]): string | null {
  const any = new RegExp(`from\\s*(['"])${escapeRe(pkg)}(?:/[^'"]*)?\\1`, 'g');
  const named = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*(['"])${escapeRe(pkg)}\\2`, 'g');
  let found = false;
  for (const content of contents) {
    const imports = [...content.matchAll(named)];
    if (imports.length !== [...content.matchAll(any)].length) return null;
    for (const m of imports) {
      const names = m[1]
        .split(',')
        .map((s) => s.trim().split(/\s+as\s+/)[0])
        .filter(Boolean);
      if (!names.length || !names.every(isLucideExport)) return null;
      found = true;
    }
  }
  return found ? 'lucide-react' : null;
}

function retarget(content: string, from: string, to: string): string {
  return content.replace(new RegExp(`(from\\s*)(['"])${escapeRe(from)}\\2`, 'g'), `$1$2${to}$2`);
}

/** The template's main.tsx, keeping any extra side-effect imports (e.g. a stylesheet) the current one adds. */
function restoreMain(current: string | undefined, templateMain: string): string {
  const sideEffect = /^import\s+['"][^'"]+['"];?\s*$/;
  const extra = (current ?? '').split('\n').filter((l) => sideEffect.test(l.trim()) && !templateMain.includes(l.trim()));
  if (!extra.length) return templateMain;
  const lines = templateMain.split('\n');
  const lastImport = lines.map((l) => l.startsWith('import ')).lastIndexOf(true);
  lines.splice(lastImport + 1, 0, ...extra);
  return lines.join('\n');
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export async function validateProject(input: {
  /** Every project file after APPLY. */
  files: { path: string; content: string }[];
  /** Paths written in this turn. */
  written: string[];
  registry: Registry;
  /** docker/template/src/main.tsx, used to restore missing providers. */
  templateMain?: string;
}): Promise<Validation> {
  const results: GateResult[] = [];
  const current = new Map(input.files.map((f) => [f.path, f.content]));
  const changed = new Map<string, string>();
  const content = (p: string) => changed.get(p) ?? current.get(p) ?? '';
  const paths = new Set(current.keys());
  const code = [...paths].filter((p) => p.startsWith('src/') && CODE_FILE.test(p)).sort();
  const issues: Issue[] = [];

  // secrets — only what this turn wrote; older files were checked when written
  const secrets = input.written.flatMap((p) => scanForSecrets(current.get(p) ?? '').map((label) => ({ path: p, label })));
  if (secrets.length) {
    results.push({ gate: 'secrets', status: 'fail', detail: secrets.map((s) => `${s.path}: ${s.label}`).join('; ') });
    return { results, changed: [], added: [], issues, secrets };
  }
  results.push({ gate: 'secrets', status: 'pass', detail: `${plural(input.written.length, 'written file')} checked` });

  // packages + package-json
  const pkg = JSON.parse(current.get('package.json') ?? '{}') as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
  const importers = new Map<string, string[]>();
  for (const p of code) {
    for (const spec of importSpecifiers(content(p))) {
      if (!isPackage(spec)) continue;
      const name = packageName(spec);
      if (declared.has(name)) continue;
      const list = importers.get(name) ?? [];
      if (!list.includes(p)) list.push(p);
      importers.set(name, list);
    }
  }
  const added: string[] = [];
  const corrected: string[] = [];
  const unchecked: string[] = [];
  const madeUp: string[] = [];
  for (const [name, users] of importers) {
    const found = await input.registry.lookup(name);
    if (found === null) {
      unchecked.push(name); // registry unreachable: the build check will tell
    } else if (found.exists) {
      const range = found.latest ? `^${found.latest}` : 'latest';
      pkg.dependencies = { ...(pkg.dependencies ?? {}), [name]: range };
      added.push(`${name}@${range}`);
    } else {
      const replacement = lucideStandIn(name, users.map(content));
      if (replacement) {
        for (const p of users) changed.set(p, retarget(content(p), name, replacement));
        corrected.push(`${name} (does not exist) → ${replacement}`);
      } else {
        madeUp.push(name);
        issues.push({ message: `Package "${name}" does not exist on npm (imported by ${users.join(', ')}).`, file: users[0] });
      }
    }
  }
  if (added.length) changed.set('package.json', JSON.stringify(pkg, null, 2) + '\n');
  results.push({
    gate: 'packages',
    status: madeUp.length ? 'fail' : corrected.length ? 'fixed' : 'pass',
    detail: madeUp.length
      ? `not on npm: ${madeUp.join(', ')}`
      : corrected.length
        ? corrected.join('; ')
        : unchecked.length
          ? `npm unreachable, not checked: ${unchecked.join(', ')}`
          : 'every package exists',
  });
  results.push({
    gate: 'package-json',
    status: added.length ? 'fixed' : 'pass',
    detail: added.length ? `added ${added.join(', ')}` : 'every imported package is declared',
  });

  // imports — after the corrections above
  let checked = 0;
  const unresolved: Issue[] = [];
  for (const p of code) {
    for (const spec of importSpecifiers(content(p))) {
      if (!spec.startsWith('.') && !spec.startsWith('@/')) continue;
      checked++;
      const target = spec.startsWith('@/') ? resolveImport('src/index.ts', `./${spec.slice(2)}`, paths) : resolveImport(p, spec, paths);
      // Vite's own wording, so the diagnosis and the repair budget treat it like the build error it would be.
      if (!target) unresolved.push({ message: `Failed to resolve import "${spec}" from "${p}". Does the file exist?`, file: p });
    }
  }
  issues.push(...unresolved.slice(0, 10));
  results.push({
    gate: 'imports',
    status: unresolved.length ? 'fail' : 'pass',
    detail: unresolved.length ? `missing: ${unresolved.map((u) => u.message.match(/"(.+?)"/)?.[1]).join(', ')}` : `${plural(checked, 'import')} resolve`,
  });

  // providers — the template wraps the app in both; a rewritten main.tsx can lose them
  const anyFile = (re: RegExp) => code.some((p) => re.test(content(p)));
  const missing = [
    anyFile(/\buse(?:Query|Mutation|QueryClient|InfiniteQuery|SuspenseQuery|IsFetching)\s*[<(]/) && !anyFile(/<QueryClientProvider\b/) && 'QueryClientProvider',
    anyFile(/\buse(?:Navigate|Params|Location|SearchParams|Match|Routes|OutletContext)\s*[<(]|<(?:Link|NavLink|Routes|Route|Navigate|Outlet)\b/) &&
      !anyFile(/<(?:BrowserRouter|HashRouter|MemoryRouter|RouterProvider)\b/) &&
      'BrowserRouter',
  ].filter((x): x is string => typeof x === 'string');
  if (missing.length && input.templateMain) {
    changed.set('src/main.tsx', restoreMain(current.get('src/main.tsx'), input.templateMain));
    results.push({ gate: 'providers', status: 'fixed', detail: `restored ${missing.join(' and ')} in src/main.tsx` });
  } else if (missing.length) {
    // The runtime errors these would cause, which diagnose() already explains.
    if (missing.includes('QueryClientProvider')) issues.push({ message: 'No QueryClient set, use QueryClientProvider to set one', file: 'src/main.tsx' });
    if (missing.includes('BrowserRouter')) issues.push({ message: 'useNavigate() may be used only in the context of a <Router> component.', file: 'src/main.tsx' });
    results.push({ gate: 'providers', status: 'fail', detail: `missing ${missing.join(' and ')}` });
  } else {
    results.push({ gate: 'providers', status: 'pass', detail: 'providers in place' });
  }

  return { results, changed: [...changed].map(([path, c]) => ({ path, content: c })), added, issues, secrets: [] };
}

// ---------------------------------------------------------------------------
// Typecheck (run in the sandbox by the loop)
// ---------------------------------------------------------------------------

/**
 * The template's `npm run typecheck`, called directly: niced so the dev server
 * serving the preview keeps the CPU, incremental so later turns are fast.
 */
export const TYPECHECK_COMMAND =
  'nice -n 15 ./node_modules/.bin/tsc --noEmit --pretty false --incremental --tsBuildInfoFile /tmp/forge-typecheck.tsbuildinfo';

export interface TypeErrorLine {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
}

/** `src/App.tsx(12,5): error TS2322: Type 'string' is not assignable…` lines, for app files only. */
export function parseTypeErrors(output: string): TypeErrorLine[] {
  return [...output.matchAll(/^(src\/[^\s(]+)\((\d+),(\d+)\): error (TS\d+): (.+)$/gm)].map((m) => ({
    file: m[1],
    line: Number(m[2]),
    column: Number(m[3]),
    code: m[4],
    message: m[5].trim(),
  }));
}
