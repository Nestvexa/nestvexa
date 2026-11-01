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

// Server packages (core, views, Live, Inertia, Vite integration) never import a
// client framework; frontend adapters own exactly one framework each.
const frameworkImport =
  /(?:from\s+|import\s*\(\s*)['"](?:react|react-dom|vue|svelte|@inertiajs\/|@vitejs\/|@sveltejs\/)/;
for (const name of ['core', 'views', 'live', 'inertia', 'vite'])
  await forbid(
    `packages/${name}/src`,
    frameworkImport,
    `@nestvexa/${name} imports a client framework`,
  );
const adapters = {
  '@nestvexa/react': /['"](?:vue|svelte|@inertiajs\/(?:vue3|svelte))['"/]/,
  '@nestvexa/vue':
    /['"](?:react|react-dom|svelte|@inertiajs\/(?:react|svelte))['"/]/,
  '@nestvexa/svelte':
    /['"](?:react|react-dom|vue|@inertiajs\/(?:react|vue3))['"/]/,
};
for (const [name, foreign] of Object.entries(adapters)) {
  const manifest = manifests.get(name);
  if (!manifest) throw new Error(`Missing frontend adapter ${name}`);
  await forbid(
    `packages/${manifest.directory}/src`,
    new RegExp(`from\\s+${foreign.source}`),
    `${name} imports another framework`,
  );
  // Frameworks are peers so applications never get duplicated runtimes.
  for (const dependency of Object.keys(manifest.dependencies ?? {}))
    if (/^(?:react|react-dom|vue|svelte|@inertiajs\/)/.test(dependency))
      throw new Error(
        `${name} must declare ${dependency} as a peer dependency`,
      );
}
// The umbrella package must not pull frontend frameworks into default installs.
const umbrella = manifests.get('nestvexa');
for (const field of ['dependencies', 'peerDependencies'])
  for (const dependency of Object.keys(umbrella?.[field] ?? {}))
    if (
      /^(?:react|react-dom|vue|svelte|vite|@inertiajs\/|@nestvexa\/(?:react|vue|svelte|vite))$/.test(
        dependency,
      )
    )
      throw new Error(`nestvexa must not depend on ${dependency}`);
console.log(
  `Dependency graph checked: ${manifests.size} packages; core, view, Inertia, Vite and frontend adapter boundaries intact.`,
);
