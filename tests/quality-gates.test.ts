import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// QA-081 / QA-052: the flaky-test gate over the Playwright JSON report.
// QA-040 / QA-049 / QA-090: the public API report generator behind
// `pnpm api:check`.

interface FlakyTest {
  file: string;
  line: number | null;
  title: string;
  project: string;
  attempts: number;
  errors: string[];
}
interface FlakyResult {
  mode: 'report' | 'block';
  count: number;
  flaky: FlakyTest[];
  failed: boolean;
}
interface FlakyModule {
  collectFlaky(report: unknown): FlakyTest[];
  evaluate(report: unknown, mode: 'report' | 'block'): FlakyResult;
  summaryMarkdown(result: FlakyResult): string;
}
interface ReportChange {
  file: string;
  current: string | undefined;
  next: string;
}
interface ApiReportModule {
  listPackages(root: string): {
    dir: string;
    name: string;
    entries: { specifier: string; types: string }[];
  }[];
  generateReports(root: string): Map<string, string>;
  compareReports(
    reports: Map<string, string>,
    directory: string,
  ): Promise<{ changed: ReportChange[]; stale: string[] }>;
  describeChange(change: ReportChange): string;
}

const flaky = (await import(
  new URL('../scripts/flaky-check.mjs', import.meta.url).href
)) as FlakyModule;
const api = (await import(
  new URL('../scripts/api-report.mjs', import.meta.url).href
)) as ApiReportModule;

const result = (status: string, message?: string) => ({
  status,
  ...(message === undefined ? {} : { error: { message } }),
});

/** A Playwright JSON report shaped like the reporter's output. */
const playwrightReport = (flakyCount = 1) => ({
  stats: { expected: 2, unexpected: 0, skipped: 0, flaky: flakyCount },
  suites: [
    {
      title: 'live.spec.ts',
      file: 'live.spec.ts',
      specs: [
        {
          title: 'counts',
          file: 'live.spec.ts',
          line: 4,
          tests: [
            {
              projectName: 'chromium',
              status: 'expected',
              results: [result('passed')],
            },
          ],
        },
      ],
      suites: [
        {
          title: 'navigation',
          file: 'live.spec.ts',
          specs: [
            {
              title: 'restores | focus',
              file: 'live.spec.ts',
              line: 12,
              tests: [
                {
                  projectName: 'webkit',
                  status: 'flaky',
                  results: [
                    result(
                      'failed',
                      '\u001b[31mTimeout 5000ms exceeded\u001b[39m\nCall log:',
                    ),
                    result('timedOut', 'Test timeout of 30000ms exceeded.'),
                    result('passed'),
                  ],
                },
                {
                  projectName: 'firefox',
                  status: 'unexpected',
                  results: [result('failed', 'real failure')],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
});

describe('flaky Playwright outcomes', () => {
  it('lists only tests whose final outcome is flaky, with location and attempts', () => {
    expect(flaky.collectFlaky(playwrightReport())).toEqual([
      {
        file: 'live.spec.ts',
        line: 12,
        title: 'navigation › restores | focus',
        project: 'webkit',
        attempts: 3,
        errors: [
          'Timeout 5000ms exceeded',
          'Test timeout of 30000ms exceeded.',
        ],
      },
    ]);
  });

  it('reports without failing in report mode and fails in block mode', () => {
    expect(flaky.evaluate(playwrightReport(), 'report')).toMatchObject({
      count: 1,
      failed: false,
    });
    expect(flaky.evaluate(playwrightReport(), 'block')).toMatchObject({
      count: 1,
      failed: true,
    });
  });

  it('passes block mode only when nothing is flaky', () => {
    const clean = playwrightReport(0);
    const nested = clean.suites[0]?.suites[0]?.specs[0]?.tests[0];
    if (nested) nested.status = 'expected';
    expect(flaky.evaluate(clean, 'block')).toMatchObject({
      count: 0,
      failed: false,
    });
  });

  it('trusts the stats counter when the suite tree does not show the flake', () => {
    // A future reporter shape change must not turn flakes into a pass.
    expect(
      flaky.evaluate({ stats: { flaky: 2 }, suites: [] }, 'block'),
    ).toMatchObject({ count: 2, failed: true, flaky: [] });
  });

  it.each([null, 'text', 42, [], { suites: 'x' }, { suites: [null, 1] }])(
    'treats malformed report %j as having no listed flakes',
    (report) => {
      expect(flaky.collectFlaky(report)).toEqual([]);
    },
  );

  it('writes an escaped markdown summary naming the policy', () => {
    const summary = flaky.summaryMarkdown(
      flaky.evaluate(playwrightReport(), 'report'),
    );
    expect(summary).toContain('### Flaky tests: 1');
    expect(summary).toContain('docs/testing/flaky-tests.md');
    expect(summary).toContain('restores \\| focus');
    expect(summary).toContain('| webkit | live.spec.ts:12 |');
    expect(summary).toContain('Reported only');
    expect(
      flaky.summaryMarkdown(flaky.evaluate(playwrightReport(), 'block')),
    ).toContain('Blocking');
    expect(
      flaky.summaryMarkdown({
        mode: 'block',
        count: 0,
        flaky: [],
        failed: false,
      }),
    ).toContain('No flaky Playwright tests.');
  });
});

// Each case builds TypeScript programs; allow for slow shared hosts.
describe('public API reports', { timeout: 60000 }, () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  /** A tiny workspace with one published and one private package. */
  function workspace(typings: string, extra: Record<string, string> = {}) {
    const root = mkdtempSync(join(tmpdir(), 'nv-api-report-'));
    roots.push(root);
    const write = (path: string, text: string) => {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    write(
      'packages/demo/package.json',
      JSON.stringify({
        name: '@nestvexa/demo',
        exports: {
          '.': { types: './dist/index.d.ts', import: './dist/index.js' },
          './extra': { import: './dist/extra.js' },
          './theme.css': './theme.css',
        },
      }),
    );
    write('packages/demo/dist/index.d.ts', typings);
    write(
      'packages/demo/dist/extra.d.ts',
      extra['extra.d.ts'] ?? 'export declare const extra: 1;\n',
    );
    write(
      'packages/hidden/package.json',
      JSON.stringify({ name: '@nestvexa/hidden', private: true }),
    );
    write('packages/hidden/dist/index.d.ts', 'export declare const x: 1;\n');
    return root;
  }

  const base = [
    'interface Options { readonly retries?: number; }',
    '/** Creates a client. */',
    'export declare function create(options?: Options): Client;',
    'export declare class Client { send(body: string): Promise<void>; }',
    'export type Mode = "a" | "b";',
    // tsc emits this so unexported declarations stay module-private.
    'export {};',
    '',
  ].join('\n');

  it('lists published packages and typed entry points only', () => {
    const packages = api.listPackages(workspace(base));
    expect(packages).toEqual([
      expect.objectContaining({
        dir: 'demo',
        name: '@nestvexa/demo',
        entries: [
          expect.objectContaining({
            specifier: '@nestvexa/demo',
            types: './dist/index.d.ts',
          }),
          expect.objectContaining({
            specifier: '@nestvexa/demo/extra',
            types: './dist/extra.d.ts',
          }),
        ],
      }),
    ]);
  });

  it('renders sorted exports and the unexported declarations they reference', () => {
    const report = api.generateReports(workspace(base)).get('demo.api.md');
    expect(report).toBeDefined();
    const text = report ?? '';
    expect(text.indexOf('// Client')).toBeLessThan(text.indexOf('// create'));
    expect(text.indexOf('// create')).toBeLessThan(text.indexOf('// Mode'));
    expect(text).toContain(
      'declare function create(options?: Options): Client;',
    );
    expect(text).toContain('## Referenced but not exported');
    expect(text).toContain('// Options (dist/index.d.ts)');
    expect(text).toContain('readonly retries?: number;');
    expect(text).toContain('## `@nestvexa/demo/extra`');
    expect(text).toContain('declare const extra: 1;');
    expect(text).not.toContain('Creates a client');
    expect(text).not.toContain('\r');
  });

  it('is deterministic and ignores documentation-only edits', () => {
    const first = api.generateReports(workspace(base)).get('demo.api.md');
    const documented = api
      .generateReports(
        workspace(`/** Module docs. */\n${base.replace('Creates', 'Builds')}`),
      )
      .get('demo.api.md');
    expect(documented).toBe(first);
  });

  it.each([
    ['a changed parameter', base.replace('body: string', 'body: Uint8Array')],
    ['a removed export', base.replace(/export type Mode.*\n/, '')],
    [
      'a change inside an unexported referenced interface',
      base.replace('retries?: number', 'retries?: string'),
    ],
  ])('detects %s against the committed report', async (_, changed) => {
    const committed = workspace(base);
    const directory = join(committed, 'api-reports');
    mkdirSync(directory);
    for (const [file, text] of api.generateReports(committed))
      writeFileSync(join(directory, file), text.replace(/\n/g, '\r\n'));
    // CRLF checkouts compare equal to the LF reports.
    expect(
      await api.compareReports(api.generateReports(committed), directory),
    ).toEqual({ changed: [], stale: [] });

    const next = api.generateReports(workspace(changed));
    const comparison = await api.compareReports(next, directory);
    expect(comparison.changed.map((change) => change.file)).toEqual([
      'demo.api.md',
    ]);
    const [change] = comparison.changed;
    if (!change) throw new Error('expected a change');
    expect(api.describeChange(change)).toMatch(/^demo\.api\.md:\n {2}[-+] /);
  });

  it('flags reports for packages that are no longer published', async () => {
    const root = workspace(base);
    const directory = join(root, 'api-reports');
    mkdirSync(directory);
    writeFileSync(join(directory, 'gone.api.md'), 'old');
    const comparison = await api.compareReports(
      api.generateReports(root),
      directory,
    );
    expect(comparison.stale).toEqual(['gone.api.md']);
    expect(comparison.changed.map((change) => change.file)).toEqual([
      'demo.api.md',
    ]);
    expect(
      api.describeChange(
        comparison.changed[0] ?? { file: '', next: '', current: undefined },
      ),
    ).toContain('new report');
  });

  it('marks entry points whose typings are not built', () => {
    const root = workspace(base);
    rmSync(join(root, 'packages/demo/dist/extra.d.ts'));
    expect(api.generateReports(root).get('demo.api.md')).toContain(
      'Typings not built',
    );
  });
});
