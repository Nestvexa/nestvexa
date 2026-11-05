// CycloneDX 1.6 JSON SBOMs for packed workspace tarballs, resolved from the
// committed pnpm lockfile (v9) without network access or extra dependencies.
//
// For each public package the SBOM lists:
// - `metadata.component`: the package itself, with the tarball's SHA-256;
// - its runtime `dependencies` and their full transitive closure (scope
//   `required`), at the exact lockfile versions with registry integrity hashes;
//   workspace dependencies appear as the sibling Nestvexa package at its
//   version, followed by their own runtime closure;
// - `peerDependencies` (scope `optional`, property `nestvexa:dependency=peer`)
//   at the version the workspace tested against. Peers are installed by the
//   consuming application, so their transitive closure is not claimed.
// devDependencies never appear. Licenses are read from installed package
// manifests when present; nothing is guessed.
//
//   node scripts/sbom.mjs <package-dir>... [--out artifacts/sbom]
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const unquote = (value) => value.trim().replace(/^'(.*)'$/, '$1');

/** Minimal reader for the three pnpm v9 lockfile sections this script needs. */
export function readLockfile(text) {
  if (!/^lockfileVersion: '9\.\d+'/m.test(text))
    throw new Error('SBOM generation requires a pnpm v9 lockfile');
  const importers = new Map();
  const packages = new Map();
  const snapshots = new Map();
  let section;
  let entry;
  let group;
  let dependency;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const content = line.trim();
    if (indent === 0) {
      section = content.replace(/:$/, '');
      entry = undefined;
      continue;
    }
    if (indent === 2) {
      const key = unquote(content.replace(/:( \{\})?$/, ''));
      entry = { dependencies: new Map(), groups: new Map() };
      group = undefined;
      if (section === 'importers') importers.set(key, entry);
      else if (section === 'packages') packages.set(key, entry);
      else if (section === 'snapshots') snapshots.set(key, entry);
      continue;
    }
    if (!entry) continue;
    if (indent === 4) {
      const match = /^([A-Za-z]+):\s*(.*)$/.exec(content);
      if (!match) continue;
      const [, name, rest] = match;
      if (name === 'resolution') {
        const integrity = /integrity: ([^,}\s]+)/.exec(rest);
        if (integrity) entry.integrity = integrity[1];
      }
      group = rest ? undefined : name;
      if (group) entry.groups.set(group, new Map());
      continue;
    }
    if (!group) continue;
    const target = entry.groups.get(group);
    if (section === 'importers') {
      if (indent === 6) {
        dependency = unquote(content.replace(/:$/, ''));
        target.set(dependency, {});
      } else if (indent === 8 && dependency) {
        const match = /^(specifier|version):\s*(.*)$/.exec(content);
        if (match) target.get(dependency)[match[1]] = unquote(match[2]);
      }
    } else if (section === 'snapshots' && indent === 6) {
      const separator = content.lastIndexOf(': ');
      if (separator > 0)
        target.set(
          unquote(content.slice(0, separator)),
          unquote(content.slice(separator + 2)),
        );
    }
  }
  return { importers, packages, snapshots };
}

const plainVersion = (version) => version.replace(/\(.*$/, '');
function purl(name, version) {
  return `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}@${version}`;
}
function integrityHash(integrity) {
  const match = /^sha512-(.+)$/.exec(integrity ?? '');
  return match
    ? [
        {
          alg: 'SHA-512',
          content: Buffer.from(match[1], 'base64').toString('hex'),
        },
      ]
    : [];
}
const storeEntries = new Map();
function installedLicense(root, name, version) {
  // Virtual store directories may carry a peer/hash suffix after `_`.
  const store = `${name.replace('/', '+')}@${version}`;
  if (!storeEntries.has(root)) {
    const directory = join(root, 'node_modules/.pnpm');
    storeEntries.set(root, existsSync(directory) ? readdirSync(directory) : []);
  }
  for (const entry of storeEntries.get(root)) {
    if (entry !== store && !entry.startsWith(`${store}_`)) continue;
    const manifest = join(
      root,
      'node_modules/.pnpm',
      entry,
      'node_modules',
      name,
      'package.json',
    );
    if (!existsSync(manifest)) continue;
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
    if (typeof parsed.license === 'string') return parsed.license;
    // Legacy `licenses: [{ type }]` manifests (for example busboy).
    if (Array.isArray(parsed.licenses)) {
      const types = parsed.licenses
        .map((item) => (typeof item === 'string' ? item : item?.type))
        .filter((type) => typeof type === 'string');
      if (types.length) return types.join(' OR ');
    }
    if (typeof parsed.license?.type === 'string') return parsed.license.type;
  }
  return undefined;
}
function licenses(expression) {
  if (!expression) return undefined;
  return /^[A-Za-z0-9.+-]+$/.test(expression)
    ? [{ license: { id: expression } }]
    : [{ expression }];
}
/** Deterministic urn:uuid derived from the content it describes. */
function serial(seed) {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Build one SBOM. `workspace` maps workspace package names to
 * `{ dir, manifest }`; `lock` is the parsed lockfile.
 */
export function buildSbom({
  root,
  lock,
  workspace,
  manifest,
  importer,
  tarballSha256,
  timestamp,
  tarballHashes = new Map(),
}) {
  const components = new Map();
  const edges = new Map();
  const self = purl(manifest.name, manifest.version);
  const addEdge = (from, to) => {
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from).add(to);
  };
  const visitRegistry = (name, version, parent, scope) => {
    const ref = purl(name, plainVersion(version));
    addEdge(parent, ref);
    if (components.has(ref)) return;
    const key = `${name}@${plainVersion(version)}`;
    components.set(ref, {
      type: 'library',
      'bom-ref': ref,
      ...(name.startsWith('@')
        ? {
            group: name.slice(0, name.indexOf('/')),
            name: name.slice(name.indexOf('/') + 1),
          }
        : { name }),
      version: plainVersion(version),
      scope,
      purl: ref,
      hashes: integrityHash(lock.packages.get(key)?.integrity),
      ...(licenses(installedLicense(root, name, plainVersion(version)))
        ? {
            licenses: licenses(
              installedLicense(root, name, plainVersion(version)),
            ),
          }
        : {}),
    });
    if (scope !== 'required') return;
    const snapshot = lock.snapshots.get(`${name}@${version}`);
    for (const groupName of ['dependencies', 'optionalDependencies'])
      for (const [child, childVersion] of snapshot?.groups.get(groupName) ?? [])
        visitRegistry(child, childVersion, ref, 'required');
  };
  const visitImporter = (
    packageManifest,
    importerKey,
    parent,
    includePeers,
  ) => {
    const resolved = lock.importers.get(importerKey);
    // Peers are often installed for tests as devDependencies of the importer.
    const installed = new Map([
      ...(resolved?.groups.get('devDependencies') ?? []),
      ...(resolved?.groups.get('optionalDependencies') ?? []),
      ...(resolved?.groups.get('dependencies') ?? []),
    ]);
    const runtime = Object.keys(packageManifest.dependencies ?? {});
    const peers = includePeers
      ? Object.keys(packageManifest.peerDependencies ?? {})
      : [];
    for (const name of [...runtime, ...peers]) {
      const peer = !runtime.includes(name);
      const sibling = workspace.get(name);
      if (sibling) {
        const ref = purl(name, sibling.manifest.version);
        addEdge(parent, ref);
        if (!components.has(ref)) {
          components.set(ref, {
            type: 'library',
            'bom-ref': ref,
            group: name.startsWith('@')
              ? name.slice(0, name.indexOf('/'))
              : undefined,
            name: name.startsWith('@')
              ? name.slice(name.indexOf('/') + 1)
              : name,
            version: sibling.manifest.version,
            scope: peer ? 'optional' : 'required',
            purl: ref,
            ...(tarballHashes.has(name)
              ? {
                  hashes: [
                    { alg: 'SHA-256', content: tarballHashes.get(name) },
                  ],
                }
              : {}),
            ...(licenses(sibling.manifest.license)
              ? { licenses: licenses(sibling.manifest.license) }
              : {}),
            properties: [
              {
                name: 'nestvexa:dependency',
                value: peer ? 'peer' : 'workspace',
              },
            ],
          });
          if (!peer)
            visitImporter(
              sibling.manifest,
              `packages/${basename(sibling.dir)}`,
              ref,
              false,
            );
        }
        continue;
      }
      const version = installed.get(name)?.version;
      if (!version && peer) {
        // An optional peer the workspace never installs: record the range only.
        const range = String(packageManifest.peerDependencies[name]);
        const ref = `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}`;
        addEdge(parent, ref);
        components.set(ref, {
          type: 'library',
          'bom-ref': ref,
          name,
          scope: 'optional',
          purl: ref,
          properties: [
            { name: 'nestvexa:dependency', value: 'peer' },
            { name: 'nestvexa:versionRange', value: range },
          ],
        });
        continue;
      }
      if (!version)
        throw new Error(
          `${manifest.name}: ${name} is not resolved in the lockfile`,
        );
      visitRegistry(name, version, parent, peer ? 'optional' : 'required');
      if (peer) {
        const component = components.get(purl(name, plainVersion(version)));
        component.properties = [{ name: 'nestvexa:dependency', value: 'peer' }];
      }
    }
  };
  visitImporter(manifest, importer, self, true);
  const scoped = manifest.name.startsWith('@');
  const ordered = [...components.values()]
    .map((component) => JSON.parse(JSON.stringify(component)))
    .sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref']));
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: serial(`${self}:${tarballSha256}`),
    version: 1,
    metadata: {
      timestamp,
      tools: {
        components: [
          {
            type: 'application',
            name: 'nestvexa-sbom',
            description: 'scripts/sbom.mjs (pnpm lockfile v9 reader)',
          },
        ],
      },
      component: {
        type: 'library',
        'bom-ref': self,
        ...(scoped
          ? {
              group: manifest.name.slice(0, manifest.name.indexOf('/')),
              name: manifest.name.slice(manifest.name.indexOf('/') + 1),
            }
          : { name: manifest.name }),
        version: manifest.version,
        purl: self,
        ...(licenses(manifest.license)
          ? { licenses: licenses(manifest.license) }
          : {}),
        hashes: [{ alg: 'SHA-256', content: tarballSha256 }],
      },
    },
    components: ordered,
    dependencies: [...edges.entries()]
      .map(([ref, dependsOn]) => ({ ref, dependsOn: [...dependsOn].sort() }))
      .sort((a, b) => a.ref.localeCompare(b.ref)),
  };
}

/** Load the workspace package map and lockfile once for a set of SBOMs. */
export function sbomContext(root) {
  const lock = readLockfile(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'));
  const workspace = new Map();
  for (const key of lock.importers.keys()) {
    if (!key.startsWith('packages/')) continue;
    const dir = join(root, key);
    const manifest = JSON.parse(
      readFileSync(join(dir, 'package.json'), 'utf8'),
    );
    workspace.set(manifest.name, { dir, manifest });
  }
  return { root, lock, workspace };
}

/** Write `<out>/<tarball>.cdx.json` and return its path and digest. */
export async function writeSbom(
  context,
  { dir, tarball, tarballSha256, timestamp, out, tarballHashes },
) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const sbom = buildSbom({
    ...context,
    manifest,
    importer: `packages/${basename(dir)}`,
    tarballSha256,
    timestamp,
    ...(tarballHashes ? { tarballHashes } : {}),
  });
  await mkdir(out, { recursive: true });
  const file = join(out, `${basename(tarball).replace(/\.tgz$/, '')}.cdx.json`);
  const text = `${JSON.stringify(sbom, null, 2)}\n`;
  await writeFile(file, text);
  return {
    file,
    sha256: createHash('sha256').update(text).digest('hex'),
    components: sbom.components.length,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const out = resolve(outIndex >= 0 ? args[outIndex + 1] : 'artifacts/sbom');
  const dirs = args.filter(
    (_, index) => index !== outIndex && index !== outIndex + 1,
  );
  const context = sbomContext(process.cwd());
  for (const dir of dirs) {
    const manifest = JSON.parse(
      readFileSync(join(dir, 'package.json'), 'utf8'),
    );
    const result = await writeSbom(context, {
      dir: resolve(dir),
      tarball: `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`,
      tarballSha256: '0'.repeat(64),
      timestamp: new Date().toISOString(),
      out,
    });
    console.log(
      `${result.file}: ${result.components} components (unpacked; tarball hash not computed)`,
    );
  }
}
