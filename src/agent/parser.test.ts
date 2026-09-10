import { describe, expect, it } from 'vitest';
import { ChangesParser, parseAttributes, partialSuffix, type ChangeOp, type ParseEvent } from './parser';

/** Feed `text` in chunks of `size` characters and collect every event. */
function parseInChunks(text: string, size: number): ParseEvent[] {
  const p = new ChangesParser();
  const events: ParseEvent[] = [];
  for (let i = 0; i < text.length; i += size) events.push(...p.push(text.slice(i, i + size)));
  events.push(...p.end());
  return events;
}

const ops = (events: ParseEvent[]): ChangeOp[] =>
  events.flatMap((e) => (e.type === 'op' ? [e.op] : []));

const prose = (events: ParseEvent[], phase: 'before' | 'after') =>
  events.flatMap((e) => (e.type === 'text' && e.phase === phase ? [e.text] : [])).join('');

const SAMPLE = `I'll add a card component.

<changes>
<write path="src/components/Card.tsx">
export function Card({ title }: { title: string }) {
  return <div className="p-4">{title}</div>;
}
</write>

<edit path="src/App.tsx" instruction="Import and render the new Card component">
// ... existing code ...
import { Card } from './components/Card';
// ... existing code ...
      <Card title="Hello" />
// ... existing code ...
</edit>

<rename from="src/old.tsx" to="src/new.tsx" />
<delete path="src/unused.tsx" />
<add-dependency>date-fns@latest</add-dependency>
</changes>

Added a card to the home page.`;

describe('ChangesParser', () => {
  it('parses every tag in the spec example', () => {
    const result = ops(parseInChunks(SAMPLE, SAMPLE.length));
    expect(result).toEqual([
      {
        type: 'write',
        path: 'src/components/Card.tsx',
        content:
          'export function Card({ title }: { title: string }) {\n  return <div className="p-4">{title}</div>;\n}\n',
      },
      {
        type: 'edit',
        path: 'src/App.tsx',
        instruction: 'Import and render the new Card component',
        body:
          "// ... existing code ...\nimport { Card } from './components/Card';\n// ... existing code ...\n      <Card title=\"Hello\" />\n// ... existing code ...\n",
      },
      { type: 'rename', from: 'src/old.tsx', to: 'src/new.tsx' },
      { type: 'delete', path: 'src/unused.tsx' },
      { type: 'add-dependency', spec: 'date-fns@latest' },
    ]);
  });

  it('gives identical results for every chunk size (tags split across chunks)', () => {
    const reference = ops(parseInChunks(SAMPLE, SAMPLE.length));
    for (const size of [1, 2, 3, 5, 7, 13, 64]) {
      expect(ops(parseInChunks(SAMPLE, size))).toEqual(reference);
    }
  });

  it('separates prose before and after the changes block', () => {
    for (const size of [1, 4, SAMPLE.length]) {
      const events = parseInChunks(SAMPLE, size);
      expect(prose(events, 'before').trim()).toBe("I'll add a card component.");
      expect(prose(events, 'after').trim()).toBe('Added a card to the home page.');
    }
  });

  it('emits file-start before the op and streams the body in chunks', () => {
    const events = parseInChunks(SAMPLE, 5);
    const start = events.findIndex((e) => e.type === 'file-start' && e.path === 'src/components/Card.tsx');
    const done = events.findIndex((e) => e.type === 'op' && e.op.type === 'write');
    const chunks = events.filter((e) => e.type === 'file-chunk' && e.path === 'src/components/Card.tsx');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(done).toBeGreaterThan(start);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('never applies a write that was cut off', () => {
    const truncated = '<changes>\n<write path="src/a.tsx">\nexport const a = 1;\n';
    const events = parseInChunks(truncated, 3);
    expect(ops(events)).toEqual([]);
    expect(events.some((e) => e.type === 'warning' && /cut off/.test(e.message))).toBe(true);
  });

  it('does not treat a partial closing tag inside content as the end', () => {
    const text = '<changes><write path="a.ts">const s = "</wr";\n</write></changes>';
    for (const size of [1, 2, text.length]) {
      expect(ops(parseInChunks(text, size))).toEqual([{ type: 'write', path: 'a.ts', content: 'const s = "</wr";\n' }]);
    }
  });

  it('handles a response with no changes block as prose only', () => {
    const events = parseInChunks('Sure — the app already does that.', 4);
    expect(ops(events)).toEqual([]);
    expect(prose(events, 'before')).toBe('Sure — the app already does that.');
  });

  it('warns about unknown tags and tags missing attributes', () => {
    const events = parseInChunks('<changes><explode/><delete /><write>x</write></changes>', 100);
    const warnings = events.filter((e) => e.type === 'warning');
    expect(warnings).toHaveLength(3);
    expect(ops(events)).toEqual([]);
  });
});

describe('helpers', () => {
  it('partialSuffix finds the longest held-back prefix', () => {
    expect(partialSuffix('abc <chan', '<changes>')).toBe(5);
    expect(partialSuffix('abc', '<changes>')).toBe(0);
    expect(partialSuffix('x<', '<changes>')).toBe(1);
  });

  it('parseAttributes decodes quotes and entities', () => {
    expect(parseAttributes(`<edit path="src/A.tsx" instruction='Say &quot;hi&quot; &amp; wave'>`)).toEqual({
      path: 'src/A.tsx',
      instruction: 'Say "hi" & wave',
    });
  });
});
