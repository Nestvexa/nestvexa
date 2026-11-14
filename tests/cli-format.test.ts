import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../packages/cli/dist/index.js';
import { freshApp, json, ok, read, tsc } from './support/cli-fixture.js';

/**
 * Generated files go through the project's own ESLint (--fix) and Prettier
 * (DX-030/DX-031). The fixture declares both and configures a style the CLI
 * templates do not use (no semicolons, double quotes, mandatory braces), so
 * every assertion proves the project configuration was applied.
 */
const eslintConfig = `import tseslint from 'typescript-eslint';

export default tseslint.config({
  files: ['**/*.ts'],
  extends: [tseslint.configs.base],
  rules: { curly: ['error', 'all'] },
});
`;
const uglyMain = (text: string) =>
  text.replace(
    "import { AppModule } from './app.module.js';",
    "import { AppModule } from './app.module.js';\nconst  untouched = [1,2,3];\nvoid untouched;",
  );

describe(
  'formatting generated files with the project tools',
  { timeout: 900_000 },
  () => {
    let root = '';
    beforeAll(() => {
      root = freshApp('format-app', { directory: 'cli-format' });
      const pkg = JSON.parse(read(root, 'package.json')) as {
        devDependencies: Record<string, string>;
      };
      pkg.devDependencies['prettier'] = '3.9.10';
      pkg.devDependencies['eslint'] = '10.13.0';
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(pkg, null, 2) + '\n',
      );
      writeFileSync(
        join(root, '.prettierrc'),
        JSON.stringify({ semi: false, singleQuote: false, printWidth: 100 }),
      );
      writeFileSync(join(root, '.prettierignore'), 'src/pages/\n');
      writeFileSync(join(root, 'eslint.config.mjs'), eslintConfig);
      writeFileSync(
        join(root, 'src/main.ts'),
        uglyMain(read(root, 'src/main.ts')),
      );
    }, 120_000);

    it('formats created files and keeps unrelated lines of unformatted user files', () => {
      const result = json(run(['init', '--json'], root));
      expect(result.ok).toBe(true);
      expect(result.messages?.join('\n')).toMatch(
        /ESLint fixed \d+, Prettier formatted \d+ of \d+ written file\(s\)/,
      );
      const config = read(root, 'src/nestvexa/nestvexa.config.ts');
      expect(config).toContain(
        'import { UnauthorizedException } from "@nestjs/common"\n',
      );
      expect(config).not.toMatch(/;\n/);
      const main = read(root, 'src/main.ts');
      // main.ts was not formatted before, so only the inserted lines changed.
      expect(main).toContain('const  untouched = [1,2,3];');
      expect(main).toContain('configureNestvexa(app)');
      // package.json was already Prettier-clean JSON and stays parseable.
      expect(JSON.parse(read(root, 'package.json'))).toHaveProperty(
        'dependencies.nestvexa',
      );
    });

    it('applies ESLint fixes, then Prettier, and stays idempotent and removable', () => {
      ok(run(['make:policy', 'Owner'], root));
      const policy = read(root, 'src/policies/owner.policy.ts');
      // curly (ESLint --fix) and the Prettier style of the project.
      expect(policy).toMatch(
        /if \(!request\.user\) \{\n\s+throw new ForbiddenException\(\)\n\s+\}/,
      );
      expect(policy).not.toMatch(/;\n/);
      expect(json(run(['make:policy', 'Owner', '--json'], root))).toMatchObject(
        {
          ok: true,
          changes: [],
        },
      );
      writeFileSync(
        join(root, 'src/policies/owner.policy.ts'),
        `${policy}// edited\n`,
      );
      const conflict = run(['make:policy', 'Owner'], root);
      expect(conflict.exitCode).toBe(1);
      expect(conflict.stderr.join('\n')).toContain('already exists');
      writeFileSync(join(root, 'src/policies/owner.policy.ts'), policy);
      // The manifest checksum is the formatted output, so remove deletes it.
      const removed = run(['remove', 'policy:owner'], root);
      ok(removed);
      expect(removed.stdout.join('\n')).toContain(
        'Removing 1 unmodified generated file(s).',
      );
    });

    it('honors .prettierignore and --no-format', () => {
      ok(run(['make:page', 'Plain'], root));
      expect(read(root, 'src/pages/plain.controller.ts')).toContain(
        "import { Controller, Get, Render } from '@nestjs/common';",
      );
      ok(run(['make:policy', 'Raw', '--no-format'], root));
      expect(read(root, 'src/policies/raw.policy.ts')).toContain(
        "import { ForbiddenException, Injectable } from '@nestjs/common';",
      );
    });

    it('keeps routes:types --check consistent with the formatted map and the project compiling', () => {
      const routes = json(run(['routes:types', '--json'], root));
      expect(routes.messages?.join('\n')).toMatch(
        /Prettier formatted [1-9]\d* of \d+ written file\(s\)/,
      );
      expect(read(root, 'src/nestvexa/routes.ts')).toContain('} as const\n');
      ok(run(['routes:types', '--check'], root));
      const compiled = tsc(root);
      expect(compiled.status, compiled.output).toBe(0);
    });
  },
);

describe('formatter failures never fail generation', () => {
  const base = mkdtempSync(join(tmpdir(), 'nestvexa-format-'));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const app = (name: string, files: Record<string, string>) => {
    const root = join(base, name);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name,
        dependencies: { '@nestjs/core': '12.2.0' },
        devDependencies: { prettier: '3.9.10', eslint: '10.13.0' },
      }),
    );
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  };

  it('reports a broken formatter package and writes the generator output', () => {
    const root = app('broken', {
      'node_modules/prettier/package.json': JSON.stringify({
        name: 'prettier',
        main: 'index.js',
      }),
      'node_modules/prettier/index.js':
        "throw new Error('prettier exploded');\n",
      'node_modules/eslint/package.json': JSON.stringify({
        name: 'eslint',
        main: 'index.js',
      }),
      'node_modules/eslint/index.js': 'module.exports = {};\n',
    });
    const result = json(run(['make:policy', 'Owner', '--json'], root));
    expect(result.ok).toBe(true);
    const messages = result.messages?.join('\n') ?? '';
    expect(messages).toContain(
      'Prettier could not be loaded: prettier exploded',
    );
    expect(messages).toContain('ESLint could not be loaded');
    expect(read(root, 'src/policies/owner.policy.ts')).toContain(
      '@Injectable()',
    );
  });

  it('skips formatting when the tools are declared but not installed', () => {
    const root = app('missing', {});
    const result = json(run(['make:policy', 'Owner', '--json'], root));
    expect(result.ok).toBe(true);
    expect(result.messages?.join('\n')).not.toContain('Prettier');
  });
});
