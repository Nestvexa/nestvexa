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
async function sources(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) await sources(file);
    else if (entry.name.endsWith('.ts')) {
      const text = await readFile(file, 'utf8');
      if (
        /from\s+['"](?:react|vue|svelte|handlebars|@nestvexa\/(?:live|client|inertia|engine-hbs))/.test(
          text,
        )
      )
        throw new Error(`Core renderer dependency: ${file}`);
      if (/\b(?:window|document)\s*\./.test(text))
        throw new Error(`Core browser dependency: ${file}`);
    }
  }
}
await sources('packages/core/src');

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
// Phase 14 optional extensions (ADR 0026): never part of the default install,
// never imported by framework packages, and browser modules stay browser-only.
const extensions = [
  '@nestvexa/i18n',
  '@nestvexa/ui',
  '@nestvexa/ai',
  '@nestvexa/flags',
  '@nestvexa/offline',
];
for (const [name, manifest] of manifests) {
  if (extensions.includes(name)) continue;
  for (const field of [
    'dependencies',
    'peerDependencies',
    'optionalDependencies',
  ])
    for (const dependency of Object.keys(manifest[field] ?? {}))
      if (extensions.includes(dependency))
        throw new Error(
          `${name} must not depend on optional extension ${dependency}`,
        );
}
for (const directory of [
  'core',
  'views',
  'engine-hbs',
  'live',
  'client',
  'alpine',
  'nestvexa',
]) {
  await forbid(
    join('packages', directory, 'src'),
    /from\s+['"]@nestvexa\/(?:i18n|ui|ai|flags|offline)\b/,
    'Framework package imports an optional extension',
  );
}
const nodeOrNest =
  /(?:from\s+|import\s*\(\s*)['"](?:node:|@nestjs\/|@nestvexa\/(?:core|live|views|engine-hbs|realtime|i18n|flags)\b|express|fastify)/;
await forbid(
  'packages/ui/src/browser',
  nodeOrNest,
  'Browser module imports Node or Nest',
);
await forbid(
  'packages/ai/src/browser',
  nodeOrNest,
  'Browser module imports Node or Nest',
);
for (const entry of await readdir('packages/offline/src', {
  withFileTypes: true,
}))
  if (
    entry.isFile() &&
    entry.name.endsWith('.ts') &&
    nodeOrNest.test(
      await readFile(join('packages/offline/src', entry.name), 'utf8'),
    )
  )
    throw new Error(
      `Browser module imports Node or Nest: packages/offline/src/${entry.name}`,
    );
console.log(
  `Dependency graph checked: ${manifests.size} packages; core, view, Inertia adapter and optional extension boundaries intact.`,
);
