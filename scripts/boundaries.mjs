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
// Phase 14 optional extensions (ADR 0026): never part of the default install,
// never imported by framework packages, and browser modules stay browser-only.
const extensions = [
  '@nestvexa/i18n',
  '@nestvexa/ui',
  '@nestvexa/ai',
  '@nestvexa/flags',
  '@nestvexa/offline',
  '@nestvexa/mail',
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
    /from\s+['"]@nestvexa\/(?:i18n|ui|ai|flags|offline|mail)\b/,
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
// @nestvexa/i18n/client and the pure modules it imports run in browsers.
for (const file of ['client', 'message', 'format', 'errors', 'locale']) {
  const text = await readFile(`packages/i18n/src/${file}.ts`, 'utf8');
  if (
    nodeOrNest.test(text) ||
    /from\s+['"]@nestvexa\/views/.test(text) ||
    specifiers(text).some(
      (specifier) =>
        specifier.startsWith('./') &&
        !/^\.\/(?:message|format|errors|locale)\.js$/.test(specifier),
    )
  )
    throw new Error(
      `Browser i18n client imports a server module: packages/i18n/src/${file}.ts`,
    );
}
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
  `Dependency graph checked: ${manifests.size} packages; core, views, engine, Inertia, Vite, frontend adapter, uploads, actions, client and optional extension boundaries intact.`,
);
