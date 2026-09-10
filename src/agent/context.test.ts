import { describe, expect, it } from 'vitest';
import { historyEntryFor } from './context';

describe('historyEntryFor', () => {
  it('replaces the changes block with the list of changed files', () => {
    const reply = 'Adding a card.\n<changes>\n<write path="a.ts">x</write>\n</changes>\nDone.';
    expect(historyEntryFor(reply, ['a.ts'])).toBe('Adding a card.\n\nDone.\n[changed files: a.ts]');
  });

  it('drops the empty fence left when the block was wrapped in one', () => {
    const reply = '```xml\n<changes>\n<write path="a.ts">x</write>\n</changes>\n```\n\nI updated the page.';
    expect(historyEntryFor(reply, ['a.ts'])).toBe('I updated the page.\n[changed files: a.ts]');
  });

  it('records why nothing was applied', () => {
    const reply = '<changes>\n<write>x</write>\n</changes>\nThe button is red now.';
    expect(historyEntryFor(reply, [], '<write> without a path attribute ignored.')).toBe(
      'The button is red now.\n[none of these changes were applied: <write> without a path attribute ignored.]',
    );
  });
});
