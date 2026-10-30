import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Several suites launch real Chromium; bound process contention on developer/CI hosts.
    maxWorkers: 2,
    testTimeout: 15000,
    hookTimeout: 30000,
    reporters: ['default', 'json'],
    outputFile: { json: 'artifacts/reports/vitest.json' },
  },
});
