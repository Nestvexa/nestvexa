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
console.log(
  `Dependency graph checked: ${manifests.size} packages; core/views engine boundaries intact.`,
);
