import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// MAINT-010: CI enforcement of Conventional Commit PR titles and of a
// changeset for every published package whose source a PR changes.

const repository = resolve(import.meta.dirname, '..');
interface PolicyModule {
  commitTypes: readonly string[];
  skipLabel: string;
  checkTitle(title: unknown): string[];
  publishedPackages(root: string): Map<string, string>;
  changedPackages(files: string[], packages: Map<string, string>): string[];
  changesetFiles(files: string[]): string[];
  checkChangesets(input: {
    files: string[];
    changesets: { id: string; text: string }[];
    labels: string[];
    packages: Map<string, string>;
  }): string[];
  parseLabels(value: string | undefined): string[];
  changedFiles(root: string, base: string, head?: string): string[];
}
const policy = (await import(
  new URL('../scripts/pr-check.mjs', import.meta.url).href
)) as PolicyModule;

const packages = new Map([
  ['core', '@nestvexa/core'],
  ['nestvexa', 'nestvexa'],
]);
const changeset = (body: string) => `---\n${body}\n---\n\nSummary.\n`;

describe('PR title', () => {
  it.each([
    'feat(live): add polling',
    'fix: reject empty names',
    'fix!: drop Node 20',
    'feat(core)!: remove PluginRegistry',
    'build(deps): bump vite to 8.0.1',
    'docs(release/notes): explain dist-tags',
    'ci: run the PR policy',
    'Revert "feat(live): add polling"',
  ])('accepts %s', (title) => {
    expect(policy.checkTitle(title)).toEqual([]);
  });

  it.each([
    ['', /no title/],
    ['Add polling', /Conventional Commit/],
    ['feature(live): add polling', /Conventional Commit/],
    ['feat(Live): add polling', /Conventional Commit/],
    ['feat(live) add polling', /Conventional Commit/],
    ['feat(live):add polling', /Conventional Commit/],
    ['feat: ', /Conventional Commit/],
    ['FIX: crash', /Conventional Commit/],
    ['fix: handle the crash.', /period/],
    ['fix: ' + 'x'.repeat(100), /at most 100/],
    ['Revert "add polling"', /Conventional Commit/],
  ])('rejects %j', (title, message) => {
    expect(policy.checkTitle(title).join('\n')).toMatch(message);
  });

  it('rejects a missing title', () => {
    expect(policy.checkTitle(undefined)).toEqual([
      'The pull request has no title.',
    ]);
  });

  it('documents the same types as CONTRIBUTING.md', async () => {
    const contributing = await readFile(
      join(repository, 'CONTRIBUTING.md'),
      'utf8',
    );
    for (const type of policy.commitTypes)
      expect(contributing).toContain('`' + type + '`');
  });
});

describe('changeset requirement', () => {
  const check = (
    files: string[],
    changesets: { id: string; text: string }[] = [],
    labels: string[] = [],
  ) => policy.checkChangesets({ files, changesets, labels, packages });

  it('requires a changeset naming each published package whose src changed', () => {
    const errors = check([
      'packages/core/src/plugins.ts',
      'packages/nestvexa/src/index.ts',
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(
      'changes the source of @nestvexa/core, nestvexa without a changeset naming them',
    );
    expect(
      check(
        ['packages/core/src/plugins.ts', 'packages/nestvexa/src/index.ts'],
        [{ id: 'a', text: changeset("'@nestvexa/core': minor") }],
      ).join('\n'),
    ).toContain('changes the source of nestvexa without a changeset naming it');
    expect(
      check(
        ['packages/core/src/plugins.ts', 'packages/nestvexa/src/index.ts'],
        [
          {
            id: 'a',
            text: changeset("'@nestvexa/core': minor\nnestvexa: patch"),
          },
        ],
      ),
    ).toEqual([]);
  });

  it('ignores tests, docs, READMEs, private and unknown packages', () => {
    expect(
      check([
        'packages/core/README.md',
        'packages/core/package.json',
        'tests/core.test.ts',
        'docs/guides/live.md',
        'packages/private-thing/src/index.ts',
        'examples/starter-hbs/src/main.ts',
        'packages\\core\\README.md',
      ]),
    ).toEqual([]);
    expect(
      policy.changedPackages(['packages\\core\\src\\index.ts'], packages),
    ).toEqual(['@nestvexa/core']);
  });

  it('accepts the no-changeset label', () => {
    expect(
      check(['packages/core/src/plugins.ts'], [], ['no-changeset']),
    ).toEqual([]);
    expect(check(['packages/core/src/plugins.ts'], [], ['docs'])).toHaveLength(
      1,
    );
  });

  it('does not count a "none" bump or an invalid changeset as coverage', () => {
    expect(
      check(
        ['packages/core/src/plugins.ts'],
        [{ id: 'a', text: changeset("'@nestvexa/core': none") }],
      ).join('\n'),
    ).toContain('without a changeset');
    const invalid = check(
      ['packages/core/src/plugins.ts'],
      [{ id: 'broken', text: "'@nestvexa/core': minor\n" }],
    );
    expect(invalid[0]).toContain('Invalid changeset: broken');
    expect(invalid[1]).toContain('without a changeset');
    expect(
      check([], [{ id: 'a', text: changeset("'@nestvexa/core': major-ish") }]),
    ).toEqual([
      'Invalid changeset: a: @nestvexa/core has unknown bump major-ish',
    ]);
  });

  it('rejects a changeset naming a package that is not published', () => {
    expect(
      check([], [{ id: 'a', text: changeset("'@nestvexa/typo': patch") }]),
    ).toEqual([
      'A changeset names @nestvexa/typo, which is not a published package.',
    ]);
  });

  it('selects changeset files and parses labels', () => {
    expect(
      policy.changesetFiles([
        '.changeset/a.md',
        '.changeset/README.md',
        '.changeset/config.json',
        '.changeset/nested/b.md',
        'docs/a.md',
      ]),
    ).toEqual(['.changeset/a.md']);
    expect(policy.parseLabels(undefined)).toEqual([]);
    expect(policy.parseLabels('')).toEqual([]);
    expect(policy.parseLabels('["no-changeset","docs"]')).toEqual([
      'no-changeset',
      'docs',
    ]);
    expect(() => policy.parseLabels('[1]')).toThrow(/JSON array/);
    expect(() => policy.parseLabels('{"a":1}')).toThrow(/JSON array/);
  });

  it('reads published packages of this repository', () => {
    const published = policy.publishedPackages(repository);
    expect(published.get('core')).toBe('@nestvexa/core');
    expect(published.get('nestvexa')).toBe('nestvexa');
    expect(published.size).toBeGreaterThan(20);
  });
});

describe('pr-check.mjs against a git repository', () => {
  let root = '';
  let base = '';
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  const write = async (path: string, text: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  };
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, [join(repository, 'scripts/pr-check.mjs')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '',
        SystemRoot: process.env['SystemRoot'] ?? '',
        ...env,
      },
      timeout: 60_000,
    });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'nestvexa-pr-policy-'));
    git('init', '--quiet', '--initial-branch=main');
    git('config', 'user.email', 'ci@example.invalid');
    git('config', 'user.name', 'CI');
    git('config', 'commit.gpgsign', 'false');
    await write(
      'packages/core/package.json',
      JSON.stringify({ name: '@nestvexa/core', version: '0.1.0' }),
    );
    await write(
      'packages/internal/package.json',
      JSON.stringify({ name: '@nestvexa/internal', private: true }),
    );
    await write('packages/core/src/index.ts', 'export const a = 1;\n');
    await write('packages/internal/src/index.ts', 'export const a = 1;\n');
    await write('.changeset/old.md', changeset("'@nestvexa/core': patch"));
    git('add', '.');
    git('commit', '--quiet', '-m', 'chore: base');
    base = git('rev-parse', 'HEAD');
    git('checkout', '--quiet', '-b', 'topic');
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('fails a source change without a changeset, then passes with one', async () => {
    await write('packages/core/src/index.ts', 'export const a = 2;\n');
    await write('packages/internal/src/index.ts', 'export const a = 2;\n');
    git('commit', '--quiet', '-am', 'feat(core): change a');
    const failing = run({
      PR_TITLE: 'feat(core): change a',
      PR_BASE_SHA: base,
    });
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain(
      'PR policy: The pull request changes the source of @nestvexa/core without a changeset',
    );
    // An existing changeset on the base branch does not cover the PR.
    expect(failing.stdout).toContain('changesets: none');

    const labelled = run({
      PR_TITLE: 'refactor(core): rename a local',
      PR_BASE_SHA: base,
      PR_LABELS: JSON.stringify(['no-changeset']),
    });
    expect(labelled.status, labelled.stderr).toBe(0);
    expect(labelled.stdout).toContain('the no-changeset label skips');

    await write('.changeset/change-a.md', changeset("'@nestvexa/core': minor"));
    git('add', '.');
    git('commit', '--quiet', '-m', 'chore(changeset): change a');
    const passing = run({
      PR_TITLE: 'feat(core): change a',
      PR_BASE_SHA: base,
      PR_LABELS: '[]',
    });
    expect(passing.status, passing.stderr).toBe(0);
    expect(passing.stdout).toContain(
      'package sources changed: @nestvexa/core; changesets: change-a',
    );
    expect(passing.stdout).toContain('PR policy passed.');
  });

  it('fails a non-conventional title even when changesets are complete', () => {
    const result = run({ PR_TITLE: 'Change a', PR_BASE_SHA: base });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must be a Conventional Commit');
  });

  it('rejects option-like or malformed revisions and a missing base', () => {
    for (const revision of ['--output=/tmp/x', 'a b', 'x;y'])
      expect(() => policy.changedFiles(root, revision)).toThrow(
        /Invalid git revision/,
      );
    const missing = run({ PR_TITLE: 'fix: x' });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('PR_BASE_SHA is required');
  });
});

describe('ci.yml pr-policy job', () => {
  it('runs on pull requests only, with full history and env-passed PR text', async () => {
    const workflow = await readFile(
      join(repository, '.github/workflows/ci.yml'),
      'utf8',
    );
    const job = /\n {2}pr-policy:\n([\s\S]*?)(?=\n {2}[a-z-]+:\n|$)/.exec(
      workflow,
    )?.[1];
    expect(job).toBeDefined();
    expect(job).toContain("if: github.event_name == 'pull_request'");
    expect(job).toContain('fetch-depth: 0');
    expect(job).toContain('PR_TITLE: ${{ github.event.pull_request.title }}');
    expect(job).toContain(
      'PR_LABELS: ${{ toJSON(github.event.pull_request.labels.*.name) }}',
    );
    expect(job).toContain(
      'PR_BASE_SHA: ${{ github.event.pull_request.base.sha }}',
    );
    expect(job).toContain('run: node scripts/pr-check.mjs');
    // Untrusted PR text never appears inside a run: command.
    for (const line of (job ?? '').split('\n'))
      if (line.includes('run:'))
        expect(line).not.toContain('github.event.pull_request');
  });
});
