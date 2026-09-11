import path from 'node:path';
import ICON_LIST from './lucide-icons.json';

/**
 * Stream fixer (BUILD-PROMPT §9a): deterministic corrections for mistakes
 * models make predictably, applied to each streamed file before it is written.
 * Every rule turns a would-be repair turn into zero turns — when the logs show
 * the model inventing something new, add a rule instead of a retry.
 *
 *   icon    an invented lucide-react icon becomes the nearest real one
 *   alias   "@/x" becomes a relative path: tsconfig knows the alias, but the
 *           template's Vite config does not, so it could never resolve
 *   path    an import that does not resolve points at its obvious match
 *
 * The icon list (lucide-icons.json) is generated from the lucide-react version
 * the starter template pins; stream-fixer.test.ts keeps the two in step.
 */

const posix = path.posix;

export interface SourceFix {
  rule: 'alias' | 'path' | 'icon';
  detail: string;
}

export const CODE_FILE = /\.(?:tsx?|jsx?|mjs)$/;
const RESOLVE_EXTENSIONS = ['', '.tsx', '.ts', '.jsx', '.js', '.json', '/index.tsx', '/index.ts', '/index.jsx', '/index.js'];

/** `from 'x'`, `import 'x'` and `import('x')`. Group 3 is the module specifier. */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\2/g;

/** Comments can mention imports that are not there. */
function withoutComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every module specifier a file imports. */
export function importSpecifiers(code: string): string[] {
  return [...withoutComments(code).matchAll(SPECIFIER)].map((m) => m[3]);
}

/** The project file a relative import points at, if it exists. */
export function resolveImport(from: string, spec: string, files: Set<string>): string | null {
  const base = posix.normalize(posix.join(posix.dirname(from), spec));
  for (const ext of RESOLVE_EXTENSIONS) if (files.has(base + ext)) return base + ext;
  return null;
}

/** The import specifier for `target` as written in `from`: relative, no code extension, no /index. */
function relativeTo(from: string, target: string): string {
  let rel = posix
    .relative(posix.dirname(from), target)
    .replace(/\.(?:tsx?|jsx?)$/, '')
    .replace(/\/index$/, '');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

/**
 * The obvious intended file for an import that does not resolve: the same
 * path in another case or with a code extension, or — when exactly one file
 * has that trailing path — the same file in another folder
 * ("./lib/format" written from src/components means src/lib/format).
 */
function findIntended(from: string, spec: string, files: Set<string>): string | null {
  const stem = (p: string) => p.replace(/\.(?:tsx?|jsx?)$/, '');
  const wanted = stem(posix.normalize(posix.join(posix.dirname(from), spec))).toLowerCase();
  const sameName = [...files].filter((f) => stem(f).toLowerCase() === wanted);
  if (sameName.length === 1) return sameName[0];

  const tail = stem(spec.replace(/^(?:\.\.?\/)+/, ''));
  if (!tail) return null;
  const sameTail = [...files].filter((f) => {
    const s = stem(f);
    return s === tail || s.endsWith(`/${tail}`) || s.endsWith(`/${tail}/index`);
  });
  return sameTail.length === 1 ? sameTail[0] : null;
}

const ICONS = new Set<string>(ICON_LIST.icons);
const NON_ICON_EXPORTS = new Set(['Icon', 'createLucideIcon', 'icons', 'LucideIcon', 'LucideProps', 'IconNode']);

/** A name lucide-react really exports: an icon, its "…Icon"/"Lucide…" alias, or a helper. */
export function isLucideExport(name: string): boolean {
  return (
    ICONS.has(name) ||
    NON_ICON_EXPORTS.has(name) ||
    (name.endsWith('Icon') && ICONS.has(name.slice(0, -4))) ||
    (name.startsWith('Lucide') && ICONS.has(name.slice(6)))
  );
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
}

/** The real icon nearest an invented name: same letters in another case, a small typo, or the same words; else a safe default. */
export function nearestIcon(name: string): string {
  const core = name.replace(/^Lucide/, '').replace(/Icon$/, '');
  const lower = core.toLowerCase();
  let best = '';
  let bestDistance = Infinity;
  for (const icon of ICONS) {
    const d = levenshtein(lower, icon.toLowerCase());
    if (d < bestDistance) {
      best = icon;
      bestDistance = d;
    }
  }
  if (best && bestDistance <= Math.max(2, Math.floor(lower.length / 4))) return best;
  const words = core
    .split(/(?=[A-Z0-9])/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
  const sameWords = [...ICONS].filter((icon) => words.every((w) => icon.toLowerCase().includes(w))).sort((a, b) => a.length - b.length);
  return sameWords[0] ?? 'Circle';
}

const LUCIDE_IMPORT = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*(['"])lucide-react\3/g;

/** Invented icon names become the nearest real one, imported under the name the code uses. */
function fixIcons(content: string, fixes: SourceFix[]): string {
  return content.replace(LUCIDE_IMPORT, (whole, typeOnly: string | undefined, list: string) => {
    if (typeOnly) return whole;
    let changed = false;
    const specs = list.split(',').map((raw) => {
      const spec = raw.trim();
      const m = spec.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (!m || isLucideExport(m[1])) return raw;
      const real = nearestIcon(m[1]);
      changed = true;
      fixes.push({ rule: 'icon', detail: `${m[1]} → ${real}` });
      return raw.replace(spec, `${real} as ${m[2] ?? m[1]}`);
    });
    return changed ? whole.replace(list, specs.join(',')) : whole;
  });
}

/** Apply every rule to one file. `files` is every project path once this pass is written. */
export function fixSource(path: string, content: string, files: Set<string>): { content: string; fixes: SourceFix[] } {
  if (!CODE_FILE.test(path)) return { content, fixes: [] };
  const fixes: SourceFix[] = [];
  const out = content.replace(SPECIFIER, (whole, prefix: string, quote: string, spec: string) => {
    if (spec.startsWith('@/')) {
      const base = `src/${spec.slice(2)}`;
      const found = RESOLVE_EXTENSIONS.map((ext) => base + ext).find((p) => files.has(p));
      const rel = relativeTo(path, found ?? base);
      fixes.push({ rule: 'alias', detail: `${spec} → ${rel}` });
      return `${prefix}${quote}${rel}${quote}`;
    }
    if (spec.startsWith('.') && !resolveImport(path, spec, files)) {
      const intended = findIntended(path, spec, files);
      if (intended) {
        const rel = relativeTo(path, intended);
        fixes.push({ rule: 'path', detail: `${spec} → ${rel}` });
        return `${prefix}${quote}${rel}${quote}`;
      }
    }
    return whole;
  });
  return { content: fixIcons(out, fixes), fixes };
}
