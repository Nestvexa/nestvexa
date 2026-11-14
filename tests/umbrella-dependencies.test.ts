import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// REVIEW-018: the default install (`npm install nestvexa`) stays lightweight
// and free of SPA frameworks, Vite, S3 clients, Redis and ORMs. The
// production closure is read from the committed lockfile with the same
// resolver as the release SBOMs (scripts/sbom.mjs), so the check is
// deterministic and needs no network. Changing an allowlist or budget below
// is a reviewed decision: say why in the pull request.

const repository = resolve(import.meta.dirname, '..');
interface Component {
  name: string;
  group?: string;
  version?: string;
  scope: 'required' | 'optional';
  properties?: { name: string; value: string }[];
}
interface SbomModule {
  sbomContext(root: string): {
    workspace: Map<string, { dir: string; manifest: { name: string } }>;
  };
  buildSbom(input: Record<string, unknown>): { components: Component[] };
}
const sbom = (await import(
  new URL('../scripts/sbom.mjs', import.meta.url).href
)) as SbomModule;

/** Third-party runtime packages of the umbrella closure, at locked versions. */
const allowedThirdParty: Readonly<Record<string, string>> = {
  // Alpine's CSP build (the default browser enhancement layer) and the
  // reactivity core it bundles as a dependency; this is not Vue the SPA framework.
  '@alpinejs/csp': '3.17.5',
  '@vue/reactivity': '3.5.44',
  '@vue/shared': '3.5.44',
  // The default template engine and its own dependencies (uglify-js is an
  // optional dependency of handlebars that npm installs by default).
  handlebars: '4.7.10',
  minimist: '1.2.8',
  'neo-async': '2.6.2',
  'source-map': '0.6.1',
  'uglify-js': '3.19.3',
  wordwrap: '1.0.0',
};
const allowedWorkspace = [
  '@nestvexa/alpine',
  '@nestvexa/client',
  '@nestvexa/core',
  '@nestvexa/engine-hbs',
  '@nestvexa/live',
  '@nestvexa/views',
];
/** Peers the application installs; only @nestvexa/cli is optional. */
const allowedPeers = [
  '@nestjs/common',
  '@nestjs/core',
  '@nestvexa/cli',
  'reflect-metadata',
  'rxjs',
];
/**
 * Never in the default closure, whatever the allowlist says: SPA frameworks
 * and their tooling, bundlers, object-storage clients, Redis and ORMs or
 * database drivers. Each has an opt-in Nestvexa package instead.
 */
const denied =
  /^(?:react|react-dom|vue|svelte|preact|solid-js|@angular\/.+|@inertiajs\/.+|vite|@vitejs\/.+|esbuild|rollup|webpack|aws-sdk|@aws-sdk\/.+|@google-cloud\/storage|@azure\/storage-blob|minio|redis|ioredis|@redis\/.+|typeorm|prisma|@prisma\/.+|@mikro-orm\/.+|sequelize|mongoose|mongodb|drizzle-orm|knex|kysely|pg|mysql2?|sqlite3|better-sqlite3)$/;
/**
 * Bytes on disk as installed: third-party package directories, and the
 * Nestvexa packages' packed files. Measured at about 6.6 MB and 2.8 MB.
 */
const thirdPartyBudget = 8 * 1024 * 1024;
const totalBudget = 12 * 1024 * 1024;

const fullName = (component: Component) =>
  component.group ? `${component.group}/${component.name}` : component.name;
const kind = (component: Component) =>
  component.properties?.find((entry) => entry.name === 'nestvexa:dependency')
    ?.value;

function closure(): Component[] {
  const context = sbom.sbomContext(repository);
  const umbrella = context.workspace.get('nestvexa');
  if (!umbrella) throw new Error('nestvexa is not a workspace package');
  return sbom.buildSbom({
    ...context,
    manifest: umbrella.manifest,
    importer: 'packages/nestvexa',
    tarballSha256: '0'.repeat(64),
    timestamp: '2026-01-01T00:00:00.000Z',
  }).components;
}
function bytes(path: string): number {
  const stats = statSync(path);
  if (!stats.isDirectory()) return stats.size;
  let total = 0;
  for (const entry of readdirSync(path))
    if (entry !== 'node_modules') total += bytes(join(path, entry));
  return total;
}
/** The pnpm virtual-store directory of `name@version` (peer suffixes allowed). */
function installed(name: string, version: string): string {
  const store = join(repository, 'node_modules/.pnpm');
  const key = `${name.replace('/', '+')}@${version}`;
  const entry = readdirSync(store).find(
    (item) => item === key || item.startsWith(`${key}_`),
  );
  if (!entry) throw new Error(`${key} is not installed; run pnpm install`);
  return join(store, entry, 'node_modules', name);
}

describe('umbrella nestvexa dependency budget', () => {
  const components = closure();
  const thirdParty = components.filter(
    (component) =>
      component.scope === 'required' && kind(component) !== 'workspace',
  );

  it('adds no third-party runtime package beyond the allowlist', () => {
    expect(
      Object.fromEntries(
        thirdParty
          .map((component) => [fullName(component), component.version ?? ''])
          .sort(([a = ''], [b = '']) => a.localeCompare(b)),
      ),
    ).toEqual(allowedThirdParty);
  });

  it('depends on no other Nestvexa package and on the documented peers only', () => {
    expect(
      components
        .filter((component) => kind(component) === 'workspace')
        .map(fullName)
        .sort(),
    ).toEqual(allowedWorkspace);
    expect(
      components
        .filter((component) => kind(component) === 'peer')
        .map(fullName)
        .sort(),
    ).toEqual(allowedPeers);
  });

  it('contains no SPA framework, bundler, S3 client, Redis client or ORM', () => {
    const names = components.map(fullName);
    expect(names.filter((name) => denied.test(name))).toEqual([]);
    // The deny-list itself is live: these are the packages it must catch.
    for (const name of [
      'react',
      'vue',
      'svelte',
      'vite',
      '@aws-sdk/client-s3',
      'ioredis',
      'redis',
      'typeorm',
      '@prisma/client',
      '@inertiajs/core',
    ])
      expect(denied.test(name), name).toBe(true);
    for (const name of ['@vue/reactivity', 'handlebars', '@alpinejs/csp'])
      expect(denied.test(name), name).toBe(false);
    for (const name of Object.keys(allowedThirdParty))
      expect(denied.test(name), name).toBe(false);
  });

  it('stays within the install-size budget', () => {
    const external = thirdParty.reduce(
      (total, component) =>
        total + bytes(installed(fullName(component), component.version ?? '')),
      0,
    );
    let own = 0;
    for (const name of ['nestvexa', ...allowedWorkspace]) {
      const directory = join(
        repository,
        'packages',
        name === 'nestvexa' ? 'nestvexa' : name.slice('@nestvexa/'.length),
      );
      const manifest = JSON.parse(
        readFileSync(join(directory, 'package.json'), 'utf8'),
      ) as { files: string[] };
      expect(
        existsSync(join(directory, 'dist/index.js')),
        `${name} is not built`,
      ).toBe(true);
      own += bytes(join(directory, 'package.json'));
      for (const file of manifest.files)
        if (existsSync(join(directory, file)))
          own += bytes(join(directory, file));
    }
    expect(external).toBeGreaterThan(1024 * 1024);
    expect(external, `third-party bytes ${external}`).toBeLessThanOrEqual(
      thirdPartyBudget,
    );
    expect(own + external, `total bytes ${own + external}`).toBeLessThanOrEqual(
      totalBudget,
    );
  });
});
