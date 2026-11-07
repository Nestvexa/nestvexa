// License audit of what Nestvexa packages ship to applications.
//
// Scope: the production dependency closure of every public package under
// packages/ (as resolved by `pnpm licenses list --prod` from the lockfile
// install) plus each declared peer dependency itself (installed by the
// consuming app; its own closure is the app's choice, as in scripts/sbom.mjs).
// devDependencies, examples and the docs site are out of scope.
//
// Every license must be an SPDX identifier (or expression) on the allowlist.
// Copyleft, missing, unknown or non-SPDX licenses fail the audit unless the
// exact package@version is listed in `reviewed` with a written reason.
//
//   pnpm audit:licenses [--json artifacts/reports/licenses.json]
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Permissive licenses compatible with redistribution under MIT. */
export const allowed = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'Python-2.0',
  'Unlicense',
]);

/** Licenses that must never enter the shipped closure without review. */
const copyleft =
  /^(?:A?GPL|LGPL|MPL|EPL|EUPL|CDDL|CPAL|OSL|SSPL|RPL|QPL|Sleepycat|CC-BY-SA|CC-BY-NC|BUSL|Elastic|Commons-Clause)/i;

/**
 * Exact `name@version` exceptions after human review. Empty: nothing in the
 * shipped closure currently needs one.
 * @type {Readonly<Record<string, string>>}
 */
export const reviewed = Object.freeze({});

/**
 * Evaluates an SPDX expression: OR needs one allowed side, AND needs both.
 * Returns `allowed`, `copyleft` or `unknown`.
 */
export function classify(expression) {
  if (typeof expression !== 'string' || !expression.trim()) return 'unknown';
  const text = expression.trim().replace(/^\((.*)\)$/, '$1');
  if (/\s+OR\s+/i.test(text)) {
    const parts = text.split(/\s+OR\s+/i).map(classify);
    if (parts.includes('allowed')) return 'allowed';
    return parts.includes('copyleft') ? 'copyleft' : 'unknown';
  }
  if (/\s+AND\s+/i.test(text)) {
    const parts = text.split(/\s+AND\s+/i).map(classify);
    if (parts.every((part) => part === 'allowed')) return 'allowed';
    return parts.includes('copyleft') ? 'copyleft' : 'unknown';
  }
  const id = text.replace(/\s+WITH\s+.+$/i, '').replace(/\+$/, '');
  if (allowed.has(id)) return 'allowed';
  if (copyleft.test(id)) return 'copyleft';
  return 'unknown';
}

/** Normalizes the legacy `license` object / `licenses` array manifest forms. */
function manifestLicense(manifest) {
  const value = manifest.license ?? manifest.licenses;
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value
      .map((entry) => (typeof entry === 'string' ? entry : entry?.type))
      .filter((entry) => typeof entry === 'string')
      .join(' OR ');
  if (value && typeof value === 'object' && typeof value.type === 'string')
    return value.type;
  return undefined;
}

function publicPackages(root) {
  const directory = join(root, 'packages');
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(directory, entry.name))
    .filter((path) => existsSync(join(path, 'package.json')))
    .map((path) => ({
      path,
      manifest: JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')),
    }))
    .filter(({ manifest }) => manifest.private !== true);
}

/** Production closure as reported by pnpm (`{ license: [{ name, versions }] }`). */
function productionClosure(root) {
  const pnpm = process.env.npm_execpath;
  if (!pnpm)
    throw new Error(
      'Run with pnpm audit:licenses so the package manager entry is explicit.',
    );
  const result = spawnSync(
    process.execPath,
    [pnpm, '--filter', './packages/*', 'licenses', 'list', '--prod', '--json'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0)
    throw new Error(`pnpm licenses failed:\n${result.stderr}`);
  const grouped = JSON.parse(result.stdout);
  const entries = [];
  for (const [license, packages] of Object.entries(grouped))
    for (const entry of packages)
      for (const version of entry.versions)
        entries.push({
          name: entry.name,
          version,
          // pnpm groups packages without a license field under "Unknown".
          license:
            license === 'Unknown' ? undefined : (entry.license ?? license),
          via: 'dependency',
        });
  return entries;
}

/** Each declared peer as installed for the workspace (not its closure). */
function peers(root, packages) {
  const entries = new Map();
  const workspace = new Set(packages.map(({ manifest }) => manifest.name));
  for (const { path, manifest } of packages)
    for (const name of Object.keys(manifest.peerDependencies ?? {})) {
      if (workspace.has(name)) continue;
      const file = join(path, 'node_modules', name, 'package.json');
      if (!existsSync(file)) {
        entries.set(`${name}@missing`, {
          name,
          version: 'not installed',
          license: undefined,
          via: `peer of ${manifest.name}`,
        });
        continue;
      }
      const peer = JSON.parse(readFileSync(file, 'utf8'));
      entries.set(`${name}@${peer.version}`, {
        name,
        version: peer.version,
        license: manifestLicense(peer),
        via: `peer of ${manifest.name}`,
      });
    }
  return [...entries.values()];
}

export async function audit(root, report) {
  const packages = publicPackages(root);
  const seen = new Map();
  for (const entry of [...productionClosure(root), ...peers(root, packages)]) {
    const key = `${entry.name}@${entry.version}`;
    if (!seen.has(key)) seen.set(key, entry);
  }
  const results = [...seen.values()]
    .map((entry) => {
      const key = `${entry.name}@${entry.version}`;
      const verdict = classify(entry.license);
      return {
        ...entry,
        verdict,
        ...(verdict !== 'allowed' && reviewed[key]
          ? { reviewed: reviewed[key] }
          : {}),
      };
    })
    .sort((left, right) =>
      `${left.name}@${left.version}`.localeCompare(
        `${right.name}@${right.version}`,
      ),
    );
  const failures = results.filter(
    (entry) => entry.verdict !== 'allowed' && !entry.reviewed,
  );
  const summary = {
    schema: 'nestvexa-license-audit/1',
    generatedAt: new Date().toISOString(),
    scope:
      'production dependency closure of public packages/* plus declared peers',
    allowlist: [...allowed].sort(),
    packages: results.length,
    licenses: Object.fromEntries(
      [
        ...results.reduce(
          (counts, entry) =>
            counts.set(
              entry.license ?? 'UNKNOWN',
              (counts.get(entry.license ?? 'UNKNOWN') ?? 0) + 1,
            ),
          new Map(),
        ),
      ].sort(([left], [right]) => left.localeCompare(right)),
    ),
    failures,
    results,
  };
  if (report) {
    await mkdir(dirname(report), { recursive: true });
    await writeFile(report, JSON.stringify(summary, null, 2) + '\n');
  }
  return summary;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = resolve(import.meta.dirname, '..');
  const index = process.argv.indexOf('--json');
  const report = resolve(
    root,
    index > 0
      ? (process.argv[index + 1] ?? '')
      : 'artifacts/reports/licenses.json',
  );
  const summary = await audit(root, report);
  console.log(
    `License audit: ${summary.packages} packages (${Object.entries(
      summary.licenses,
    )
      .map(([license, count]) => `${license} ${count}`)
      .join(', ')}).`,
  );
  if (summary.failures.length) {
    for (const failure of summary.failures)
      console.error(
        `  ${failure.verdict.toUpperCase()}: ${failure.name}@${failure.version} (${failure.license ?? 'no license'}) via ${failure.via}`,
      );
    console.error(
      `License audit failed: ${summary.failures.length} package(s) outside the allowlist. Review and add an exact exception to scripts/licenses.mjs only with a written reason.`,
    );
    process.exit(1);
  }
  console.log(`No copyleft or unknown licenses. Report: ${report}`);
}
