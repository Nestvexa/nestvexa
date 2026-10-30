import { defineConfig } from 'vitest/config';

/** This deliberately scoped gate does not replace the complete test or release suites. */
export default defineConfig({
  test: {
    include: [
      'tests/live-protocol.test.ts',
      'tests/core.test.ts',
      'tests/live-computed.test.ts',
      'tests/live-computed-integration.test.ts',
    ],
    testTimeout: 15000,
    hookTimeout: 30000,
    reporters: ['default', 'json'],
    outputFile: { json: 'artifacts/reports/high-risk-tests.json' },
    coverage: {
      provider: 'v8',
      include: [
        'packages/{live/src/protocol,live/src/store,live/src/computed,core/src/config}.ts',
      ],
      reportsDirectory: 'artifacts/reports/coverage/high-risk',
      reporter: ['text', 'json', 'json-summary', 'html', 'lcov'],
      reportOnFailure: true,
      thresholds: {
        perFile: true,
        branches: 90,
        statements: 85,
        functions: 85,
        lines: 85,
      },
    },
  },
});
