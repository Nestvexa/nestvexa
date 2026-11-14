import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// REL-035 / MAINT-017: the release tooling behind release.yml and
// release-dry-run.yml: tarball re-verification and publish order, the
// changeset-driven release/migration notes, SBOM generation and the
// temp-clone `changeset version` dry run.

vi.setConfig({ testTimeout: 120_000 });
const repository = resolve(import.meta.dirname, '..');
const load = async <T>(script: string) =>
  (await import(new URL(`../scripts/${script}`, import.meta.url).href)) as T;

interface Manifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}
interface PublishModule {
  parseArgs(args: string[]): { tag: string; version: string; dryRun: boolean };
  verifyTarballs(
    pack: unknown,
    version: string,
    readManifest: (tarball: string) => string,
    directory?: string,
  ): Promise<Map<string, { tarball: string; manifest: Manifest }>>;
  publishOrder(
    entries: Map<string, { tarball: string; manifest: Manifest }>,
  ): string[];
  publishArguments(tarball: string, version: string, dryRun: boolean): string[];
}
interface Changeset {
  id: string;
  type: string;
  releases: { name: string; type: string }[];
  security: boolean;
  breaking: boolean;
  deprecation: boolean;
  defaults: boolean;
}
interface NotesModule {
  parseChangeset(text: string, id: string): Changeset;
  buildNotes(
    changesets: Changeset[],
    options: { from?: string; to?: string; date: string },
  ): {
    releaseNotes: string;
    migrationNotes: string;
    summary: { security: string[]; breaking: string[]; packages: string[] };
  };
}
interface SbomComponent {
  name: string;
  group?: string;
  scope: string;
  hashes?: { alg: string }[];
  properties?: { name: string; value: string }[];
}
interface SbomModule {
  readLockfile(text: string): unknown;
  sbomContext(root: string): Record<string, unknown>;
  buildSbom(options: Record<string, unknown>): {
    bomFormat: string;
    specVersion: string;
    serialNumber: string;
    metadata: { component: { hashes: { alg: string; content: string }[] } };
    components: SbomComponent[];
  };
}
interface WorkspaceEntry {
  dir: string;
  version: string;
  private: boolean;
}
interface DryRunModule {
  readWorkspace(root: string): Map<string, WorkspaceEntry>;
  cloneForDryRun(root: string, target: string): void;
  applyChangesets(clone: string, root: string): void;
  unlinkTooling(clone: string): Promise<void>;
  inspectVersioned(
    clone: string,
    before: Map<string, WorkspaceEntry>,
  ): {
    toVersion: string | null;
    packages: { name: string; newVersion: string }[];
    blockers: string[];
  };
}

const publish = await load<PublishModule>('release-publish.mjs');
const notes = await load<NotesModule>('release-notes.mjs');
const sbom = await load<SbomModule>('sbom.mjs');
const dryRun = await load<DryRunModule>('release-dry-run.mjs');

async function temp(prefix: string) {
  return mkdtemp(join(tmpdir(), `nestvexa-${prefix}-`));
}

describe('release-publish verification', () => {
  it('requires an exact release tag', () => {
    expect(publish.parseArgs(['--tag', 'v1.2.3', '--dry-run'])).toEqual({
      tag: 'v1.2.3',
      version: '1.2.3',
      dryRun: true,
    });
    for (const args of [[], ['--tag'], ['--tag', '1.2.3'], ['--tag', 'v1.2']])
      expect(() => publish.parseArgs(args)).toThrow('--tag vX.Y.Z');
    expect(() => publish.parseArgs(['--tag', 'v1.0.0;rm'])).toThrow();
  });

  it('always requests provenance, keeps prereleases off latest and only adds --dry-run when asked', () => {
    expect(
      publish.publishArguments('artifacts/packages/a-1.0.0.tgz', '1.0.0', true),
    ).toEqual([
      'publish',
      'artifacts/packages/a-1.0.0.tgz',
      '--provenance',
      '--access',
      'public',
      '--dry-run',
    ]);
    expect(
      publish.publishArguments(
        'artifacts/packages/a-1.0.0-rc.1.tgz',
        '1.0.0-rc.1',
        false,
      ),
    ).toEqual([
      'publish',
      'artifacts/packages/a-1.0.0-rc.1.tgz',
      '--provenance',
      '--access',
      'public',
      '--tag',
      'next',
    ]);
    expect(() =>
      publish.publishArguments('artifacts/packages/a&calc.tgz', '1.0.0', true),
    ).toThrow('unsafe npm argument');
  });

  async function fixture() {
    const directory = await temp('publish');
    const tarballs = new Map<string, Buffer>([
      ['nestvexa-core-1.0.0.tgz', Buffer.from('core tarball')],
      ['nestvexa-live-1.0.0.tgz', Buffer.from('live tarball')],
      ['nestvexa-1.0.0.tgz', Buffer.from('umbrella tarball')],
    ]);
    for (const [file, bytes] of tarballs)
      await writeFile(join(directory, file), bytes);
    const manifests: Record<string, Manifest> = {
      'nestvexa-core-1.0.0.tgz': { name: '@nestvexa/core', version: '1.0.0' },
      'nestvexa-live-1.0.0.tgz': {
        name: '@nestvexa/live',
        version: '1.0.0',
        dependencies: { '@nestvexa/core': '1.0.0' },
      },
      'nestvexa-1.0.0.tgz': {
        name: 'nestvexa',
        version: '1.0.0',
        dependencies: { '@nestvexa/live': '1.0.0', '@nestvexa/core': '1.0.0' },
      },
    };
    const pack = {
      passed: true,
      packages: [...tarballs].map(([file, bytes]) => ({
        name: manifests[file]?.name,
        version: '1.0.0',
        // pack.json records the absolute Windows or POSIX path of the pack run.
        tarball: `C:\\work\\artifacts\\packages\\${file}`,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })),
    };
    const read = (tarball: string) =>
      JSON.stringify(manifests[tarball.split('/').at(-1) ?? '']);
    return { directory, pack, read, manifests };
  }

  it('publishes dependencies before dependents', async () => {
    const { directory, pack, read } = await fixture();
    try {
      const entries = await publish.verifyTarballs(
        pack,
        '1.0.0',
        read,
        directory,
      );
      expect(publish.publishOrder(entries)).toEqual([
        '@nestvexa/core',
        '@nestvexa/live',
        'nestvexa',
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses tampered tarballs, version drift, workspace ranges and failed packs', async () => {
    const { directory, pack, read, manifests } = await fixture();
    try {
      await expect(
        publish.verifyTarballs(pack, '1.0.1', read, directory),
      ).rejects.toThrow('tag is v1.0.1');
      await expect(
        publish.verifyTarballs(
          { ...pack, passed: false },
          '1.0.0',
          read,
          directory,
        ),
      ).rejects.toThrow('did not pass');
      await writeFile(join(directory, 'nestvexa-live-1.0.0.tgz'), 'swapped');
      await expect(
        publish.verifyTarballs(pack, '1.0.0', read, directory),
      ).rejects.toThrow('does not match the verified SHA-256');
      await writeFile(
        join(directory, 'nestvexa-live-1.0.0.tgz'),
        'live tarball',
      );
      const workspaceRange = (tarball: string) =>
        tarball.endsWith('nestvexa-1.0.0.tgz')
          ? JSON.stringify({
              ...manifests['nestvexa-1.0.0.tgz'],
              dependencies: { '@nestvexa/core': 'workspace:*' },
            })
          : read(tarball);
      await expect(
        publish.verifyTarballs(pack, '1.0.0', workspaceRange, directory),
      ).rejects.toThrow('workspace: ranges');
      const renamed = (tarball: string) =>
        tarball.endsWith('nestvexa-core-1.0.0.tgz')
          ? JSON.stringify({ name: '@evil/core', version: '1.0.0' })
          : read(tarball);
      await expect(
        publish.verifyTarballs(pack, '1.0.0', renamed, directory),
      ).rejects.toThrow('manifest does not match');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('detects dependency cycles instead of publishing a partial order', () => {
    const entries = new Map([
      [
        'a',
        {
          tarball: 'a.tgz',
          manifest: {
            name: 'a',
            version: '1.0.0',
            dependencies: { b: '1.0.0' },
          },
        },
      ],
      [
        'b',
        {
          tarball: 'b.tgz',
          manifest: {
            name: 'b',
            version: '1.0.0',
            peerDependencies: { a: '1.0.0' },
          },
        },
      ],
    ]);
    expect(() => publish.publishOrder(entries)).toThrow('Dependency cycle');
  });
});

describe('release and migration notes', () => {
  const changeset = (body: string, header: string) =>
    `---\n${header}\n---\n\n${body}\n`;

  it('parses quoted package names and picks the largest bump', () => {
    const parsed = notes.parseChangeset(
      changeset(
        'Fix a thing.',
        `'@nestvexa/core': patch\n"@nestvexa/live": minor`,
      ),
      'mixed',
    );
    expect(parsed.type).toBe('minor');
    expect(parsed.releases).toEqual([
      { name: '@nestvexa/core', type: 'patch' },
      { name: '@nestvexa/live', type: 'minor' },
    ]);
  });

  it('rejects malformed changesets rather than dropping them from the notes', () => {
    expect(() => notes.parseChangeset('no header', 'a')).toThrow(
      'front matter',
    );
    expect(() =>
      notes.parseChangeset(changeset('x', `'@nestvexa/core': huge`), 'b'),
    ).toThrow('unknown bump');
    expect(() =>
      notes.parseChangeset(changeset('', `'@nestvexa/core': patch`), 'c'),
    ).toThrow('empty changeset');
  });

  it('puts security and breaking changes first and leaves migration actions to a human', () => {
    const entries = [
      notes.parseChangeset(
        changeset('Add a helper.', `'@nestvexa/ui': minor`),
        'ui-helper',
      ),
      notes.parseChangeset(
        changeset(
          'Reject traversal in view names (security fix).',
          `'@nestvexa/views': patch`,
        ),
        'views-traversal',
      ),
      notes.parseChangeset(
        changeset(
          'Rename `foo` to `bar`; the old name is deprecated.',
          `'@nestvexa/core': major`,
        ),
        'core-rename',
      ),
    ];
    const result = notes.buildNotes(entries, {
      from: '1.0.0',
      to: '2.0.0',
      date: '2026-11-14',
    });
    expect(result.summary.security).toEqual(['views-traversal']);
    expect(result.summary.breaking).toEqual(['core-rename']);
    expect(result.summary.packages).toEqual([
      '@nestvexa/core',
      '@nestvexa/ui',
      '@nestvexa/views',
    ]);
    const order = [
      '## Security',
      '## Breaking changes',
      '## Features',
      '## Fixes',
    ].map((heading) => result.releaseNotes.indexOf(heading));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(result.releaseNotes).toContain('Reject traversal in view names');
    expect(result.migrationNotes).toContain('1.0.0 → 2.0.0');
    expect(result.migrationNotes).toMatch(
      /`core-rename`.*_TO FILL_ \| _TO FILL_/,
    );
    expect(result.migrationNotes).toContain('## Deprecations');
  });

  it('drafts notes for every changeset in this repository', async () => {
    const { readChangesets } = await load<{
      readChangesets(directory: string): Changeset[];
    }>('release-notes.mjs');
    const pending = readChangesets(join(repository, '.changeset'));
    expect(pending.length).toBeGreaterThan(0);
    for (const entry of pending)
      expect(entry.releases.length).toBeGreaterThan(0);
  });
});

describe('SBOM generation', () => {
  it('accepts only pnpm v9 lockfiles', () => {
    expect(() => sbom.readLockfile("lockfileVersion: '6.0'\n")).toThrow('v9');
  });

  it('lists the runtime closure with registry hashes and never devDependencies', async () => {
    const context = sbom.sbomContext(repository);
    const manifest = JSON.parse(
      await readFile(join(repository, 'packages/views/package.json'), 'utf8'),
    ) as Manifest & { devDependencies?: Record<string, string> };
    const options = {
      ...context,
      manifest,
      importer: 'packages/views',
      tarballSha256: 'c'.repeat(64),
      timestamp: '2026-11-14T00:00:00.000Z',
    };
    const document = sbom.buildSbom(options);
    expect(document.bomFormat).toBe('CycloneDX');
    expect(document.specVersion).toBe('1.6');
    expect(document.metadata.component.hashes).toEqual([
      { alg: 'SHA-256', content: 'c'.repeat(64) },
    ]);
    const names = document.components.map((component) =>
      component.group ? `${component.group}/${component.name}` : component.name,
    );
    for (const dev of Object.keys(manifest.devDependencies ?? {}))
      if (!(dev in (manifest.peerDependencies ?? {})))
        expect(names).not.toContain(dev);
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      expect(names).toContain(dependency);
    for (const component of document.components) {
      const peer = component.properties?.some(
        (property) => property.value === 'peer',
      );
      if (peer) expect(component.scope).toBe('optional');
      const registry = !component.properties?.some(
        (property) =>
          property.value === 'workspace' ||
          property.name === 'nestvexa:versionRange',
      );
      if (registry && !peer) expect(component.hashes?.[0]?.alg).toBe('SHA-512');
    }
    // Deterministic: the same inputs give the same document and serial.
    expect(JSON.stringify(sbom.buildSbom(options))).toBe(
      JSON.stringify(document),
    );
  });
});

describe('release dry run', () => {
  async function workspace(
    root: string,
    packages: Record<
      string,
      { version: string; private?: boolean; changelog?: string }
    >,
  ) {
    for (const [dir, entry] of Object.entries(packages)) {
      await mkdir(join(root, dir), { recursive: true });
      await writeFile(
        join(root, dir, 'package.json'),
        JSON.stringify({
          name: dir.split('/').at(-1),
          version: entry.version,
          private: entry.private,
        }),
      );
      if (entry.changelog)
        await writeFile(join(root, dir, 'CHANGELOG.md'), entry.changelog);
    }
    await mkdir(join(root, '.changeset'), { recursive: true });
  }

  it('reports unversioned, diverging, undocumented and private-version changes', async () => {
    const before = await temp('dry-before');
    const after = await temp('dry-after');
    try {
      await workspace(before, {
        'packages/a': { version: '1.0.0' },
        'packages/b': { version: '1.0.0' },
        'packages/c': { version: '1.0.0' },
        'examples/demo': { version: '0.0.0', private: true },
      });
      await workspace(after, {
        'packages/a': { version: '1.1.0', changelog: '# a\n\n## 1.1.0\n' },
        'packages/b': { version: '1.0.0' },
        'packages/c': { version: '2.0.0', changelog: '# c\n' },
        'examples/demo': { version: '0.0.1', private: true },
      });
      await writeFile(join(after, '.changeset/left-over.md'), '---\n---\n');
      const result = dryRun.inspectVersioned(
        after,
        dryRun.readWorkspace(before),
      );
      expect(result.toVersion).toBeNull();
      expect(result.blockers).toEqual(
        expect.arrayContaining([
          'b stayed at 1.0.0',
          'b has no CHANGELOG.md entry for 1.0.0',
          'c has no CHANGELOG.md entry for 2.0.0',
          'private demo was versioned (0.0.0 -> 0.0.1)',
          'public packages diverge: 1.1.0, 1.0.0, 2.0.0',
          'changesets not consumed: left-over.md',
        ]),
      );
    } finally {
      await rm(before, { recursive: true, force: true });
      await rm(after, { recursive: true, force: true });
    }
  });

  it('runs changeset version in a remote-less clone and leaves the source untouched', async () => {
    const root = await temp('dry-source');
    const target = join(await temp('dry-clone'), 'repo');
    const git = (args: string[], cwd = root) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    };
    try {
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ name: 'fixture-root', private: true }),
      );
      await writeFile(
        join(root, 'pnpm-workspace.yaml'),
        "packages:\n  - 'packages/*'\n  - 'examples/*'\n",
      );
      for (const name of ['alpha', 'beta'])
        await mkdir(join(root, 'packages', name), { recursive: true });
      await writeFile(
        join(root, 'packages/alpha/package.json'),
        JSON.stringify({ name: '@fixture/alpha', version: '1.0.0' }),
      );
      await writeFile(
        join(root, 'packages/beta/package.json'),
        JSON.stringify({
          name: '@fixture/beta',
          version: '1.0.0',
          dependencies: { '@fixture/alpha': 'workspace:*' },
        }),
      );
      await mkdir(join(root, 'examples/demo'), { recursive: true });
      await writeFile(
        join(root, 'examples/demo/package.json'),
        JSON.stringify({
          name: 'demo',
          version: '0.0.0',
          private: true,
          dependencies: { '@fixture/alpha': 'workspace:*' },
        }),
      );
      await mkdir(join(root, '.changeset'));
      await writeFile(
        join(root, '.changeset/config.json'),
        JSON.stringify({
          changelog: '@changesets/cli/changelog',
          commit: false,
          fixed: [['@fixture/*']],
          linked: [],
          access: 'public',
          baseBranch: 'main',
          updateInternalDependencies: 'patch',
          privatePackages: { version: false, tag: false },
          ignore: [],
        }),
      );
      await writeFile(
        join(root, '.changeset/alpha-fix.md'),
        "---\n'@fixture/alpha': patch\n---\n\nFix alpha.\n",
      );
      await writeFile(join(root, '.gitignore'), 'node_modules\n');
      git(['init', '--quiet', '--initial-branch=main']);
      git([
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'add',
        '.',
      ]);
      git([
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'fixture',
      ]);
      symlinkSync(
        join(repository, 'node_modules'),
        join(root, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const before = dryRun.readWorkspace(root);
      dryRun.cloneForDryRun(root, target);
      expect(git(['remote'], target).trim()).toBe('');
      dryRun.applyChangesets(target, root);
      const result = dryRun.inspectVersioned(target, before);
      expect(result.blockers).toEqual([]);
      expect(result.toVersion).toBe('1.0.1');
      expect(result.packages.map((entry) => entry.name)).toEqual([
        '@fixture/alpha',
        '@fixture/beta',
      ]);
      expect(
        await readFile(join(target, 'packages/alpha/CHANGELOG.md'), 'utf8'),
      ).toContain('Fix alpha.');
      // The source checkout keeps its versions and its pending changeset.
      expect(git(['status', '--porcelain']).trim()).toBe('');
      expect(dryRun.readWorkspace(root).get('@fixture/alpha')?.version).toBe(
        '1.0.0',
      );
      await dryRun.unlinkTooling(target);
      await dryRun.unlinkTooling(root);
      // The workspace tooling survived the unlink.
      expect(
        JSON.parse(
          await readFile(
            join(repository, 'node_modules/@changesets/cli/package.json'),
            'utf8',
          ),
        ),
      ).toHaveProperty('name', '@changesets/cli');
    } finally {
      await dryRun.unlinkTooling(target);
      await dryRun.unlinkTooling(root);
      await rm(root, { recursive: true, force: true });
      await rm(resolve(target, '..'), { recursive: true, force: true });
    }
  });
});
