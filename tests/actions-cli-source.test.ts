import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// `nestvexa-actions-codegen` (packages/actions/src/cli.ts) run in-process: the
// module executes its command on import, so each case sets `process.argv`,
// re-imports a fresh copy and reads `process.exitCode`. The codegen itself is
// covered by tests/actions-codegen.test.ts.

const work = mkdtempSync(join(tmpdir(), 'nv-actions-cli-'));
const fixture = (name: string) =>
  resolve(import.meta.dirname, 'fixtures', 'actions-codegen', name);
function project(name: string, files: string[]): string {
  const path = join(work, `${name}.tsconfig.json`);
  writeFileSync(
    path,
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        skipLibCheck: true,
      },
      files,
    }),
  );
  return path;
}

const argv = process.argv;
afterEach(() => {
  process.argv = argv;
  process.exitCode = undefined;
  vi.restoreAllMocks();
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

async function cli(...args: string[]) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  process.argv = ['node', 'nestvexa-actions-codegen', ...args];
  vi.resetModules();
  await import('../packages/actions/src/cli.js');
  const code = process.exitCode;
  process.exitCode = undefined;
  return {
    code,
    stdout: log.mock.calls.map((call) => String(call[0])).join('\n'),
    stderr: error.mock.calls.map((call) => String(call[0])).join('\n'),
  };
}

describe('nestvexa-actions-codegen arguments', () => {
  it('prints usage for --help', async () => {
    const result = await cli('--help');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      'Usage: nestvexa-actions-codegen --out <dir>',
    );
  });

  it.each([
    [['stray'], 'Unexpected argument stray'],
    [['--bogus', 'x'], 'Unknown option --bogus'],
    [['--out'], 'Missing value for --out'],
    [['--out', '--check'], 'Missing value for --out'],
  ])('rejects %j with usage and exit code 2', async (args, message) => {
    const result = await cli(...args);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(message);
    expect(result.stderr).toContain('Usage:');
  });

  it('requires --out', async () => {
    const result = await cli('--check');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Usage:');
  });

  it('requires a project when the working directory has no tsconfig.json', async () => {
    const previous = process.cwd();
    try {
      process.chdir(work);
      const result = await cli('--out', join(work, 'none'));
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('No --project given');
    } finally {
      process.chdir(previous);
    }
  });

  it('rejects unknown targets', async () => {
    const result = await cli(
      '--out',
      join(work, 'none'),
      '--project',
      'tsconfig.json',
      '--targets',
      'react, angular',
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      'Unknown target angular; use react,vue,svelte,live',
    );
  });
});

describe('nestvexa-actions-codegen generation', { timeout: 180_000 }, () => {
  it('writes the client and target helpers, then reports them up to date with --check', async () => {
    const out = join(work, 'generated');
    const tsconfig = project('shop', [fixture('shop.actions.ts')]);
    const written = await cli(
      '--out',
      out,
      '--project',
      tsconfig,
      '--name',
      'shop-client',
      '--client-module',
      '@nestvexa/actions/client',
      '--targets',
      'react,live',
    );
    expect(written.stderr).toBe('');
    expect(written.code).toBe(0);
    expect(written.stdout).toMatch(
      /group\(s\), \d+ action\(s\); \d+ file\(s\) written/,
    );
    expect(readdirSync(out).sort()).toEqual(
      expect.arrayContaining([
        'shop-client.d.ts',
        'shop-client.js',
        'shop-client.react.js',
        'shop-client.live.js',
      ]),
    );
    const checked = await cli(
      '--out',
      out,
      '--project',
      tsconfig,
      '--name',
      'shop-client',
      '--targets',
      'react,live',
      '--check',
    );
    expect(checked.code).toBe(0);
    expect(checked.stdout).toContain('up to date');
  });

  it('exits 1 and prints diagnostics for invalid action groups', async () => {
    const result = await cli(
      '--out',
      join(work, 'invalid'),
      '--project',
      project('invalid', [fixture('invalid.actions.ts')]),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).not.toBe('');
  });
});
