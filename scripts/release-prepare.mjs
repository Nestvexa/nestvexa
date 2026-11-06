// Prepare (never perform) a coordinated release.
//
//   pnpm release:prepare                    # report the pending release plan
//   pnpm release:prepare --target 1.0.0     # also verify every package reaches 1.0.0
//   pnpm release:prepare --target 1.0.0 --write
//                                           # add the major changeset that does it
//
// It never runs `changeset version`, edits package versions, tags, pushes or
// publishes. Those are owner steps listed in docs/release/release-process.md.
// Writes artifacts/reports/release-plan.json and exits 1 on any blocker.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const args = process.argv.slice(2);
const targetIndex = args.indexOf('--target');
const target = targetIndex >= 0 ? args[targetIndex + 1] : undefined;
const write = args.includes('--write');
if (target !== undefined && !/^\d+\.\d+\.\d+$/.test(target))
  throw new Error('--target must be a plain semver version such as 1.0.0');
if (write && target === undefined) throw new Error('--write requires --target');

const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error('Run with pnpm release:prepare.');
const blockers = [];
const notes = [];

const packages = [];
for (const name of await readdir('packages')) {
  const manifest = JSON.parse(
    await readFile(join('packages', name, 'package.json'), 'utf8'),
  );
  if (!manifest.private)
    packages.push({ name: manifest.name, version: manifest.version });
}
const versions = new Set(packages.map((entry) => entry.version));
if (versions.size !== 1)
  blockers.push(
    `Public packages must share one version; found ${[...versions].join(', ')}`,
  );
const [current] = versions;

const config = JSON.parse(await readFile('.changeset/config.json', 'utf8'));
const fixed = (config.fixed ?? []).find((group) => group.includes('nestvexa'));
if (!fixed || !fixed.includes('@nestvexa/*'))
  blockers.push(
    '.changeset/config.json must keep ["nestvexa", "@nestvexa/*"] in one fixed group',
  );
if (config.privatePackages?.version !== false)
  blockers.push(
    'Private examples must not be versioned (privatePackages.version: false)',
  );
if (existsSync('.changeset/pre.json'))
  notes.push('Changesets pre-release mode is active (.changeset/pre.json).');

const git = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
if (git.status === 0 && git.stdout.trim())
  notes.push(
    'Working tree has uncommitted changes; prepare from a clean tree.',
  );

const marker = '.changeset/release-major-coordinated.md';
let wroteMarker = false;
if (write) {
  const major = Number(target.split('.')[0]);
  const currentMajor = Number(String(current).split('.')[0]);
  if (major <= currentMajor && !String(current).includes('-'))
    blockers.push(
      `--write adds a major bump; ${current} is already ${major}.x`,
    );
  else if (!existsSync(marker)) {
    const body = [
      '---',
      ...packages
        .map((entry) => entry.name)
        .sort()
        .map((name) => `'${name}': major`),
      '---',
      '',
      `Coordinated ${target} release of every public Nestvexa package. See`,
      `docs/release/migration-${target.split('.')[0]}.0.md for upgrade notes and`,
      'docs/release/versioning-and-deprecation.md for the compatibility policy.',
      '',
    ].join('\n');
    await writeFile(marker, body);
    wroteMarker = true;
  }
}

const planFile = join('artifacts', 'reports', 'changeset-status.json');
await mkdir(join('artifacts', 'reports'), { recursive: true });
const status = spawnSync(
  process.execPath,
  [pnpm, 'exec', 'changeset', 'status', `--output=${planFile}`],
  { encoding: 'utf8', timeout: 120_000 },
);
let releases = [];
if (status.status !== 0)
  blockers.push(
    `changeset status failed: ${(status.stderr || status.stdout).trim()}`,
  );
else {
  const publicNames = new Set(packages.map((entry) => entry.name));
  // Private examples appear with type "none"; only public packages release.
  releases = (
    JSON.parse(await readFile(planFile, 'utf8')).releases ?? []
  ).filter(
    (release) => publicNames.has(release.name) && release.type !== 'none',
  );
  await rm(planFile, { force: true });
}
const planned = new Set(releases.map((release) => release.name));
for (const entry of packages)
  if (!planned.has(entry.name))
    blockers.push(`${entry.name} has no pending release in the plan`);
const next = new Set(releases.map((release) => release.newVersion));
if (next.size > 1)
  blockers.push(`Fixed group would diverge: ${[...next].join(', ')}`);
if (target !== undefined && !(next.size === 1 && next.has(target)))
  blockers.push(
    `Pending changesets lead to ${[...next].join(', ') || 'no release'}, not ${target}` +
      (write ? '' : ' (add --write to create the coordinated major changeset)'),
  );

const plan = {
  timestamp: new Date().toISOString(),
  currentVersion: current,
  target: target ?? null,
  nextVersions: [...next],
  packages: releases
    .map((release) => ({
      name: release.name,
      type: release.type,
      oldVersion: release.oldVersion,
      newVersion: release.newVersion,
      changesets: release.changesets?.length ?? 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name)),
  wroteMajorChangeset: wroteMarker ? marker : null,
  blockers,
  notes,
  ready: blockers.length === 0,
  ownerSteps: [
    'pnpm test:all (and pnpm load with LOAD_LATENCY_GATE=enforce on a quiet runner)',
    'pnpm changeset version  # applies the plan; review CHANGELOG.md diffs',
    'pnpm install --lockfile-only && pnpm test:pack && pnpm release:check',
    'commit "chore(release): <version>", tag v<version>, push after review',
    'run the "Release" workflow (workflow_dispatch) with the tag and dry_run=false',
  ],
  publicationPerformed: false,
};
await writeFile(
  join('artifacts', 'reports', 'release-plan.json'),
  JSON.stringify(plan, null, 2),
);
for (const note of notes) console.log(`note: ${note}`);
if (blockers.length) {
  console.error('RELEASE PLAN BLOCKED');
  for (const blocker of blockers) console.error(`- ${blocker}`);
  process.exitCode = 1;
} else
  console.log(
    `Release plan ready: ${packages.length} packages ${current} -> ${[...next].join(', ')}. Nothing was versioned or published.`,
  );
