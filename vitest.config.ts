import { defineConfig } from 'vitest/config';

// Unit scope: engine and state only. Browser behaviour belongs to the Playwright suite.
export default defineConfig({
  test: {
    environment: 'node', // fem/ must be DOM-free; this enforces it
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
