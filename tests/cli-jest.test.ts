import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../packages/cli/dist/index.js';
import { freshApp, node, ok, read, repo, tsc } from './support/cli-fixture.js';

/**
 * DX-018: the Jest variant of `make:test` (and the tests `make:resource`
 * writes) compiled and run by Jest itself. Nestvexa packages are ESM only, so
 * the project is ESM and Jest runs its native ESM mode on the compiled output.
 */
describe('generated tests on a Jest project', { timeout: 600_000 }, () => {
  let root = '';
  beforeAll(() => {
    root = freshApp('jest-app', { directory: 'cli-jest' });
    const pkg = JSON.parse(read(root, 'package.json')) as {
      devDependencies: Record<string, string>;
    };
    pkg.devDependencies['jest'] = '30.5.2';
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify(pkg, null, 2) + '\n',
    );
    for (const step of [
      ['init'],
      ['make:component', 'Clock'],
      ['make:page', 'Home'],
      ['make:form', 'Contact'],
      ['make:action', 'Billing'],
      ['make:resource', 'Task', '--crud'],
    ])
      ok(run(step, root));
  }, 240_000);

  it('writes @jest/globals tests and declares the dependency', () => {
    for (const [name, file] of [
      ['Clock', 'src/nestvexa/components/clock.component.spec.ts'],
      ['Home', 'src/pages/home.controller.spec.ts'],
      ['Contact', 'src/nestvexa/forms/contact.form.spec.ts'],
      ['Billing', 'src/actions/billing.actions.spec.ts'],
      ['Nestvexa', 'test/nestvexa.e2e-spec.ts'],
    ] as const) {
      ok(run(['make:test', name], root));
      expect(read(root, file), file).toContain("from '@jest/globals'");
    }
    expect(read(root, 'src/task/task.service.spec.ts')).toContain(
      "from '@jest/globals'",
    );
    const pkg = JSON.parse(read(root, 'package.json')) as {
      devDependencies: Record<string, string>;
    };
    expect(pkg.devDependencies).toMatchObject({ '@jest/globals': '30.5.2' });
    expect(pkg.devDependencies['vitest']).toBeUndefined();
  });

  it('compiles and passes under Jest', () => {
    const compiled = tsc(root);
    expect(compiled.status, compiled.output).toBe(0);
    writeFileSync(
      join(root, 'jest.config.json'),
      JSON.stringify({
        testEnvironment: 'node',
        transform: {},
        // testRegex, not testMatch globs: the worktree path contains a dot
        // directory (.claude) that micromatch globs never traverse.
        roots: ['<rootDir>/dist'],
        // The e2e smoke test is compiled but not run: it boots AppModule without
        // the main.ts setup (sessions, configureNestvexa), so Live pages answer
        // 500 there. The resource HTTP test boots its own controller.
        testRegex: '\\.spec\\.js$',
      }),
    );
    const result = node(
      [
        '--experimental-vm-modules',
        join(repo, 'node_modules', 'jest', 'bin', 'jest.js'),
        '--config',
        'jest.config.json',
        '--ci',
        '--runInBand',
      ],
      root,
      { ...process.env, NODE_ENV: 'test', NODE_OPTIONS: '' },
    );
    expect(result.status, result.output).toBe(0);
    // component, page, form, action + resource DTO, service and HTTP controller.
    expect(result.output).toMatch(/Test Suites: 7 passed, 7 total/);
  });
});
