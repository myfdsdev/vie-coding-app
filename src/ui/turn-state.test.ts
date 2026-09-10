import { describe, expect, it } from 'vitest';
import type { TurnEvent } from '@/agent/types';
import { applyTurnEvent, dropOrphanFence, newAssistantTurn } from './turn-state';

describe('dropOrphanFence', () => {
  it('drops a fence opened at the end of the plan', () => {
    expect(dropOrphanFence('Here is the plan.\n```xml\n', 'end')).toBe('Here is the plan.\n');
  });

  it('drops the matching fence closed at the start of the summary', () => {
    expect(dropOrphanFence('\n```\n\nI added the button.', 'start')).toBe('\n\nI added the button.');
  });

  it('leaves balanced code blocks alone', () => {
    const text = 'Example:\n```ts\nconst a = 1;\n```\n';
    expect(dropOrphanFence(text, 'end')).toBe(text);
  });
});

describe('applyTurnEvent', () => {
  it('hides a markdown fence wrapped around the changes block', () => {
    const events: TurnEvent[] = [
      { type: 'text', text: 'I will add a button.\n```xml\n', phase: 'before' },
      { type: 'file', path: 'src/pages/Home.tsx', status: 'done', change: 'modified', lines: 12 },
      { type: 'text', text: '\n```\n\nAdded a red birthday button.', phase: 'after' },
      { type: 'turn-end', outcome: 'success', durationMs: 5, filesChanged: 1 },
    ];
    const turn = events.reduce(applyTurnEvent, newAssistantTurn('t1'));
    expect(turn.plan.trim()).toBe('I will add a button.');
    expect(turn.summary.trim()).toBe('Added a red birthday button.');
  });
});
