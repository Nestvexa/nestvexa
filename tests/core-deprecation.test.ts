import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  NESTVEXA_DEPRECATIONS,
  emitDeprecation,
} from '../packages/core/dist/index.js';

// MAINT-017: runtime deprecation warnings. Once-per-process behaviour is
// checked in fresh Node processes, so the order of tests in this worker and
// warnings other suites already emitted cannot hide or fake a result.
const repository = resolve(import.meta.dirname, '..');
const core = pathToFileURL(
  join(repository, 'packages/core/dist/index.js'),
).href;
const plugin = `{ manifest: { name: '@acme/charts', version: '1.0.0', nestvexa: '^0.1.0-alpha.0', capabilities: ['ui-kit'] } }`;

function script(flags: readonly string[], body: string) {
  const result = spawnSync(
    process.execPath,
    [
      ...flags,
      '--input-type=module',
      '-e',
      `import * as core from ${JSON.stringify(core)};\n${body}`,
    ],
    { encoding: 'utf8', cwd: repository, timeout: 60_000 },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    warnings:
      result.stderr.match(/\[[A-Z0-9]+\] DeprecationWarning: .*/g) ?? [],
  };
}

// Each case starts Node and loads @nestvexa/core with Nest; allow for loaded hosts.
describe('deprecated plugin adapter warnings', { timeout: 90_000 }, () => {
  it('warns once per code per process for definePlugin and PluginRegistry', () => {
    const run = script(
      [],
      `const plugin = ${plugin};
for (let i = 0; i < 3; i++) core.definePlugin(plugin);
const registry = new core.PluginRegistry();
new core.PluginRegistry();
registry.install(plugin);
console.log(registry.list().length);`,
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe('1');
    expect(run.warnings).toEqual([
      `[NVDEP001] DeprecationWarning: ${NESTVEXA_DEPRECATIONS.NVDEP001}`,
      `[NVDEP002] DeprecationWarning: ${NESTVEXA_DEPRECATIONS.NVDEP002}`,
    ]);
  });

  it('does not warn on the migration path (pluginExtension, defineExtension)', () => {
    const run = script(
      [],
      `const extension = core.pluginExtension(${plugin});
core.defineExtension({ name: 'acme.other' });
console.log(extension.name);`,
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe('acme.charts');
    expect(run.warnings).toEqual([]);
    expect(run.stderr).not.toContain('DeprecationWarning');
  });

  it('honours --no-deprecation and reports that nothing was emitted', () => {
    const run = script(
      ['--no-deprecation'],
      `core.definePlugin(${plugin});
new core.PluginRegistry();
console.log(core.emitDeprecation('ACMEDEP001', 'Use the new thing.'));`,
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe('false');
    expect(run.stderr).not.toContain('DeprecationWarning');
  });

  it('follows --throw-deprecation like Node core deprecations', () => {
    const run = script(
      ['--throw-deprecation'],
      `core.definePlugin(${plugin});`,
    );
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('NVDEP001');
  });

  it('adds a stack trace with --trace-deprecation', () => {
    const run = script(['--trace-deprecation'], `new core.PluginRegistry();`);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toMatch(
      /\[NVDEP002\] DeprecationWarning: [^\n]+\n\s+at /,
    );
  });
});

describe('emitDeprecation', () => {
  it('emits a DeprecationWarning with the code once, then returns false', async () => {
    const received: Error[] = [];
    const listener = (warning: Error) => received.push(warning);
    process.on('warning', listener);
    try {
      const code = 'VITESTDEP' + String(process.pid % 1000).padStart(3, '0');
      expect(emitDeprecation(code, 'Use the replacement.')).toBe(true);
      expect(emitDeprecation(code, 'Use the replacement.')).toBe(false);
      // Warnings are delivered on the next tick.
      await new Promise((done) => setImmediate(done));
      const ours = received.filter(
        (warning) => Reflect.get(warning, 'code') === code,
      );
      expect(ours).toHaveLength(1);
      expect(ours[0]).toMatchObject({
        name: 'DeprecationWarning',
        message: 'Use the replacement.',
      });
    } finally {
      process.off('warning', listener);
    }
  });

  it('rejects malformed codes and empty messages', () => {
    for (const code of [
      '',
      'NVDEP1',
      'nvdep001',
      'NVDEP0001',
      'DEP001',
      'NV-DEP001',
      'NVDEP001 ',
      'A'.repeat(17) + 'DEP001',
    ])
      expect(() => emitDeprecation(code, 'message'), code).toThrow(
        /Deprecation codes look like NVDEP001/,
      );
    expect(() => emitDeprecation('ACMEDEP002', '  ')).toThrow(
      /needs a message/,
    );
    expect(() =>
      emitDeprecation('ACMEDEP003', undefined as unknown as string),
    ).toThrow(/needs a message/);
  });

  it('documents every framework code in the deprecation policy table', () => {
    const policy = readFileSync(
      join(repository, 'docs/release/versioning-and-deprecation.md'),
      'utf8',
    );
    const documented = [...policy.matchAll(/^\| `(NVDEP\d{3})` \|/gm)].map(
      (match) => match[1],
    );
    expect(documented).toEqual(Object.keys(NESTVEXA_DEPRECATIONS));
    expect(Object.isFrozen(NESTVEXA_DEPRECATIONS)).toBe(true);
  });
});
