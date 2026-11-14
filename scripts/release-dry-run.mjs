// Release dry run: apply the pending Changesets in a throwaway clone and
// verify the result, without touching this checkout, the registry or git
// remotes.
//
//   pnpm release:dry-run            # version in a temp clone, verify, draft notes
//   pnpm release:dry-run --pack     # also install, build, `pnpm test:pack` and
//                                   # `npm publish --dry-run --provenance` there
//   pnpm release:dry-run --keep     # keep the clone for inspection
//
// Steps: `git clone` of HEAD into a temp directory (uncommitted changes are
// not included) with its `origin` remote removed, so nothing done in the clone
// can be pushed; draft release and migration notes from the pending
// changesets; `changeset version` in the clone; then checks that every public
// package moved to one new version with a CHANGELOG entry, private examples
// kept their versions and every changeset was consumed. With --pack the
// clone's tarballs are built and verified exactly as the release workflow
// does, and scripts/release-publish.mjs runs with --dry-run (npm never
// uploads in dry-run mode, so no credential is needed or read).
//
// Writes artifacts/release/{dry-run.json,release-notes.md,migration-notes.md,
// release-notes.json} in this checkout and exits 1 on any blocker. It never
// tags, pushes or publishes.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  symlinkSync,
} from 'node:fs';
import { cp, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildNotes, readChangesets, writeNotes } from './release-notes.mjs';

function run(command, args, cwd, timeout = 600_000) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `${[command, ...args].join(' ')} failed in ${cwd}:\n${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error?.message ?? ''}`,
    );
  return result.stdout;
}

/** Workspace manifests under `packages/` and `examples/`, keyed by name. */
export function readWorkspace(root) {
  const manifests = new Map();
  for (const base of ['packages', 'examples']) {
    const directory = join(root, base);
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)) {
      const file = join(directory, name, 'package.json');
      if (!existsSync(file)) continue;
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      manifests.set(manifest.name, {
        dir: join(base, name),
        version: manifest.version,
        private: manifest.private === true,
        manifest,
      });
    }
  }
  return manifests;
}

/**
 * Clone `root`'s HEAD into `target`, drop the remote and give the clone the
 * workspace's installed tooling (a junction/symlink to node_modules).
 */
export function cloneForDryRun(root, target) {
  run('git', ['clone', '--quiet', '--no-checkout', root, target], root);
  run('git', ['checkout', '--quiet', 'HEAD'], target);
  run('git', ['remote', 'remove', 'origin'], target);
  symlinkSync(
    join(root, 'node_modules'),
    join(target, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
}

/**
 * Remove the clone's tooling link without ever recursing into the linked
 * workspace node_modules.
 */
export async function unlinkTooling(clone) {
  const link = join(clone, 'node_modules');
  try {
    if (lstatSync(link).isSymbolicLink()) await unlink(link);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

/** Run `changeset version` in `clone` with the workspace's own CLI. */
export function applyChangesets(clone, root) {
  run(
    process.execPath,
    [join(root, 'node_modules/@changesets/cli/bin.js'), 'version'],
    clone,
  );
}

/** Compare the clone after versioning with the manifests before it. */
export function inspectVersioned(clone, before) {
  const blockers = [];
  const after = readWorkspace(clone);
  const packages = [];
  for (const [name, previous] of before) {
    const next = after.get(name);
    if (!next) {
      blockers.push(`${name} disappeared after versioning`);
      continue;
    }
    if (previous.private) {
      if (next.version !== previous.version)
        blockers.push(
          `private ${name} was versioned (${previous.version} -> ${next.version})`,
        );
      continue;
    }
    const changelog = join(clone, next.dir, 'CHANGELOG.md');
    const hasEntry =
      existsSync(changelog) &&
      readFileSync(changelog, 'utf8').includes(`## ${next.version}`);
    if (next.version === previous.version)
      blockers.push(`${name} stayed at ${previous.version}`);
    if (!hasEntry)
      blockers.push(`${name} has no CHANGELOG.md entry for ${next.version}`);
    packages.push({
      name,
      oldVersion: previous.version,
      newVersion: next.version,
      changelog: hasEntry,
    });
  }
  const versions = new Set(packages.map((entry) => entry.newVersion));
  if (versions.size !== 1)
    blockers.push(`public packages diverge: ${[...versions].join(', ')}`);
  const remaining = readdirSync(join(clone, '.changeset')).filter(
    (file) => file.endsWith('.md') && file !== 'README.md',
  );
  // Pre-release mode keeps consumed changesets on disk by design.
  if (remaining.length && !existsSync(join(clone, '.changeset/pre.json')))
    blockers.push(`changesets not consumed: ${remaining.join(', ')}`);
  return {
    toVersion: versions.size === 1 ? [...versions][0] : null,
    packages: packages.sort((a, b) => a.name.localeCompare(b.name)),
    blockers,
  };
}

/** Install, build, pack and `npm publish --dry-run` inside the clone. */
async function packAndPublishDryRun(clone, version, report, out) {
  const pnpm = process.env.npm_execpath;
  if (!pnpm) throw new Error('Run with pnpm release:dry-run --pack.');
  // The clone gets its own install so packed manifests carry the new versions.
  const steps = [
    [
      process.execPath,
      [pnpm, 'install', '--frozen-lockfile', '--prefer-offline'],
    ],
    [process.execPath, [pnpm, 'build']],
    [process.execPath, [pnpm, 'test:pack']],
    [
      process.execPath,
      ['scripts/release-publish.mjs', '--tag', `v${version}`, '--dry-run'],
    ],
  ];
  for (const [command, args] of steps) {
    const label = args.filter((arg) => arg !== pnpm).join(' ');
    run(command, args, clone, 3_600_000);
    report.steps.push(label);
  }
  // Keep the clone's verified pack report and SBOMs with the dry-run report.
  await cp(join(clone, 'artifacts/reports/pack.json'), join(out, 'pack.json'));
  await cp(join(clone, 'artifacts/sbom'), join(out, 'sbom'), {
    recursive: true,
  });
}

async function main() {
  const root = process.cwd();
  const args = process.argv.slice(2);
  const pack = args.includes('--pack');
  const keep = args.includes('--keep');
  const out = resolve('artifacts/release');
  const head = run('git', ['rev-parse', 'HEAD'], root).trim();
  const dirty = run('git', ['status', '--porcelain'], root).trim() !== '';
  const before = readWorkspace(root);
  const publicVersions = new Set(
    [...before.values()]
      .filter((entry) => !entry.private)
      .map((entry) => entry.version),
  );
  const workspace = await mkdtemp(join(tmpdir(), 'nestvexa-release-dry-run-'));
  const clone = join(workspace, 'repo');
  const report = {
    timestamp: new Date().toISOString(),
    commit: head,
    uncommittedChangesIgnored: dirty,
    fromVersion: [...publicVersions].join(', '),
    toVersion: null,
    packages: [],
    steps: [],
    blockers: [],
    packed: false,
    publishDryRun: false,
    publicationPerformed: false,
    clone: keep ? clone : null,
  };
  try {
    cloneForDryRun(root, clone);
    report.steps.push('git clone HEAD (origin removed)');
    const changesets = readChangesets(join(clone, '.changeset'));
    if (!changesets.length) report.blockers.push('no pending changesets');
    applyChangesets(clone, root);
    report.steps.push('changeset version');
    const inspected = inspectVersioned(clone, before);
    Object.assign(report, {
      toVersion: inspected.toVersion,
      packages: inspected.packages,
    });
    report.blockers.push(...inspected.blockers);
    const notes = buildNotes(changesets, {
      from: report.fromVersion,
      to: inspected.toVersion ?? undefined,
      date: report.timestamp.slice(0, 10),
    });
    await writeNotes(notes, out);
    report.notes = notes.summary;
    if (pack && !report.blockers.length && inspected.toVersion) {
      // Replace the tooling link with a real install for the build.
      await unlinkTooling(clone);
      await packAndPublishDryRun(clone, inspected.toVersion, report, out);
      report.packed = true;
      report.publishDryRun = true;
    }
  } catch (error) {
    report.blockers.push(
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    await mkdir(out, { recursive: true });
    await writeFile(
      join(out, 'dry-run.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    if (!keep) {
      await unlinkTooling(clone);
      await rm(workspace, { recursive: true, force: true });
    }
  }
  if (report.blockers.length) {
    console.error('RELEASE DRY RUN BLOCKED');
    for (const blocker of report.blockers) console.error(`- ${blocker}`);
    process.exitCode = 1;
  } else
    console.log(
      `Release dry run: ${report.packages.length} packages ${report.fromVersion} -> ${report.toVersion}` +
        `${report.packed ? '; packed and npm publish --dry-run passed' : ''}. Nothing was tagged, pushed or published.`,
    );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
