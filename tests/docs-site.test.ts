import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { collectEntries, extractApi } from '../apps/docs/src/api-reference.mjs';
import { analyse, createSlugger, slug } from '../apps/docs/src/markdown.mjs';

const builder = join(
  dirname(fileURLToPath(import.meta.url)),
  '../apps/docs/src/build.mjs',
);
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

type Files = Record<string, string>;

const manifest = (name: string, dependencies: Record<string, string> = {}) =>
  JSON.stringify({
    name,
    version: '0.0.1',
    description: `${name} fixture`,
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
    },
    dependencies,
  });

/** A minimal repository that passes every check; tests break one rule each. */
function validFixture(): Files {
  return {
    'docs/index.md': [
      '# Fixture',
      '',
      '## Usage',
      '',
      'See [the guide](guide.md#first-steps) and [usage](#usage).',
      '',
    ].join('\n'),
    'docs/guide.md': [
      '# Guide',
      '',
      '## First steps',
      '',
      '<!-- snippet: src/example.ts -->',
      '',
      '```ts',
      'export const answer = 42;',
      '```',
      '',
    ].join('\n'),
    'src/example.ts': '// Example\nexport const answer = 42;\n',
    'docs/feature-matrix.md':
      '# Matrix\n\n`@fixture/core` and `@fixture/views`.\n',
    'docs/architecture/overview.md':
      '# Overview\n\n[core](../../packages/core/) and [views](../../packages/views/).\n',
    'docs/architecture/package-dependency-graph.md': [
      '# Graph',
      '',
      '```mermaid',
      'flowchart TD',
      '  core --> views',
      '```',
      '',
    ].join('\n'),
    'packages/core/package.json': manifest('@fixture/core', {
      '@fixture/views': 'workspace:*',
    }),
    'packages/core/README.md': '# Core\n',
    'packages/core/dist/index.d.ts': [
      '/** Adds two numbers. */',
      'export declare function add(left: number, right: number): number;',
      '/** @deprecated Use add. */',
      'export declare const legacy: number;',
      'export interface Options { readonly strict: boolean }',
      '',
    ].join('\n'),
    'packages/views/package.json': manifest('@fixture/views'),
    'packages/views/dist/index.d.ts': 'export type Html = string;\n',
  };
}

async function repository(files: Files): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nestvexa-docs-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

function check(root: string) {
  const result = spawnSync(
    process.execPath,
    [builder, '--root', root, '--check-only'],
    { encoding: 'utf8' },
  );
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

describe('docs markdown helpers', () => {
  it('slugs headings like GitHub, including duplicates', () => {
    expect(slug('Amendment (2026-11-01): CommonJS hosts')).toBe(
      'amendment-2026-11-01-commonjs-hosts',
    );
    expect(slug('`nv:model` — two-way')).toBe('nvmodel--two-way');
    const next = createSlugger();
    expect([next('Usage'), next('Usage'), next('Usage')]).toEqual([
      'usage',
      'usage-1',
      'usage-2',
    ]);
  });

  it('collects links in tables and lists, html anchors and snippets', () => {
    const result = analyse(
      [
        '# Title',
        '',
        '<a id="custom"></a>',
        '',
        '| A | B |',
        '| - | - |',
        '| [x](a.md) | y |',
        '',
        '- [item](b.md#part)',
        '',
        '<!-- snippet: src/x.ts -->',
        '',
        '```ts',
        'const x = 1;',
        '```',
        '',
        '<!-- snippet: src/y.ts -->',
        '',
        'Not a fence.',
        '',
        '```md',
        '[ignored](inside-code.md)',
        '```',
      ].join('\n'),
    );
    expect(result.links.map((link) => link.href)).toEqual([
      'a.md',
      'b.md#part',
    ]);
    expect(result.anchors.has('custom')).toBe(true);
    expect(result.anchors.has('title')).toBe(true);
    expect(result.snippets).toEqual([
      { source: 'src/x.ts', code: 'const x = 1;' },
      { source: 'src/y.ts', code: undefined },
    ]);
  });
});

describe('docs API reference', () => {
  it('extracts exported declarations, docs and deprecations', async () => {
    const root = await repository(validFixture());
    const { entries, missing } = await collectEntries(root);
    expect(missing).toEqual([]);
    const api = extractApi(root, entries);
    const core = api.find((record) => record.name === '@fixture/core');
    const symbols = core?.subpaths[0]?.symbols ?? [];
    expect(symbols.map((symbol) => [symbol.kind, symbol.name])).toEqual([
      ['function', 'add'],
      ['const', 'legacy'],
      ['interface', 'Options'],
    ]);
    expect(symbols[0]?.summary).toBe('Adds two numbers.');
    expect(symbols[0]?.signatures[0]).toBe(
      'function add(left: number, right: number): number;',
    );
    expect(symbols[1]?.deprecated).toBe(true);
    expect(symbols[1]?.signatures[0]).toBe('const legacy: number;');
  });

  it('reports entry points whose declarations are not built', async () => {
    const files = validFixture();
    delete files['packages/views/dist/index.d.ts'];
    const { missing } = await collectEntries(await repository(files));
    expect(missing).toHaveLength(1);
    expect(missing[0]?.replaceAll('\\', '/')).toBe(
      'packages/views/dist/index.d.ts',
    );
  });
});

describe('docs build checks', { timeout: 60_000 }, () => {
  it('accepts a consistent repository', async () => {
    const result = check(await repository(validFixture()));
    expect(result.output).toContain('Checked');
    expect(result.status).toBe(0);
  });

  it.each([
    [
      'a broken relative link',
      (files: Files) => {
        files['docs/index.md'] += '\n[missing](nowhere.md)\n';
      },
      'broken link "nowhere.md"',
    ],
    [
      'a missing heading anchor',
      (files: Files) => {
        files['docs/index.md'] += '\n[bad](guide.md#no-such-heading)\n';
      },
      'missing anchor "#no-such-heading" in docs/guide.md',
    ],
    [
      'a missing same-page anchor',
      (files: Files) => {
        files['docs/index.md'] += '\n[bad](#nope)\n';
      },
      'missing anchor "#nope" in docs/index.md',
    ],
    [
      'an absolute link',
      (files: Files) => {
        files['docs/index.md'] += '\n[abs](/docs/guide.md)\n';
      },
      'absolute link "/docs/guide.md"',
    ],
    [
      'a skipped heading level',
      (files: Files) => {
        files['docs/index.md'] += '\n#### Too deep\n';
      },
      'skips from H2 to H4',
    ],
    [
      'a page without a leading title',
      (files: Files) => {
        files['docs/extra.md'] = 'Intro first.\n\n# Late title\n';
      },
      'docs/extra.md: must start with a single "# " title',
    ],
    [
      'snippet drift',
      (files: Files) => {
        files['src/example.ts'] = 'export const answer = 41;\n';
      },
      'snippet no longer matches src/example.ts',
    ],
    [
      'a snippet marker without a fence',
      (files: Files) => {
        files['docs/guide.md'] +=
          '\n<!-- snippet: src/example.ts -->\n\nText\n';
      },
      'is not followed by a code fence',
    ],
    [
      'a missing graph edge',
      (files: Files) => {
        files['docs/architecture/package-dependency-graph.md'] =
          '# Graph\n\n```mermaid\nflowchart TD\n  core[core]\n  views[views]\n```\n';
      },
      'missing edge core --> views (dependencies)',
    ],
    [
      'an undeclared graph edge',
      (files: Files) => {
        files['docs/architecture/package-dependency-graph.md'] =
          '# Graph\n\n```mermaid\nflowchart TD\n  core --> views\n  views --> core\n```\n';
      },
      'edge "views --> core" is not declared',
    ],
    [
      'a package missing from the feature matrix',
      (files: Files) => {
        files['docs/feature-matrix.md'] = '# Matrix\n\n`@fixture/core`.\n';
      },
      'docs/feature-matrix.md: does not mention package @fixture/views',
    ],
    [
      'an unbuilt entry point',
      (files: Files) => {
        delete files['packages/core/dist/index.d.ts'];
      },
      'run `pnpm build` before `pnpm docs:build`',
    ],
  ])('rejects %s', async (_name, mutate, message) => {
    const files = validFixture();
    mutate(files);
    const result = check(await repository(files));
    expect(result.status).toBe(1);
    expect(result.output).toContain(message);
  });

  it('rejects CLI commands that the built CLI does not list', async () => {
    const files = validFixture();
    files['docs/reference/cli.md'] =
      '# CLI\n\n`nestvexa init` and `nestvexa teleport`.\n\nRun `npx nestvexa doctor`.\n';
    files['packages/cli/package.json'] = JSON.stringify({
      name: '@fixture/cli',
      version: '0.0.1',
    });
    files['packages/cli/dist/bin.js'] =
      "console.log('Commands:\\n  init   Set up\\n  doctor Check');\n";
    files['docs/feature-matrix.md'] += '\n`@fixture/cli`\n';
    files['docs/architecture/overview.md'] += '\n`@fixture/cli`\n';
    files['docs/architecture/package-dependency-graph.md'] =
      '# Graph\n\n```mermaid\nflowchart TD\n  core --> views\n  cli[cli]\n```\n';
    const result = check(await repository(files));
    expect(result.output).toContain(
      'documents "nestvexa teleport" but `nestvexa --help` does not list it',
    );
    expect(result.output).not.toContain('"nestvexa init"');
    expect(result.output).not.toContain('"nestvexa doctor"');
    expect(result.status).toBe(1);
  });
});
