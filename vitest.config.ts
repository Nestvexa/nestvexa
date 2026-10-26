import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 15000,
    hookTimeout: 30000,
    reporters: ['default', 'json'],
    outputFile: { json: 'artifacts/reports/vitest.json' },
  },
});
