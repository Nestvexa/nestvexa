import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Vitest project for StrykerJS (`pnpm test:mutation`). Mutants are written to
 * TypeScript sources, so the suites that normally import a package's built
 * `dist/index.js` are redirected to `src/index.ts` for the mutated packages.
 * Only suites that exercise the mutated modules are included; see
 * docs/testing/property-load-mutation.md.
 */
const source = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: ['core', 'live', 'uploads'].map((name) => ({
      find: new RegExp(`^(?:\\.\\./)+packages/${name}/dist/index\\.js$`),
      replacement: source(name),
    })),
  },
  test: {
    include: [
      'tests/live-protocol.test.ts',
      'tests/property-live-protocol.test.ts',
      'tests/live-admission.test.ts',
      'tests/core.test.ts',
      'tests/core-config.test.ts',
      'tests/uploads-validation.test.ts',
      'tests/property-uploads.test.ts',
    ],
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
