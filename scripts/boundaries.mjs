import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const manifests = new Map();
for (const directory of await readdir('packages')) {
  const manifest = JSON.parse(
    await readFile(join('packages', directory, 'package.json'), 'utf8'),
  );
  manifests.set(manifest.name, { directory, ...manifest });
}
const visited = new Set();
function visit(name, stack = []) {
  if (stack.includes(name))
    throw new Error(`Package cycle: ${[...stack, name].join(' -> ')}`);
  if (visited.has(name)) return;
  const manifest = manifests.get(name);
  for (const dependency of Object.keys(manifest?.dependencies ?? {})) {
    if (manifests.has(dependency)) visit(dependency, [...stack, name]);
  }
  visited.add(name);
}
for (const name of manifests.keys()) visit(name);
// Template engines (first-party adapters and their upstream libraries) stay optional.
const engineImport =
  /from\s+['"](?:handlebars|ejs|pug|nunjucks|@nestvexa\/engine-[a-z0-9-]+)['"/]/;
async function sources(path, rules) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) await sources(file, rules);
    else if (entry.name.endsWith('.ts')) {
      const text = await readFile(file, 'utf8');
      for (const [pattern, message] of rules)
        if (pattern.test(text)) throw new Error(`${message}: ${file}`);
    }
  }
}
await sources('packages/core/src', [
  [
    /from\s+['"](?:react|vue|svelte|@nestvexa\/(?:live|client|inertia))/,
    'Core renderer dependency',
  ],
  [engineImport, 'Core renderer dependency'],
  [/\b(?:window|document)\s*\./, 'Core browser dependency'],
]);
await sources('packages/views/src', [
  [engineImport, 'Views contract imports a template engine'],
  [
    /from\s+['"](?:react|vue|svelte|@nestvexa\/(?:live|client|inertia)|nestvexa['"/])/,
    'Views contract imports a renderer or runtime',
  ],
]);
// The default distribution keeps alternative engines optional peers of the host.
for (const [name, manifest] of manifests)
  if (name === 'nestvexa')
    for (const dependency of Object.keys({
      ...manifest.dependencies,
      ...manifest.peerDependencies,
    }))
      if (/^@nestvexa\/engine-(?!hbs$)/.test(dependency))
        throw new Error(`Umbrella must not depend on optional ${dependency}`);

// Renderer-neutral packages must never import an adapter or a client framework.
async function forbid(path, pattern, label) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) await forbid(file, pattern, label);
    else if (
      entry.name.endsWith('.ts') &&
      pattern.test(await readFile(file, 'utf8'))
    )
      throw new Error(`${label}: ${file}`);
  }
}
await forbid(
  'packages/views/src',
  /from\s+['"](?:react|vue|svelte|@inertiajs\/|@nestvexa\/(?:inertia|live|client))/,
  'View contract imports an adapter or client framework',
);
// The Inertia server adapter speaks the wire protocol only; client packages stay
// devDependencies of examples and are never runtime dependencies.
await forbid(
  'packages/inertia/src',
  /from\s+['"](?:react|react-dom|vue|svelte|@inertiajs\/|@nestvexa\/(?:live|client|engine-hbs))/,
  'Inertia server adapter imports a client framework',
);
const inertia = manifests.get('@nestvexa/inertia');
for (const field of ['dependencies', 'peerDependencies']) {
  for (const name of Object.keys(inertia?.[field] ?? {}))
    if (/^(?:react|react-dom|vue|svelte|@inertiajs\/)/.test(name))
      throw new Error(`@nestvexa/inertia must not depend on ${name}`);
}
// Uploads is an opt-in server package: no Live/client/umbrella coupling and no
// mandatory cloud SDK (S3 uses SigV4 on node:crypto).
async function uploadSources(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) await uploadSources(file);
    else if (entry.name.endsWith('.ts')) {
      const text = await readFile(file, 'utf8');
      if (
        /from\s+['"](?:@nestvexa\/(?:live|client|alpine)|nestvexa|@aws-sdk\/|aws-sdk)/.test(
          text,
        )
      )
        throw new Error(`Uploads boundary violation: ${file}`);
    }
  }
}
await uploadSources('packages/uploads/src');
const uploadsManifest = manifests.get('@nestvexa/uploads');
if (
  uploadsManifest &&
  Object.keys({
    ...uploadsManifest.dependencies,
    ...uploadsManifest.peerDependencies,
  }).some((name) => name.startsWith('@aws-sdk/') || name === 'aws-sdk')
)
  throw new Error('Uploads must not require a cloud SDK');
// Browser runtime code must never import Node or Nest modules.
for (const entry of await readdir('packages/client/src')) {
  const text = await readFile(join('packages/client/src', entry), 'utf8');
  if (/from\s+['"](?:node:|@nestjs\/|@nestvexa\/uploads)/.test(text))
    throw new Error(`Client browser boundary violation: ${entry}`);
}
console.log(
  `Dependency graph checked: ${manifests.size} packages; core, views, engine, Inertia, uploads and client boundaries intact.`,
);
