/**
 * StrykerJS mutation testing for the highest-risk server modules
 * (`pnpm test:mutation`). Scope and rationale: docs/testing/property-load-mutation.md.
 *
 * - Runs vitest with `vitest.mutation.config.ts`, which redirects the mutated
 *   packages' `dist/index.js` imports to their TypeScript sources.
 * - `inPlace`: pnpm workspace links (`packages/<pkg>/node_modules/@nestvexa/*`)
 *   do not survive Stryker's sandbox copy, so mutants are written to the
 *   working tree and restored afterwards. Run it on a clean checkout and do
 *   not interrupt it with SIGKILL (SIGINT/SIGTERM restore the sources).
 * - The score is reported, not yet gating (`thresholds.break: null`).
 *   Requires `pnpm build` (dependent packages are imported from dist).
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { configFile: 'vitest.mutation.config.ts' },
  inPlace: true,
  // Vitest strips types without checking them. Stryker must not add
  // `// @ts-nocheck` banners: in place they would land in every working file.
  disableTypeChecks: false,
  coverageAnalysis: 'perTest',
  // Static mutants (module-level constants) force a full reload and rerun of
  // every suite per mutant; they are excluded (counted in the report).
  ignoreStatic: true,
  mutate: [
    // Live protocol parsing and the snapshot store.
    'packages/live/src/protocol.ts',
    'packages/live/src/store.ts',
    // Live admission: header access, constant-time CSRF compare, identity
    // bounds, rate limit and the admit() guard (origin, content type, CSRF).
    'packages/live/src/runtime.ts:237-258',
    'packages/live/src/runtime.ts:302-379',
    // Configuration normalization and environment parsing.
    'packages/core/src/config.ts',
    // Upload validation: client filenames, references and content checks.
    'packages/uploads/src/filename.ts',
    'packages/uploads/src/references.ts',
    'packages/uploads/src/file-types.ts',
  ],
  concurrency: Number(process.env['STRYKER_CONCURRENCY'] ?? 2),
  timeoutMS: 30000,
  // The initial run boots Nest applications; allow for a saturated runner.
  dryRunTimeoutMinutes: 30,
  timeoutFactor: 2,
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: 'artifacts/reports/mutation/index.html' },
  jsonReporter: { fileName: 'artifacts/reports/mutation/mutation.json' },
  thresholds: { high: 85, low: 70, break: null },
  tempDirName: '.stryker-tmp',
  cleanTempDir: 'always',
};
