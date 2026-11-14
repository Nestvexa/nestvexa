// Publish verified tarballs with npm trusted publishing (OIDC) and provenance.
// Used only by .github/workflows/release.yml after the matrix, release-check
// and the protected `npm-release` environment approval, and with --dry-run by
// scripts/release-dry-run.mjs.
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
import { pathToFileURL } from 'node:url';

const releaseTag = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
// Arguments reach a shell on Windows (npm is a .cmd shim there), so every
// argument is restricted to characters no shell interprets.
const safeArgument = /^[A-Za-z0-9@._/:=-]+$/;

/** Parse `--tag vX.Y.Z [--dry-run]`; throws on anything else. */
export function parseArgs(args) {
  const index = args.indexOf('--tag');
  const tag = index >= 0 ? args[index + 1] : undefined;
  if (tag === undefined || !releaseTag.test(tag))
    throw new Error('--tag vX.Y.Z is required');
  return { tag, version: tag.slice(1), dryRun: args.includes('--dry-run') };
}

/**
 * Re-verify every packed tarball against pack.json and the tag. Returns a map
 * of package name to `{ tarball, manifest }`. `readManifest(tarball)` returns
 * the tarball's package.json text. Tarballs are read from `directory`.
 */
export async function verifyTarballs(
  pack,
  version,
  readManifest,
  directory = 'artifacts/packages',
) {
  if (pack?.passed !== true) throw new Error('pack.json did not pass');
  if (!Array.isArray(pack.packages) || pack.packages.length === 0)
    throw new Error('pack.json lists no packages');
  const entries = new Map();
  for (const entry of pack.packages) {
    if (entry.version !== version)
      throw new Error(`${entry.name} is ${entry.version}, tag is v${version}`);
    const file = String(entry.tarball).replaceAll('\\', '/').split('/').at(-1);
    if (!file || !safeArgument.test(file) || !file.endsWith('.tgz'))
      throw new Error(`${entry.name} has an unsafe tarball name`);
    const tarball = `${directory}/${file}`;
    const digest = createHash('sha256')
      .update(await readFile(tarball))
      .digest('hex');
    if (digest !== entry.sha256)
      throw new Error(`${tarball} does not match the verified SHA-256`);
    const text = readManifest(tarball);
    const manifest = JSON.parse(text);
    if (manifest.name !== entry.name || manifest.version !== version)
      throw new Error(`${tarball} manifest does not match pack.json`);
    if (text.includes('workspace:'))
      throw new Error(`${tarball} still contains workspace: ranges`);
    if (entries.has(entry.name))
      throw new Error(`${entry.name} appears twice in pack.json`);
    entries.set(entry.name, { tarball, manifest });
  }
  return entries;
}

/** Topological order over workspace dependencies (runtime, peer, optional). */
export function publishOrder(entries) {
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
  return order;
}

/** The exact `npm` arguments for one tarball. */
export function publishArguments(tarball, version, dryRun) {
  const args = [
    'publish',
    tarball,
    '--provenance',
    '--access',
    'public',
    // Prereleases never become `latest`.
    ...(version.includes('-') ? ['--tag', 'next'] : []),
    ...(dryRun ? ['--dry-run'] : []),
  ];
  for (const argument of args)
    if (!safeArgument.test(argument))
      throw new Error(`Refusing unsafe npm argument ${argument}`);
  return args;
}

function npm(args, options) {
  return spawnSync('npm', args, {
    ...options,
    shell: process.platform === 'win32',
  });
}

async function main() {
  const { tag, version, dryRun } = parseArgs(process.argv.slice(2));
  const pack = JSON.parse(
    await readFile('artifacts/reports/pack.json', 'utf8'),
  );
  const entries = await verifyTarballs(pack, version, (tarball) => {
    const result = spawnSync(
      'tar',
      ['-xzOf', tarball, 'package/package.json'],
      {
        encoding: 'utf8',
      },
    );
    if (result.status !== 0)
      throw new Error(`Cannot read ${tarball}: ${result.stderr}`);
    return result.stdout;
  });
  const order = publishOrder(entries);

  const versionCheck = npm(['--version'], { encoding: 'utf8' });
  const [major = 0, minor = 0] = String(versionCheck.stdout)
    .trim()
    .split('.')
    .map(Number);
  if (major < 11 || (major === 11 && minor < 5))
    throw new Error(
      `npm ${String(versionCheck.stdout).trim()} lacks trusted publishing (need >= 11.5.1)`,
    );

  for (const name of order) {
    const { tarball } = entries.get(name);
    const command = publishArguments(tarball, version, dryRun);
    console.log(`npm ${command.join(' ')}`);
    const result = npm(command, { stdio: 'inherit' });
    if (result.status !== 0) {
      console.error(
        dryRun
          ? `Dry run for ${name} failed; nothing was published.`
          : `Publishing ${name} failed; earlier packages in this order are already public. ` +
              'Fix forward with a patch release; see docs/release/release-process.md (rollback).',
      );
      process.exit(result.status ?? 1);
    }
  }
  console.log(
    `${dryRun ? 'Dry run of' : 'Published'} ${order.length} packages for ${tag}.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
