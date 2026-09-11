import type { PreviewError } from '../preview/events';

/**
 * Error -> likely cause (BUILD-PROMPT §10). A diagnosed error is the 1.58x
 * lever from the research: better feedback beats more repair attempts. The
 * cause goes into the fix prompt and, in plain words, to the user. Grow this
 * table from real logs instead of adding retries.
 */

export interface Diagnosis {
  /** Likely cause, readable by the user and specific enough for the model. */
  cause: string;
  /** What a fix attempt does, for "Attempt 2 of 3 — adding a loading guard". */
  action: string;
}

const TABLE: { match: RegExp; diagnose: (m: RegExpMatchArray) => Diagnosis }[] = [
  {
    match: /Failed to resolve import "(.+?)" from "(.+?)"/,
    diagnose: (m) => ({
      cause: `The file "${m[1]}" imported by ${m[2]} does not exist. Either create it or fix the import path — check the project's files first.`,
      action: `fixing the import of ${m[1]}`,
    }),
  },
  {
    match: /Cannot find module '(.+?)'|Could not resolve "(.+?)"/,
    diagnose: (m) => ({
      cause: `"${m[1] ?? m[2]}" is not installed. If it is a real npm package, add it as a dependency; if it isn't, it was made up — use something already in package.json.`,
      action: `fixing the missing "${m[1] ?? m[2]}"`,
    }),
  },
  {
    match: /does not provide an export named '(.+?)'/,
    diagnose: (m) => ({
      cause: `The code imports "${m[1]}" from a file that does not export that name — usually a default vs named export mix-up, or a typo.`,
      action: `fixing the import of ${m[1]}`,
    }),
  },
  {
    match: /Cannot read propert(?:y|ies) of (undefined|null) \(reading '(.+?)'\)/,
    diagnose: (m) => ({
      cause: `A value is ${m[1]} when "${m[2]}" is read — usually data that has not loaded yet. It needs a loading guard or optional chaining where it is used.`,
      action: 'adding a loading guard',
    }),
  },
  {
    match: /(\S+) is not iterable/,
    diagnose: (m) => ({
      cause: `"${m[1]}" is looped over while it is not a list — usually data that has not loaded yet. It needs a loading guard or a default empty list.`,
      action: 'adding a loading guard',
    }),
  },
  {
    match: /No QueryClient set/,
    diagnose: () => ({
      cause: 'useQuery is used but the app is not wrapped in a QueryClientProvider. The root in src/main.tsx needs it.',
      action: 'adding the query provider',
    }),
  },
  {
    match: /may be used only in the context of a <Router>/,
    diagnose: () => ({
      cause: 'A router hook is used outside a Router. The app in src/main.tsx needs to be wrapped in <BrowserRouter>.',
      action: 'wrapping the app in the router',
    }),
  },
  {
    match: /Objects are not valid as a React child/,
    diagnose: () => ({
      cause: 'An object is rendered directly on the page. One of its fields should be rendered instead.',
      action: 'rendering a field instead of an object',
    }),
  },
  {
    match: /Maximum update depth exceeded/,
    diagnose: () => ({
      cause: 'A state update runs on every render — usually a missing or wrong useEffect dependency list.',
      action: 'stopping an update loop',
    }),
  },
  {
    match: /Element type is invalid/,
    diagnose: () => ({
      cause: 'A component is imported the wrong way (default vs named) or its file does not export it.',
      action: 'fixing a component import',
    }),
  },
  {
    match: /Rendered (?:more|fewer) hooks|Invalid hook call/,
    diagnose: () => ({
      cause: 'A React hook is called conditionally, in a loop, or outside a component.',
      action: 'fixing how hooks are called',
    }),
  },
  {
    match: /Cannot access '(\w+)' before initialization/,
    diagnose: (m) => ({
      cause: `"${m[1]}" is used before it is defined — often two files importing each other.`,
      action: 'fixing the order of definitions',
    }),
  },
  {
    match: /(?:^|\s)(\w+) is not defined/,
    diagnose: (m) => ({
      cause: `"${m[1]}" is used but never imported or declared in that file — the import is missing.`,
      action: `adding the missing import for ${m[1]}`,
    }),
  },
  {
    match: /(\S+) is not a function/,
    diagnose: (m) => ({
      cause: `"${m[1]}" is called like a function but isn't one there — often a default vs named import mix-up, or data in an unexpected shape.`,
      action: `fixing the call to ${m[1]}`,
    }),
  },
  {
    match: /Transform failed|Expected ".+" but found|Unexpected token|Unterminated|Failed to parse source/,
    diagnose: () => ({
      cause: 'The file has a syntax error, so it cannot be built.',
      action: 'fixing a syntax error',
    }),
  },
  {
    match: /permission denied for table (\w+)|new row violates row-level security/,
    diagnose: (m) => ({
      cause: `Row-level security is blocking this query on "${m[1] ?? 'the table'}". An access rule for the current user is missing or wrong.`,
      action: 'fixing an access rule',
    }),
  },
  {
    match: /Failed to fetch|NetworkError when attempting to fetch/,
    diagnose: () => ({
      cause: 'A network request failed — the preview cannot reach that address. Use data the app already has, or handle the failure.',
      action: 'handling a failed request',
    }),
  },
];

export function diagnose(text: string): Diagnosis | null {
  for (const entry of TABLE) {
    const m = text.match(entry.match);
    if (m) return entry.diagnose(m);
  }
  return null;
}

export function diagnoseError(e: PreviewError): Diagnosis {
  if (e.type === 'BLANK_SCREEN') {
    return { cause: 'The page rendered nothing — the root component returns nothing, or no route matches this page.', action: 'fixing an empty page' };
  }
  return (
    diagnose([e.message, e.frame, e.stack].filter(Boolean).join('\n')) ?? {
      cause: 'An error stopped the app. The stack trace points at the file that needs fixing.',
      action: 'fixing the error',
    }
  );
}

/** Repo files a failure points at, most specific first (at most three). */
export function referencedFiles(e: PreviewError): string[] {
  const found = [e.file, ...[e.componentStack, e.stack, e.frame].flatMap((s) => [...(s ?? '').matchAll(/\b(src\/[\w./-]+\.(?:tsx?|jsx?|css))/g)].map((m) => m[1]))];
  return [...new Set(found.filter((p): p is string => !!p))].slice(0, 3);
}

/**
 * The fix prompt, in the order BUILD-PROMPT §10 prescribes: error type,
 * message, component stack, repo-relative stack, likely cause, the files the
 * stack points at, then the instruction to fix only this.
 */
export function buildFixPrompt(
  e: PreviewError,
  d: Diagnosis,
  files: { path: string; content: string }[],
  opts: { stuck: boolean },
): string {
  const parts = [
    'The app failed with the following error. Fix it.',
    '',
    `ERROR TYPE: ${e.type}`,
    `MESSAGE: ${e.message}`,
    e.componentStack && `COMPONENT STACK:\n${e.componentStack}`,
    e.stack && `STACK (repo-relative):\n${e.stack}`,
    e.frame && `CODE FRAME:\n${e.frame}`,
    `LIKELY CAUSE: ${d.cause}`,
    opts.stuck && 'NOTE: The previous fix did not remove this error, so that approach is wrong. Try a different one.',
    files.length > 0 && ['', 'RELEVANT FILES:', ...files.map((f) => `--- ${f.path} ---\n${f.content}`)].join('\n'),
    '',
    'Fix ONLY this error. Do not refactor anything else.',
  ];
  return parts.filter((p): p is string => typeof p === 'string').join('\n');
}
