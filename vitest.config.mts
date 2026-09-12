import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Tests live next to the code they cover. The "@/" alias mirrors tsconfig, so
 * a Next route handler (which imports through it) can be called directly from
 * a test instead of over HTTP.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['src/**/*.test.ts', 'app/**/*.test.ts'],
  },
});
