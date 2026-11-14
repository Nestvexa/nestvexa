import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Project-wide coverage gate (`pnpm test:coverage`). See docs/testing/coverage.md.
 *
 * Suites import the packages' built `dist/*.js` files. V8 coverage is gated on
 * the TypeScript sources instead, so this project redirects every module that
 * resolves into `packages/<name>/dist/` (relative test imports and the
 * `@nestvexa/*` specifiers that packages and examples use) to the matching
 * `packages/<name>/src/` file. Redirecting both kinds keeps one module instance
 * per package, so Nest DI tokens and metadata registries stay identical.
 */
const root = fileURLToPath(new URL('.', import.meta.url)).replace(/\\/g, '/');
const sourceExtensions = ['.ts', '.tsx', '.mts'];

function distToSource(): Plugin {
  const distFile = new RegExp(
    `^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}packages/([^/]+)/dist/(.+)\\.js$`,
  );
  return {
    name: 'nestvexa:coverage-dist-to-source',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (source.startsWith('\0')) return null;
      const resolved = await this.resolve(source, importer, {
        ...options,
        skipSelf: true,
      });
      if (!resolved || resolved.external) return resolved;
      const match = distFile.exec(resolved.id.replace(/\\/g, '/'));
      if (!match) return resolved;
      for (const extension of sourceExtensions) {
        const candidate = `${root}packages/${match[1]}/src/${match[2]}${extension}`;
        if (existsSync(candidate)) return { ...resolved, id: candidate };
      }
      // Bundled artifacts (for example the client IIFE) have no source twin.
      return resolved;
    },
  };
}

/** Lines, functions and statements 85%, branches 80% (spec 21.8). */
const projectThresholds = {
  statements: 85,
  functions: 85,
  lines: 85,
  branches: 80,
} as const;

/**
 * Spec 21.8: at least 90% branches on the high-risk protocol, state and
 * configuration modules, enforced for each file.
 */
const highRiskThresholds = {
  perFile: true,
  branches: 90,
  statements: 85,
  functions: 85,
  lines: 85,
} as const;

const packages = readdirSync(new URL('./packages/', import.meta.url), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

/**
 * Sources that cannot execute in Node. Each entry names the reason and the
 * suite that exercises the code in a real browser instead. Nothing else is
 * excluded; see docs/testing/coverage.md.
 */
export const browserOnlyExclusions: readonly {
  readonly glob: string;
  readonly reason: string;
}[] = [];

export default defineConfig({
  plugins: [distToSource()],
  test: {
    include: ['tests/**/*.test.ts'],
    maxWorkers: process.platform === 'win32' ? 1 : 2,
    testTimeout: 15000,
    hookTimeout: 60000,
    reporters: ['default', 'json'],
    outputFile: { json: 'artifacts/reports/coverage-tests.json' },
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.{ts,tsx,mts}'],
      exclude: [
        '**/*.d.ts',
        ...browserOnlyExclusions.map((exclusion) => exclusion.glob),
      ],
      reportsDirectory: 'artifacts/reports/coverage',
      reporter: ['text-summary', 'json', 'json-summary', 'html', 'lcov'],
      reportOnFailure: true,
      thresholds: {
        ...projectThresholds,
        ...Object.fromEntries(
          packages.map((name) => [
            `packages/${name}/src/**`,
            projectThresholds,
          ]),
        ),
        'packages/{live/src/protocol,live/src/store,live/src/computed,live/src/state-context,core/src/config}.ts':
          highRiskThresholds,
      },
    },
  },
});
