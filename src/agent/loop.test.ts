import { describe, expect, it } from 'vitest';
import { needsPreviewRemount } from './loop';

describe('needsPreviewRemount', () => {
  it('lets HMR deliver a change to a dev server that was already serving', () => {
    // Remounting here raced Vite's file watcher and showed the previous app.
    expect(needsPreviewRemount({ filesChanged: true, wasServing: true, dependenciesChanged: false })).toBe(false);
  });

  it('remounts when the dev server was not serving before the change', () => {
    expect(needsPreviewRemount({ filesChanged: true, wasServing: false, dependenciesChanged: false })).toBe(true);
  });

  it('remounts after a dependency install', () => {
    expect(needsPreviewRemount({ filesChanged: true, wasServing: true, dependenciesChanged: true })).toBe(true);
  });

  it('never remounts when no file changed', () => {
    expect(needsPreviewRemount({ filesChanged: false, wasServing: false, dependenciesChanged: false })).toBe(false);
  });
});
