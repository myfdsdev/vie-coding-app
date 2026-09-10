import { describe, expect, it } from 'vitest';
import { applyEdit } from './apply-edit';
import { ChangesParser, type ChangeOp } from './parser';
import { mockResponse, titleFrom } from './mock-responses';

function parse(text: string) {
  const p = new ChangesParser();
  const events = [...p.push(text), ...p.end()];
  return {
    ops: events.flatMap((e) => (e.type === 'op' ? [e.op] : [])) as ChangeOp[],
    warnings: events.filter((e) => e.type === 'warning'),
  };
}

const request = (message: string, context = '') => ({
  system: 'sys',
  context,
  messages: [{ role: 'user' as const, content: message }],
});

describe('mock provider output', () => {
  it('builds the starter app as whole-file writes the parser accepts cleanly', () => {
    const { ops, warnings } = parse(mockResponse(request('build me a recipe tracker')));
    expect(warnings).toEqual([]);
    expect(ops.map((o) => (o.type === 'write' ? o.path : o.type))).toEqual([
      'src/types.ts',
      'src/hooks/useTasks.ts',
      'src/components/Header.tsx',
      'src/components/TaskInput.tsx',
      'src/components/FilterTabs.tsx',
      'src/components/TaskItem.tsx',
      'src/pages/Home.tsx',
    ]);
  });

  it('embeds the user brief safely as a string literal', () => {
    const { ops } = parse(mockResponse(request('Make "quotes" & </write> safe')));
    const home = ops.find((o) => o.type === 'write' && o.path === 'src/pages/Home.tsx');
    expect(home && home.type === 'write' && home.content).toContain('const BRIEF = "Make \\"quotes\\" & \\u003c/write> safe";');
  });

  it('demonstrates a follow-up change as an edit that applies to the starter header', () => {
    const built = parse(mockResponse(request('build me a recipe tracker'))).ops;
    const header = built.find((o) => o.type === 'write' && o.path === 'src/components/Header.tsx');
    const original = header?.type === 'write' ? header.content : '';
    const context = `--- src/hooks/useTasks.ts ---\n--- src/components/Header.tsx ---\n${original}`;
    const { ops, warnings } = parse(mockResponse(request('add dark mode', context)));
    expect(warnings).toEqual([]);
    expect(ops).toHaveLength(1);
    const edit = ops[0];
    const result = edit.type === 'edit' ? applyEdit(original, edit.body) : null;
    expect(result).toMatchObject({ ok: true });
    expect(result?.ok && result.content).toContain('rounded-xl bg-rose-500');
  });

  it('sends the whole header when its edit could not be placed', () => {
    const { ops } = parse(
      mockResponse(request('These edits could not be placed exactly, so they were NOT applied:', '--- src/hooks/useTasks.ts ---')),
    );
    expect(ops.map((o) => `${o.type} ${'path' in o ? o.path : ''}`)).toEqual(['write src/components/Header.tsx']);
  });

  it('derives a title from the prompt', () => {
    expect(titleFrom('build me a recipe tracker for my family')).toBe('Recipe Tracker Family');
    expect(titleFrom('   ')).toBe('Task Board');
  });
});
