// Publish verified tarballs with npm trusted publishing (OIDC) and provenance.
// Used only by .github/workflows/release.yml after the matrix, release-check
// and the protected `npm-release` environment approval.
//
//   node scripts/release-publish.mjs --tag v1.0.0 [--dry-run]
//
// Every tarball's SHA-256 must match artifacts/reports/pack.json, every
// version must equal the tag, and packages are published in workspace
// dependency order so no published package references an unpublished one.
// No npm token is read or required: npm >= 11.5.1 exchanges the GitHub OIDC
// identity for a short-lived publish credential per trusted-publisher setup.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const tag = args[args.indexOf('--tag') + 1];
const dryRun = args.includes('--dry-run');
if (
  !args.includes('--tag') ||
  !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag ?? '')
)
  throw new Error('--tag vX.Y.Z is required');
const version = tag.slice(1);

const pack = JSON.parse(await readFile('artifacts/reports/pack.json', 'utf8'));
if (pack.passed !== true) throw new Error('pack.json did not pass');
const entries = new Map();
for (const entry of pack.packages) {
  if (entry.version !== version)
    throw new Error(`${entry.name} is ${entry.version}, tag is ${tag}`);
  const tarball = `artifacts/packages/${entry.tarball.replaceAll('\\', '/').split('/').at(-1)}`;
  const digest = createHash('sha256')
    .update(await readFile(tarball))
    .digest('hex');
  if (digest !== entry.sha256)
    throw new Error(`${tarball} does not match the verified SHA-256`);
  const manifest = JSON.parse(
    spawnSync('tar', ['-xzOf', tarball, 'package/package.json'], {
      encoding: 'utf8',
    }).stdout,
  );
  if (manifest.name !== entry.name || manifest.version !== version)
    throw new Error(`${tarball} manifest does not match pack.json`);
  if (JSON.stringify(manifest).includes('workspace:'))
    throw new Error(`${tarball} still contains workspace: ranges`);
  entries.set(entry.name, { tarball, manifest });
}

// Topological order over workspace dependencies (runtime, peer, optional).
const order = [];
const state = new Map();
const visit = (name) => {
  if (state.get(name) === 'done') return;
  if (state.get(name) === 'active')
    throw new Error(`Dependency cycle through ${name}`);
  state.set(name, 'active');
  const { manifest } = entries.get(name);
  for (const field of [
    'dependencies',
    'peerDependencies',
    'optionalDependencies',
  ])
    for (const dependency of Object.keys(manifest[field] ?? {}))
      if (entries.has(dependency)) visit(dependency);
  state.set(name, 'done');
  order.push(name);
};
for (const name of [...entries.keys()].sort()) visit(name);

const npm = spawnSync('npm', ['--version'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
});
const [major = 0, minor = 0] = npm.stdout.trim().split('.').map(Number);
if (major < 11 || (major === 11 && minor < 5))
  throw new Error(
    `npm ${npm.stdout.trim()} lacks trusted publishing (need >= 11.5.1)`,
  );

for (const name of order) {
  const { tarball } = entries.get(name);
  const command = [
    'publish',
    tarball,
    '--provenance',
    '--access',
    'public',
    ...(version.includes('-') ? ['--tag', 'next'] : []),
    ...(dryRun ? ['--dry-run'] : []),
  ];
  console.log(`npm ${command.join(' ')}`);
  const result = spawnSync('npm', command, { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(
      `Publishing ${name} failed; earlier packages in this order are already public. ` +
        'Fix forward with a patch release; see docs/release/release-process.md (rollback).',
    );
    process.exit(result.status ?? 1);
  }
}
console.log(
  `${dryRun ? 'Dry run of' : 'Published'} ${order.length} packages for ${tag}.`,
);
