import { describe, expect, it } from 'vitest';
import type { PreviewError } from '../preview/events';
import { buildFixPrompt, diagnose, diagnoseError, referencedFiles } from './diagnose';

describe('diagnose', () => {
  it.each([
    ['Failed to resolve import "./components/Card" from "src/App.tsx". Does the file exist?', /does not exist/, 'fixing the import of ./components/Card'],
    ["Cannot find module 'react-fancy-charts'", /not installed/, 'fixing the missing "react-fancy-charts"'],
    ['setRecipes is not defined', /never imported or declared/, 'adding the missing import for setRecipes'],
    ["Cannot read properties of undefined (reading 'map')", /loading guard/, 'adding a loading guard'],
    ['No QueryClient set, use QueryClientProvider to set one', /QueryClientProvider/, 'adding the query provider'],
    ['useNavigate() may be used only in the context of a <Router> component.', /BrowserRouter/, 'wrapping the app in the router'],
    ['Objects are not valid as a React child (found: object with keys {id, title})', /render/, 'rendering a field instead of an object'],
    ['Maximum update depth exceeded. This can happen when a component calls setState inside useEffect', /useEffect/, 'stopping an update loop'],
    ["The requested module '/src/lib/api.ts' does not provide an export named 'getRecipes'", /export/, 'fixing the import of getRecipes'],
    ['permission denied for table recipes', /Row-level security/, 'fixing an access rule'],
  ])('%s', (message, cause, action) => {
    const d = diagnose(message);
    expect(d?.cause).toMatch(cause);
    expect(d?.action).toBe(action);
  });

  it('prefers the specific entry over the generic one', () => {
    // "is not a function" must not swallow the import error, nor "is not defined" the resolve error.
    expect(diagnose('Failed to resolve import "x" from "src/a.tsx". Does the file exist?')?.action).toBe('fixing the import of x');
  });

  it('always has something to say, including for a blank screen', () => {
    expect(diagnoseError({ type: 'BLANK_SCREEN', message: 'Nothing rendered on /' }).action).toBe('fixing an empty page');
    expect(diagnoseError({ type: 'UNCAUGHT_EXCEPTION', message: 'Something odd happened' }).action).toBe('fixing the error');
  });
});

describe('buildFixPrompt', () => {
  const error: PreviewError = {
    type: 'REACT_RENDER_ERROR',
    message: "Cannot read properties of undefined (reading 'map')",
    stack: "TypeError: Cannot read properties of undefined (reading 'map')\n    at Home (src/pages/Home.tsx:12:17)",
    componentStack: '    at Home (src/pages/Home.tsx:12:17)\n    at App (src/App.tsx:6:5)',
    file: 'src/pages/Home.tsx',
    line: 12,
  };

  it('follows the order of BUILD-PROMPT §10', () => {
    const prompt = buildFixPrompt(error, diagnoseError(error), [{ path: 'src/pages/Home.tsx', content: 'export default function Home() {}\n' }], {
      stuck: false,
    });
    const order = ['ERROR TYPE: REACT_RENDER_ERROR', 'MESSAGE:', 'COMPONENT STACK:', 'STACK (repo-relative):', 'LIKELY CAUSE:', 'RELEVANT FILES:', '--- src/pages/Home.tsx ---', 'Fix ONLY this error.'];
    const positions = order.map((s) => prompt.indexOf(s));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(prompt).not.toMatch(/previous fix/);
  });

  it('tells the model to change approach when the same failure came back', () => {
    expect(buildFixPrompt(error, diagnoseError(error), [], { stuck: true })).toMatch(/previous fix did not remove this error/);
  });

  it('opens the files the stack points at', () => {
    expect(referencedFiles(error)).toEqual(['src/pages/Home.tsx', 'src/App.tsx']);
  });
});
