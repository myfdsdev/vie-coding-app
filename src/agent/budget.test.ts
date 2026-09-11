import { describe, expect, it } from 'vitest';
import { LoopBudget } from './budget';

const err = (message: string, type = 'REACT_RENDER_ERROR') => ({ type, message });

describe('LoopBudget', () => {
  it('gives the same failure the same signature, whatever the identifiers and numbers', () => {
    const b = new LoopBudget();
    expect(b.signature(err("Cannot read properties of undefined (reading 'map')"))).toBe(
      b.signature(err("Cannot read properties of undefined (reading 'filter')")),
    );
    expect(b.signature(err('Failed at line 34:18'))).toBe(b.signature(err('Failed at line 7:2')));
    expect(b.signature(err('x', 'BUILD_ERROR'))).not.toBe(b.signature(err('x', 'REACT_RENDER_ERROR')));
  });

  it('allows three attempts per failure', () => {
    const b = new LoopBudget();
    const e = err("Cannot read properties of undefined (reading 'map')");
    for (let i = 0; i < 3; i++) {
      expect(b.canRetry(e)).toBe(true);
      b.record(e);
    }
    expect(b.canRetry(e)).toBe(false);
  });

  it('allows five attempts per turn across different failures', () => {
    const b = new LoopBudget();
    for (const name of ['A', 'B', 'C', 'D', 'E']) {
      const e = err(`${name}Thing is not defined`);
      expect(b.canRetry(e)).toBe(true);
      b.record(e);
    }
    expect(b.canRetry(err('Something else broke'))).toBe(false);
    expect(b.used).toBe(5);
  });

  it('calls the second occurrence of the same failure stuck', () => {
    const b = new LoopBudget();
    const e = err('Maximum update depth exceeded');
    b.record(e);
    expect(b.isStuck(e)).toBe(false);
    b.record(e);
    expect(b.isStuck(e)).toBe(true);
    expect(b.attempts(e)).toBe(2);
  });
});
