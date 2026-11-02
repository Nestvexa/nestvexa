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

async function files(path, visit) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) await files(file, visit);
    else if (entry.name.endsWith('.ts'))
      await visit(file, await readFile(file, 'utf8'));
  }
}
const specifiers = (text) =>
  [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map(
    (match) => match[1],
  );
// The browser client (and the wire contract it shares) must stay free of
// Node, Nest, compiler and server-runtime imports.
for (const directory of ['client', 'shared'])
  await files(join('packages/actions/src', directory), (file, text) => {
    for (const specifier of specifiers(text)) {
      const allowed =
        specifier.startsWith('./') ||
        (directory === 'client' &&
          /^\.\.\/shared\/[\w-]+\.js$/.test(specifier));
      if (!allowed)
        throw new Error(
          `Browser-safe actions module ${file} imports ${specifier}`,
        );
    }
  });
// Actions and Live stay independent packages (no cycles, no coupling).
await files('packages/actions/src', (file, text) => {
  if (specifiers(text).some((specifier) => specifier.startsWith('@nestvexa/')))
    throw new Error(
      `@nestvexa/actions must not import other Nestvexa packages: ${file}`,
    );
});
await files('packages/live/src', (file, text) => {
  if (specifiers(text).includes('@nestvexa/actions'))
    throw new Error(
      `@nestvexa/live must not import @nestvexa/actions: ${file}`,
    );
});
console.log(
  `Dependency graph checked: ${manifests.size} packages; core runtime and browser action client boundaries intact.`,
);
