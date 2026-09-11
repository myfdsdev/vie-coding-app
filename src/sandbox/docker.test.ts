import { describe, expect, it } from 'vitest';
import { viteError } from './docker';

/** The page Vite 5 serves, with HTTP 500, for a module it cannot build. */
function vitePage(error: object): string {
  return `
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="UTF-8" />
            <title>Error</title>
            <script type="module">
              const error = ${JSON.stringify(error).replace(/</g, '\\u003c')}
              try {
                const { ErrorOverlay } = await import("/@vite/client")
                document.body.appendChild(new ErrorOverlay(error))
              } catch {}
            </script>
          </head>
          <body></body>
        </html>`;
}

describe('viteError', () => {
  it('reads the message and code frame from Vite’s error page, with repo paths', () => {
    const page = vitePage({
      message: "/app/src/syntax-error.tsx: Unexpected keyword 'return'. (2:2)",
      frame: '1  |  export default function Broken( {\n2  |    return <div>oops</div>;',
      id: '/app/src/syntax-error.tsx',
    });
    expect(viteError(page)).toEqual({
      message: "src/syntax-error.tsx: Unexpected keyword 'return'. (2:2)",
      frame: '1  |  export default function Broken( {\n2  |    return <div>oops</div>;',
    });
  });

  it('falls back to the page text for an unfamiliar format', () => {
    expect(viteError('<html><body><h1>Internal Server Error</h1></body></html>').message).toBe('Internal Server Error');
    expect(viteError('').message).toMatch(/could not build/);
  });
});
