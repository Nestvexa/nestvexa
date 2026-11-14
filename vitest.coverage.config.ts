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
}[] = [
  {
    glob: 'packages/client/src/{index,bindings,control-state,focus,form-reset,initialization,listeners,loading,models,morph,navigation,observers,presentation,sort,stream,upload}.ts',
    reason:
      'Live browser runtime: DOM mounting, morphing, focus, observers, drag and drop, uploads and streaming. The tests/client-*.test.ts suites serve the built modules to Chromium, Firefox and WebKit, where V8 coverage in Node cannot see them. The pure modules (protocol, grammar, events, transport, realtime, url-state, optimistic, action-input, model-scheduler) stay gated.',
  },
  {
    glob: 'packages/offline/src/index.ts',
    reason:
      'Browser drafts, snapshots, logout broadcast and offline queue over DOM forms, Web Storage and BroadcastChannel, run in browsers by tests/offline-drafts, offline-snapshot and offline-queue-browsers. The server half (packages/offline/src/server) stays gated.',
  },
  {
    glob: 'packages/ui/src/{browser/index,adapters/react,adapters/vue}.ts',
    reason:
      'UI kit browser behaviour and the interactive React/Vue components, exercised in browsers by tests/ui-browser, ui-primitives-browser and ui-adapters. The server markup modules stay gated.',
  },
  {
    glob: 'packages/islands/src/{client,react,vue,svelte}.ts',
    reason:
      'Island loader and the React/Vue/Svelte mount and hydrate adapters (react-dom/client, createApp, hydrate), exercised in browsers by tests/islands-client and the hybrid Playwright specs. Server rendering and signing stay gated.',
  },
  {
    glob: 'packages/{react,vue,svelte}/src/{client,boundary}.ts',
    reason:
      'Inertia client boot (createInertiaApp with createRoot/hydrateRoot, mount or hydrate) and client error boundaries, exercised by the Inertia Playwright specs. The SSR entry points and page registries stay gated.',
  },
  {
    glob: 'packages/actions/src/client/element.ts',
    reason:
      'bindActionElement wires a server-rendered form or button to an action through DOM attributes, aria-invalid fields and bubbling nv:action events; exercised in Chromium by tests/actions-client-state. The framework-neutral controller (client/state.ts) stays gated.',
  },
  {
    glob: 'packages/ai/src/browser/index.ts',
    reason:
      'connectAssistant binds the Live assistant panel (stream start, stop button) to DOM elements; exercised in Chromium by tests/ai-browser. The assistant service and providers stay gated.',
  },
];

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
