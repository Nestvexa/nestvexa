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
  `Dependency graph checked: ${manifests.size} packages; core, uploads and client boundaries intact.`,
);
