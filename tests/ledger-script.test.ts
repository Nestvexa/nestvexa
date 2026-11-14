import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// LEDGER-025: the ledger checker itself. `check` must reject Done rows whose
// cited implementation or test files still carry unfinished-work markers,
// stubs or skipped tests, and its built-in self-test must pass (CI runs both).

const repository = resolve(import.meta.dirname, '..');
interface Row {
  id: string;
  sourceKey: string;
  state: string;
  implementationFiles: string[];
  testFiles: string[];
  docs: string[];
  examples: string[];
  securityNotes?: string;
  validationEvidence?: unknown[];
  outstandingIssues: string[];
}
interface LedgerModule {
  extractRequirements(source: string): { sourceKey: string }[];
  findWorkMarkers(contents: string): string[];
  validateLedger(
    ledger: { sourceSha256: string; features: Row[] },
    source: string,
    options?: {
      release?: boolean;
      fileExists?: (path: string) => boolean;
      readEvidence?: (path: string) => string;
    },
  ): string[];
}
const ledger = (await import(
  new URL('../scripts/ledger.mjs', import.meta.url).href
)) as LedgerModule;

const source = '## 4. API\n### 4.1 Setup\n- Implement config\n';
// Assembled so this test file carries no marker itself.
const word = (head: string, tail: string) => head + tail;

function doneLedger(): { sourceSha256: string; features: Row[] } {
  const features = ledger.extractRequirements(source).map((item, index) => ({
    ...item,
    id: 'TEST-' + String(index),
    state: 'Pending',
    implementationFiles: [],
    testFiles: [],
    docs: [],
    examples: [],
    outstandingIssues: [],
  }));
  const first = features[0];
  if (!first) throw new Error('fixture extracted no requirement');
  Object.assign(first, {
    state: 'Done',
    implementationFiles: ['packages/example/src/store.ts'],
    testFiles: ['tests/example.test.ts'],
    docs: ['docs/example.md'],
    examples: ['examples/example/main.ts'],
    securityNotes: 'Reviewed.',
    validationEvidence: [
      {
        command: 'pnpm test',
        exitCode: 0,
        executedAt: '2026-11-14T00:00:00Z',
        report: 'artifacts/reports/test.json',
      },
    ],
  });
  return {
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    features,
  };
}
const evidence = (files: Record<string, string>) => ({
  fileExists: () => true,
  readEvidence: (path: string) => {
    const key = Object.keys(files).find((name) => path.endsWith(name));
    return key === undefined ? 'export const ok = 1;\n' : (files[key] ?? '');
  },
});

describe('ledger check: unfinished-work markers in Done evidence', () => {
  it('accepts a complete Done row with clean evidence', () => {
    expect(ledger.validateLedger(doneLedger(), source, evidence({}))).toEqual(
      [],
    );
  });

  it.each([
    ['implementation', 'store.ts', `// ${word('TO', 'DO')}: persist`],
    ['implementation', 'store.ts', `/* ${word('FIX', 'ME')} */`],
    ['implementation', 'store.ts', `return x; // ${word('X', 'XX')}`],
    [
      'implementation',
      'store.ts',
      `export const adapter = '${word('ST', 'UB')}';`,
    ],
    ['implementation', 'store.ts', '// Not ye' + 't implemented'],
    ['test', 'example.test.ts', `// ${word('TO', 'DO')} cover the error path`],
  ])('rejects a %s file with %s marker %s', (_kind, file, line) => {
    const errors = ledger.validateLedger(
      doneLedger(),
      source,
      evidence({ [file]: `export const a = 1;\n${line}\n` }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(
      new RegExp(
        `^TEST-0 cites evidence with unfinished-work markers: \\S*${file.replace('.', '\\.')} \\(line 2: `,
      ),
    );
  });

  it('lists at most three marker lines per file', () => {
    const marker = word('TO', 'DO');
    const errors = ledger.validateLedger(
      doneLedger(),
      source,
      evidence({
        'store.ts': [1, 2, 3, 4, 5].map((n) => `${marker} ${n}`).join('\n'),
      }),
    );
    expect(errors).toEqual([
      `TEST-0 cites evidence with unfinished-work markers: packages/example/src/store.ts (line 1: ${marker} 1; line 2: ${marker} 2; line 3: ${marker} 3; ...)`,
    ]);
  });

  it('does not report lower-case stub names or markup', () => {
    expect(
      ledger.findWorkMarkers(
        [
          'const stub = vi.fn();',
          "if (!element.hasAttribute('data-nv-stub')) return;",
          '// a todo-list example; fixme-style names are fine',
          "const STUBBORN = 'not a marker';",
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('checks only Done rows', () => {
    const pending = doneLedger();
    const first = pending.features[0];
    if (!first) throw new Error('fixture extracted no requirement');
    first.state = 'InProgress';
    expect(
      ledger.validateLedger(
        pending,
        source,
        evidence({ 'store.ts': word('TO', 'DO') }),
      ),
    ).toEqual([]);
  });

  it('keeps the existing stub and skipped-test rejections', () => {
    expect(
      ledger.validateLedger(
        doneLedger(),
        source,
        evidence({ 'store.ts': 'throw new Error(' + "'not implemented')" }),
      ),
    ).toEqual([
      'TEST-0 contains unimplemented runtime evidence: packages/example/src/store.ts',
    ]);
    expect(
      ledger.validateLedger(
        doneLedger(),
        source,
        evidence({ 'example.test.ts': 'it.' + "only('x', () => {});" }),
      ),
    ).toEqual([
      'TEST-0 contains skipped/focused test evidence: tests/example.test.ts',
    ]);
  });
});

describe('ledger script commands', () => {
  const run = (command: string) =>
    spawnSync(process.execPath, ['scripts/ledger.mjs', command], {
      cwd: repository,
      encoding: 'utf8',
      timeout: 60_000,
    });

  it('passes its self-test, including the marker cases', () => {
    const result = run('--self-test');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('unfinished-work markers');
  });

  it('accepts the committed ledger', () => {
    const result = run('check');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^Ledger valid: \d+ requirements; \d+ Done/);
  });

  it('rejects unknown commands', () => {
    const result = run('publish');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Usage: node scripts/ledger.mjs');
  });
});

describe('ci.yml ledger job', () => {
  it('runs the self-test and the check on every CI run', () => {
    const workflow = readFileSync(
      join(repository, '.github/workflows/ci.yml'),
      'utf8',
    );
    const job = /\n {2}ledger:\n([\s\S]*?)(?=\n {2}[a-z-]+:\n|$)/.exec(
      workflow,
    )?.[1];
    expect(job).toBeDefined();
    expect(job).not.toContain('if:');
    expect(job).toContain('run: node scripts/ledger.mjs --self-test');
    expect(job).toContain('run: node scripts/ledger.mjs check');
  });
});
