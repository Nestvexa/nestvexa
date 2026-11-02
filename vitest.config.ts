import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Several suites launch real Chromium; bound process contention on developer/CI hosts.
    // Windows hosts (local and hosted runners) time out under two concurrent
    // browser-launching workers; one worker trades speed for reliability.
    maxWorkers: process.platform === 'win32' ? 1 : 2,
    testTimeout: 15000,
    // Browser launches/pages in hooks can exceed 30s on 2-core hosted runners.
    hookTimeout: 60000,
    reporters: ['default', 'json'],
    outputFile: { json: 'artifacts/reports/vitest.json' },
  },
});
