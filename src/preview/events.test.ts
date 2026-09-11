import { describe, expect, it } from 'vitest';
import { dedupeErrors, normaliseStack, parsePreviewEvent, toPreviewError } from './events';

const ORIGIN = 'http://sbx-abc123.localhost:3001';

describe('normaliseStack', () => {
  it('turns preview URLs into repo paths and drops dependency frames', () => {
    const stack = [
      "TypeError: Cannot read properties of undefined (reading 'map')",
      `    at Home (${ORIGIN}/src/pages/Home.tsx?t=1789052486308:12:17)`,
      `    at renderWithHooks (${ORIGIN}/node_modules/.vite/deps/chunk-ABC.js?v=9f2a:11548:26)`,
      `    at App (${ORIGIN}/src/App.tsx:6:5)`,
    ].join('\n');
    expect(normaliseStack(stack, ORIGIN)).toBe(
      "TypeError: Cannot read properties of undefined (reading 'map')\n    at Home (src/pages/Home.tsx:12:17)\n    at App (src/App.tsx:6:5)",
    );
  });

  it('keeps at most twelve lines', () => {
    const stack = Array.from({ length: 30 }, (_, i) => `    at f${i} (${ORIGIN}/src/a.ts:${i}:1)`).join('\n');
    expect(normaliseStack(stack, ORIGIN).split('\n')).toHaveLength(12);
  });
});

describe('parsePreviewEvent', () => {
  it('accepts only flagged events of a known type', () => {
    expect(parsePreviewEvent({ type: 'RENDER_OK', pathname: '/' })).toBeNull();
    expect(parsePreviewEvent({ __preview_event: true, type: 'DO_SOMETHING' })).toBeNull();
    expect(parsePreviewEvent({ __preview_event: true, type: 'RENDER_OK', pathname: '/' })).toEqual({ type: 'RENDER_OK', pathname: '/' });
  });

  it('caps text the generated app controls', () => {
    const e = parsePreviewEvent({ __preview_event: true, type: 'UNHANDLED_REJECTION', message: 'x'.repeat(50_000) });
    expect(e && 'message' in e && e.message.length).toBe(1000);
  });
});

describe('toPreviewError', () => {
  it('locates a render crash from its component stack', () => {
    const e = toPreviewError(
      {
        type: 'REACT_RENDER_ERROR',
        message: "Cannot read properties of undefined (reading 'map')",
        componentStack: `\n    at Home (${ORIGIN}/src/pages/Home.tsx?t=1:12:17)\n    at App (${ORIGIN}/src/App.tsx:6:5)`,
      },
      ORIGIN,
    );
    expect(e).toMatchObject({ type: 'REACT_RENDER_ERROR', file: 'src/pages/Home.tsx', line: 12 });
    expect(e?.componentStack).toBe('    at Home (src/pages/Home.tsx:12:17)\n    at App (src/App.tsx:6:5)');
  });

  it('maps a build error id inside the container to a repo path', () => {
    expect(toPreviewError({ type: 'BUILD_ERROR', message: 'Unexpected token', id: '/app/src/App.tsx' }, ORIGIN)?.file).toBe('src/App.tsx');
  });

  it('ignores noise and non-failures', () => {
    expect(toPreviewError({ type: 'UNCAUGHT_EXCEPTION', message: 'Script error.', pathname: '/' }, ORIGIN)).toBeNull();
    expect(toPreviewError({ type: 'RENDER_OK', pathname: '/' }, ORIGIN)).toBeNull();
    expect(toPreviewError({ type: 'CONSOLE_ERROR', args: ['Warning: each child needs a key'] }, ORIGIN)).toBeNull();
  });
});

describe('dedupeErrors', () => {
  it('keeps one error per crash, preferring the one with a component stack', () => {
    const out = dedupeErrors([
      { type: 'UNCAUGHT_EXCEPTION', message: "Uncaught TypeError: Cannot read properties of undefined (reading 'map')" },
      { type: 'REACT_RENDER_ERROR', message: "Cannot read properties of undefined (reading 'map')", componentStack: 'at Home (src/pages/Home.tsx:12:17)' },
      { type: 'BLANK_SCREEN', message: 'Nothing rendered on /' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('REACT_RENDER_ERROR');
  });

  it('puts build errors first', () => {
    const out = dedupeErrors([
      { type: 'UNHANDLED_REJECTION', message: 'Failed to fetch' },
      { type: 'BUILD_ERROR', message: 'Failed to resolve import "./x" from "src/App.tsx"' },
    ]);
    expect(out.map((e) => e.type)).toEqual(['BUILD_ERROR', 'UNHANDLED_REJECTION']);
  });
});
