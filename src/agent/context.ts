/**
 * Cache-stable context assembly (BUILD-PROMPT §3.3).
 *
 * Order is an invariant: system prompt (prompt.ts) -> this project-files block
 * -> history (append-only) -> new user message. Files are sorted by path and
 * nothing volatile (timestamps, ids, random values) is ever injected, so the
 * prefix stays byte-identical whenever the files are unchanged.
 */

/** Present in the project but never sent: huge, generated, or builder infrastructure. */
const OMIT_CONTENT = new Set([
  'package-lock.json',
  'vite-plugin-preview-instrumentation.ts',
  'src/ErrorBoundary.tsx',
]);

const MAX_FILE_CHARS = 40_000;

export function buildContext(files: { path: string; content: string }[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const tree = sorted.map((f) => f.path).join('\n');
  const blocks = sorted
    .filter((f) => !OMIT_CONTENT.has(f.path))
    .map((f) => {
      const body =
        f.content.length > MAX_FILE_CHARS
          ? `${f.content.slice(0, MAX_FILE_CHARS)}\n[file truncated in context: ${f.content.length} characters]`
          : f.content;
      return `--- ${f.path} ---\n${body}`;
    });
  return [
    '<project_files>',
    'All files currently in the project (content of infrastructure files omitted):',
    tree,
    '',
    ...blocks,
    '</project_files>',
  ].join('\n');
}

/**
 * What an assistant turn contributes to later history: the prose, with the
 * <changes> block replaced by a list of touched paths. The files block already
 * carries current contents, so repeating old code would only bloat context.
 */
export function historyEntryFor(response: string, touched: string[]): string {
  const prose = response.replace(/<changes>[\s\S]*?(<\/changes>|$)/g, '').trim();
  const files = touched.length ? `\n[changed files: ${touched.join(', ')}]` : '';
  return (prose || '(no reply)') + files;
}
