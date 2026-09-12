import { describe, expect, it } from 'vitest';
import { diagnose } from './diagnose';
import { parseTypeErrors, redactSecrets, scanForSecrets, validateProject, type Registry } from './validate';

/** A registry that knows a fixed set of packages; `null` entries do not exist. Anything else is "unreachable". */
const registry = (known: Record<string, string | null>): Registry => ({
  async lookup(name) {
    if (!(name in known)) return null;
    const latest = known[name];
    return latest === null ? { exists: false } : { exists: true, latest };
  },
});

const PKG = JSON.stringify({ dependencies: { react: '18.3.1', 'lucide-react': '0.446.0', '@tanstack/react-query': '5.59.0' } });
const MAIN = `import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';

root.render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);
`;

const project = (files: Record<string, string>) =>
  Object.entries({ 'package.json': PKG, 'src/main.tsx': MAIN, ...files }).map(([path, content]) => ({ path, content }));

const gate = (v: Awaited<ReturnType<typeof validateProject>>, name: string) => v.results.find((r) => r.gate === name);

describe('validateProject', () => {
  it('declares a real package the code imports but forgot to add', async () => {
    const v = await validateProject({
      files: project({ 'src/App.tsx': "import { format } from 'date-fns';\nexport default () => format(new Date(), 'PP');\n" }),
      written: ['src/App.tsx'],
      registry: registry({ 'date-fns': '4.4.0' }),
    });
    expect(gate(v, 'package-json')).toMatchObject({ status: 'fixed', detail: 'added date-fns@^4.4.0' });
    const pkg = JSON.parse(v.changed.find((c) => c.path === 'package.json')!.content);
    expect(pkg.dependencies['date-fns']).toBe('^4.4.0');
    expect(v.issues).toEqual([]);
  });

  it('retargets a made-up icon package to lucide-react when every import is a real icon', async () => {
    const v = await validateProject({
      files: project({ 'src/App.tsx': "import { TrendingUp } from 'lucide-react-icons';\nexport default () => <TrendingUp />;\n" }),
      written: ['src/App.tsx'],
      registry: registry({ 'lucide-react-icons': null }),
    });
    expect(gate(v, 'packages')).toMatchObject({ status: 'fixed', detail: 'lucide-react-icons (does not exist) → lucide-react' });
    expect(v.changed.find((c) => c.path === 'src/App.tsx')!.content).toContain("from 'lucide-react'");
    expect(v.changed.some((c) => c.path === 'package.json')).toBe(false);
  });

  it('reports a made-up package it cannot correct, and never adds it', async () => {
    const v = await validateProject({
      files: project({ 'src/App.tsx': "import { makeChart } from 'react-super-charts';\n" }),
      written: ['src/App.tsx'],
      registry: registry({ 'react-super-charts': null }),
    });
    expect(gate(v, 'packages')).toMatchObject({ status: 'fail', detail: 'not on npm: react-super-charts' });
    expect(v.issues[0]).toMatchObject({ message: expect.stringMatching(/"react-super-charts" does not exist on npm/), file: 'src/App.tsx' });
    expect(v.changed).toEqual([]);
  });

  it('leaves packages alone when the registry cannot be reached', async () => {
    const v = await validateProject({
      files: project({ 'src/App.tsx': "import x from 'some-package';\n" }),
      written: ['src/App.tsx'],
      registry: registry({}),
    });
    expect(gate(v, 'packages')?.detail).toMatch(/not checked: some-package/);
    expect(v.issues).toEqual([]);
  });

  it('flags imports of files that do not exist', async () => {
    const v = await validateProject({
      files: project({ 'src/App.tsx': "import Nav from './components/Nav';\n" }),
      written: ['src/App.tsx'],
      registry: registry({}),
    });
    expect(gate(v, 'imports')).toMatchObject({ status: 'fail', detail: 'missing: ./components/Nav' });
    expect(v.issues).toEqual([{ message: 'Failed to resolve import "./components/Nav" from "src/App.tsx". Does the file exist?', file: 'src/App.tsx' }]);
    // Worded like Vite's build error, so the diagnosis table explains it.
    expect(diagnose(v.issues[0].message)?.action).toBe('fixing the import of ./components/Nav');
  });

  it('reports a missing provider as the runtime error it would cause when main.tsx cannot be restored', async () => {
    const v = await validateProject({
      files: project({
        'src/main.tsx': "import App from './App';\nroot.render(<App />);\n",
        'src/App.tsx': "import { useNavigate } from 'react-router-dom';\nexport default function App() { useNavigate(); return null; }\n",
      }),
      written: ['src/App.tsx'],
      registry: registry({ 'react-router-dom': '6.26.2' }),
    });
    expect(gate(v, 'providers')).toMatchObject({ status: 'fail', detail: 'missing BrowserRouter' });
    expect(diagnose(v.issues[v.issues.length - 1].message)?.action).toBe('wrapping the app in the router');
  });

  it('restores a provider a rewritten main.tsx dropped', async () => {
    const v = await validateProject({
      files: project({
        'src/main.tsx': "import App from './App';\nimport './theme.css';\nroot.render(<App />);\n",
        'src/App.tsx': "import { useQuery } from '@tanstack/react-query';\nexport default function App() { useQuery({ queryKey: ['x'], queryFn: () => 1 }); return null; }\n",
        'src/theme.css': '',
      }),
      written: ['src/main.tsx', 'src/App.tsx'],
      registry: registry({}),
      templateMain: MAIN,
    });
    expect(gate(v, 'providers')).toMatchObject({ status: 'fixed', detail: 'restored QueryClientProvider in src/main.tsx' });
    const main = v.changed.find((c) => c.path === 'src/main.tsx')!.content;
    expect(main).toContain('<QueryClientProvider');
    expect(main).toContain("import './theme.css';");
  });

  it('stops at a secret in code the turn wrote', async () => {
    const v = await validateProject({
      files: project({ 'src/lib/pay.ts': "export const key = 'sk_live_" + 'a'.repeat(30) + "';\n" }),
      written: ['src/lib/pay.ts'],
      registry: registry({}),
    });
    expect(v.secrets).toEqual([{ path: 'src/lib/pay.ts', label: 'a Stripe live secret key' }]);
    expect(gate(v, 'secrets')?.status).toBe('fail');
  });

  it('passes a clean project with one log line per gate', async () => {
    const v = await validateProject({ files: project({ 'src/App.tsx': "import './index.css';\n", 'src/index.css': '' }), written: [], registry: registry({}) });
    expect(v.results.map((r) => [r.gate, r.status])).toEqual([
      ['secrets', 'pass'],
      ['data-model', 'pass'],
      ['packages', 'pass'],
      ['package-json', 'pass'],
      ['imports', 'pass'],
      ['providers', 'pass'],
    ]);
  });
});

describe('parseTypeErrors', () => {
  it('reads app errors from tsc output and skips the rest', () => {
    const out = [
      "src/pages/Home.tsx(21,18): error TS18048: 'data' is possibly 'undefined'.",
      "  Some continuation line that belongs to the error above.",
      "vite.config.ts(3,1): error TS2307: Cannot find module 'x'.",
      'src/lib/format.ts(4,10): error TS2305: Module "date-fns" has no exported member \'formatt\'.',
    ].join('\n');
    expect(parseTypeErrors(out)).toEqual([
      { file: 'src/pages/Home.tsx', line: 21, column: 18, code: 'TS18048', message: "'data' is possibly 'undefined'." },
      { file: 'src/lib/format.ts', line: 4, column: 10, code: 'TS2305', message: 'Module "date-fns" has no exported member \'formatt\'.' },
    ]);
    expect(diagnose("TS18048: 'data' is possibly 'undefined'.")?.action).toBe('guarding "data" before it is used');
  });
});

describe('secrets in chat messages', () => {
  it('finds and removes keys', () => {
    const text = 'my key is AIza' + 'B'.repeat(35) + ' please use it';
    expect(scanForSecrets(text)).toEqual(['a Google API key']);
    expect(redactSecrets(text)).toBe('my key is [removed: a Google API key] please use it');
    expect(scanForSecrets('build me a todo app')).toEqual([]);
  });
});
