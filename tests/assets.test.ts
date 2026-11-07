import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Controller,
  Get,
  Injectable,
  Version,
  VersioningType,
} from '@nestjs/common';
import type {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  NestvexaAssetsModule,
  NestvexaAssetsService,
} from '../packages/nestvexa/dist/assets.js';
import {
  CLIENT_MODULES,
  assetTag,
  catalogVersion,
  matchesAssetTag,
  normalizeAssetOptions,
} from '../packages/nestvexa/dist/asset-catalog.js';
import type { NestvexaAssetOptions } from '../packages/nestvexa/dist/assets.js';

const apps = new Set<INestApplication>();
afterEach(async () => {
  await Promise.all([...apps].map((app) => app.close()));
  apps.clear();
});

interface AssetResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}
/** Raw node:http paths retain encoded traversal inputs and avoid fetch's reserved-port policy. */
async function send(
  app: INestApplication,
  path: string,
  headers: Readonly<Record<string, string>> = {},
  method = 'GET',
): Promise<AssetResponse> {
  const base = new URL(await app.getUrl());
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: base.hostname,
        port: base.port,
        path,
        headers,
        method,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: unknown) => {
          if (Buffer.isBuffer(chunk)) chunks.push(chunk);
          else outgoing.destroy(new Error('Unexpected non-buffer HTTP chunk'));
        });
        response.on('error', reject);
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    outgoing.on('error', reject);
    outgoing.setTimeout(5000, () =>
      outgoing.destroy(new Error('Asset test HTTP timeout')),
    );
    outgoing.end();
  });
}

@Controller('api')
class NativeController {
  @Get('health')
  @Version('1')
  health() {
    return { ok: true };
  }
}
@Injectable()
class HostGuard implements CanActivate {
  calls = 0;
  canActivate(context: ExecutionContext): boolean {
    this.calls++;
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, unknown> }>();
    return request.headers['x-assets-test-deny'] !== 'yes';
  }
}
async function application(
  platform: 'express' | 'fastify',
  options: NestvexaAssetOptions = {},
  versioning?: 'uri' | 'header',
) {
  const module = await Test.createTestingModule({
    imports: [NestvexaAssetsModule.register(options)],
    controllers: [NativeController],
    providers: [HostGuard],
  }).compile();
  const app =
    platform === 'fastify'
      ? module.createNestApplication(new FastifyAdapter(), { logger: false })
      : module.createNestApplication({ logger: false });
  apps.add(app);
  app.useGlobalGuards(app.get(HostGuard));
  if (options.basePath === '/host') app.setGlobalPrefix('host');
  if (versioning === 'uri')
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  if (versioning === 'header')
    app.enableVersioning({
      type: VersioningType.HEADER,
      header: 'X-API-Version',
      defaultVersion: '1',
    });
  const assets = app.get(NestvexaAssetsService);
  return { app, assets };
}

describe('asset conditional request parser', () => {
  it('does not match a wildcard inside another valid opaque entity tag', () => {
    expect(
      matchesAssetTag('"prefix,*,suffix"', assetTag('asset content')),
    ).toBe(false);
  });
  it.each([
    ['exact', (tag: string) => tag, true],
    ['weak', (tag: string) => `W/${tag}`, true],
    ['wildcard', () => '*', true],
    ['surrounding whitespace', (tag: string) => ` \t${tag}\t `, true],
    [
      'nonmatching member then weak match',
      (tag: string) => `"old", W/${tag}`,
      true,
    ],
    [
      'nonmatching quoted comma member',
      (tag: string) => `"old,tag", ${tag}`,
      true,
    ],
    ['different representation', () => '"old"', false],
    ['wildcard as list member', (tag: string) => `"old", *, ${tag}`, false],
    ['trailing comma', (tag: string) => `${tag},`, false],
    ['missing separator', (tag: string) => `${tag} ${tag}`, false],
    ['unclosed opaque tag', (tag: string) => `"prefix,${tag}`, false],
    ['unquoted digest', (tag: string) => tag.slice(1, -1), false],
    ['line break', (tag: string) => `${tag}\r\n`, false],
    ['single trailing newline', (tag: string) => `${tag}\n`, false],
    ['wildcard trailing newline', () => '*\n', false],
    ['missing header', () => undefined, false],
    ['multiple header array', (tag: string) => [tag], false],
  ] as const)(
    'handles %s without interpreting quoted punctuation as a list',
    (_label, header, expected) => {
      const tag = assetTag('asset content');
      expect(matchesAssetTag(header(tag), tag)).toBe(expected);
    },
  );
});

describe('asset catalog and configuration boundaries', () => {
  it('normalizes immutable defaults and explicit root-relative deployment paths', () => {
    expect(normalizeAssetOptions({})).toEqual({
      path: '/_nestvexa/assets',
      basePath: '',
    });
    const options = normalizeAssetOptions({
      path: '/ui/client-assets',
      basePath: '/host/proxy',
    });
    expect(options).toEqual({
      path: '/ui/client-assets',
      basePath: '/host/proxy',
    });
    expect(Object.isFrozen(options)).toBe(true);
  });
  it.each([
    null,
    undefined,
    [],
    1,
    'assets',
    new Date(),
    { path: '' },
    { path: '/' },
    { path: 'relative' },
    { path: '//external' },
    { path: 'https://external/assets' },
    { path: '/x/' },
    { path: '/x//y' },
    { path: '/x/../y' },
    { path: '/x/./y' },
    { path: '/x%2fy' },
    { path: '/x?query' },
    { path: '/x#fragment' },
    { path: '/x\\y' },
    { path: '/x\0y' },
    { path: '/x\n' },
    { basePath: '/host\n' },
    { path: null },
    { path: false },
    { path: '/' + 'x'.repeat(256) },
    { basePath: '/' },
    { basePath: 'host' },
    { basePath: '/host/' },
    { basePath: '/host%2fnext' },
    { basePath: '/' + 'x'.repeat(256) },
    { unknown: 'not allowed' },
    { [Symbol('hidden')]: '/assets' },
    Object.create({ path: '/inherited' }),
  ])(
    'rejects invalid configuration %# without silently normalizing unsafe paths',
    (value: unknown) => {
      expect(() => normalizeAssetOptions(value)).toThrow(
        'Invalid client asset configuration',
      );
    },
  );
  it('does not execute accessors while validating options', () => {
    let calls = 0;
    const options = Object.defineProperty({}, 'path', {
      get() {
        calls++;
        return '/assets';
      },
    });
    expect(() => normalizeAssetOptions(options)).toThrow();
    expect(calls).toBe(0);
  });
  it('ignores inherited Object.prototype option getters without evaluating them', () => {
    const path = Object.getOwnPropertyDescriptor(Object.prototype, 'path');
    const basePath = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'basePath',
    );
    let calls = 0;
    let normalized: ReturnType<typeof normalizeAssetOptions> | undefined;
    try {
      Object.defineProperty(Object.prototype, 'path', {
        configurable: true,
        get() {
          calls++;
          return '/inherited';
        },
      });
      Object.defineProperty(Object.prototype, 'basePath', {
        configurable: true,
        get() {
          calls++;
          return '/inherited-prefix';
        },
      });
      normalized = normalizeAssetOptions({});
    } finally {
      if (path) Object.defineProperty(Object.prototype, 'path', path);
      else Reflect.deleteProperty(Object.prototype, 'path');
      if (basePath)
        Object.defineProperty(Object.prototype, 'basePath', basePath);
      else Reflect.deleteProperty(Object.prototype, 'basePath');
    }
    expect(calls).toBe(0);
    expect(normalized).toEqual({ path: '/_nestvexa/assets', basePath: '' });
  });
  it('hashes catalog order independently while separating names, lengths and Unicode bytes', () => {
    const files = new Map([
      ['a.js', 'α'],
      ['b.js', 'مرحبا'],
    ]);
    expect(catalogVersion(files)).toMatch(/^[a-f0-9]{64}$/);
    expect(catalogVersion(new Map([...files].reverse()))).toBe(
      catalogVersion(files),
    );
    expect(catalogVersion(new Map([['a', 'bc']]))).not.toBe(
      catalogVersion(new Map([['ab', 'c']])),
    );
    expect(
      catalogVersion(
        new Map([
          ['a.js', 'α'],
          ['b.js', 'changed'],
        ]),
      ),
    ).not.toBe(catalogVersion(files));
    expect(
      catalogVersion(
        new Map([
          ['renamed.js', 'α'],
          ['b.js', 'مرحبا'],
        ]),
      ),
    ).not.toBe(catalogVersion(files));
    expect(assetTag('hello')).toBe(
      '"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"',
    );
  });
  it('serves the canonical entry plus on-demand chunks only, and excludes private test outputs', async () => {
    const manifest = JSON.parse(
      await readFile(
        new URL('../packages/client/package.json', import.meta.url),
        'utf8',
      ),
    ) as { files: string[] };
    const runtime = manifest.files
      .filter((file) => file.endsWith('.js'))
      .map((file) => file.replace('dist/', ''));
    expect([...CLIENT_MODULES]).toEqual(runtime);
    const ts = await import('typescript');
    const dependencies = async (
      file: string,
    ): Promise<{ statics: string[]; dynamics: string[] }> => {
      const source = await readFile(
        new URL(`../packages/client/dist/${file}`, import.meta.url),
        'utf8',
      );
      const ast = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
      );
      const statics: string[] = [];
      const dynamics: string[] = [];
      const inspect = (node: import('typescript').Node): void => {
        if (
          ts.isImportDeclaration(node) ||
          (ts.isExportDeclaration(node) && node.moduleSpecifier)
        )
          statics.push(node.getText(ast));
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword
        )
          dynamics.push(node.getText(ast));
        ts.forEachChild(node, inspect);
      };
      inspect(ast);
      return { statics, dynamics };
    };
    // The entry has no static dependency and imports only the catalog chunks
    // dynamically, by literal sibling names (no computed specifier).
    const entry = await dependencies('index.js');
    expect(entry.statics).toEqual([]);
    expect(entry.dynamics.sort()).toEqual(
      CLIENT_MODULES.filter((name) => name !== 'index.js')
        .map((name) => `import("./${name}")`)
        .sort(),
    );
    // Each chunk reuses the entry's error class and grammar (one identity) and
    // loads nothing else.
    for (const chunk of CLIENT_MODULES.filter((name) => name !== 'index.js')) {
      const { statics, dynamics } = await dependencies(chunk);
      expect(dynamics, chunk).toEqual([]);
      expect(statics, chunk).toHaveLength(1);
      expect(statics[0], chunk).toMatch(
        /^import\{LiveClientError as \w+(?:,parseIdentifier as \w+)?\}from"\.\/index\.js";$/,
      );
    }
    expect(new Set(CLIENT_MODULES).size).toBe(CLIENT_MODULES.length);
  });
  it('shares one LiveClientError identity between the entry and a loaded chunk', async () => {
    const entry =
      (await import('../packages/client/dist/index.js')) as typeof import('../packages/client/dist/index.js');
    // The chunk has no declarations of its own; it is the bundled sort module.
    const sort = (await import(
      new URL('../packages/client/dist/live-sort.js', import.meta.url).href
    )) as typeof import('../packages/client/dist/sort.js');
    expect(() => sort.parseSortDirective('nv:sort.bogus', '')).toThrow(
      entry.LiveClientError,
    );
  });
});

describe.each(['express', 'fastify'] as const)(
  'installed client assets on %s',
  (platform) => {
    it('serves approved immutable content with native API and host guard coexistence', async () => {
      const { app, assets } = await application(platform);
      expect(() => assets.getManifest()).toThrow('not ready');
      await app.listen(0, '127.0.0.1');
      const manifest = assets.getManifest();
      expect(manifest.version).toMatch(/^[a-f0-9]{64}$/);
      expect(Object.isFrozen(manifest)).toBe(true);
      expect(Object.isFrozen(manifest.files)).toBe(true);
      expect(Object.isFrozen(manifest.entries)).toBe(true);
      expect(Object.keys(manifest.files)).toHaveLength(
        CLIENT_MODULES.length + 2,
      );
      expect(Reflect.set(manifest.entries, 'live', '/changed')).toBe(false);
      const response = await send(app, manifest.entries.live);
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/javascript');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['cache-control']).toBe(
        'public, max-age=31536000, immutable',
      );
      expect(response.headers['etag']).toBe(assetTag(response.body));
      expect(response.body).toBe(
        await readFile(
          new URL('../packages/client/dist/index.js', import.meta.url),
          'utf8',
        ),
      );
      const stored = assets.read(manifest.version, 'index.js');
      expect(Object.isFrozen(stored)).toBe(true);
      expect(assets.read(manifest.version, 'index.js')).toBe(stored);
      const denied = await send(app, manifest.entries.live, {
        'x-assets-test-deny': 'yes',
      });
      expect(denied.status).toBe(403);
      expect(denied.headers['cache-control'] ?? '').not.toContain('immutable');
      expect(JSON.parse((await send(app, '/api/health')).body)).toEqual({
        ok: true,
      });
      expect(app.get(HostGuard).calls).toBeGreaterThanOrEqual(3);
      const head = await send(app, manifest.entries.live, {}, 'HEAD');
      expect(head.status).toBe(200);
      expect(head.body).toBe('');
      expect(head.headers['etag']).toBe(response.headers['etag']);
      expect(head.headers['cache-control']).toBe(
        response.headers['cache-control'],
      );
      expect((await send(app, manifest.entries.live, {}, 'POST')).status).toBe(
        404,
      );
    });
    it('serves every manifest member with original sibling imports and Alpine license notices intact', async () => {
      const { app, assets } = await application(platform);
      await app.listen(0, '127.0.0.1');
      const manifest = assets.getManifest();
      for (const [name, path] of Object.entries(manifest.files)) {
        const response = await send(app, path);
        expect(response.status, name).toBe(200);
        expect(response.body, name).toBe(
          assets.read(manifest.version, name).content,
        );
        expect(response.headers['etag'], name).toBe(assetTag(response.body));
        // SRI digest of the exact bytes on the wire.
        expect(manifest.integrity[path], name).toBe(
          `sha384-${createHash('sha384').update(Buffer.from(response.body, 'utf8')).digest('base64')}`,
        );
      }
      expect(Object.isFrozen(manifest.integrity)).toBe(true);
      expect(Object.keys(manifest.integrity).sort()).toEqual(
        Object.values(manifest.files).sort(),
      );
      // Static and dynamic sibling imports of the entry and every chunk resolve
      // to catalog members under the same content-addressed version.
      for (const name of CLIENT_MODULES) {
        const body = (await send(app, manifest.files[name] ?? '')).body;
        for (const match of body.matchAll(
          /(?:from|import\()\s*['"]\.\/([^'"]+\.js)['"]/g,
        )) {
          const sibling = match[1];
          if (!sibling) throw new Error('Missing sibling import');
          expect(manifest.files[sibling], `${name} → ${sibling}`).toBe(
            new URL(sibling, `http://host${manifest.files[name] ?? ''}`)
              .pathname,
          );
        }
      }
      const require = createRequire(
        new URL('../packages/nestvexa/package.json', import.meta.url),
      );
      const alpineSource = await readFile(
        new URL(
          './module.esm.js',
          pathToFileURL(require.resolve('@alpinejs/csp')),
        ),
        'utf8',
      );
      const alpine = await send(app, manifest.entries.alpine);
      expect(alpine.body).toBe(alpineSource);
      expect(alpine.body).toContain('Bundled license information');
      expect(alpine.body).toContain('@vue/reactivity');
      expect(alpine.body).toContain('@license MIT');
    });
    it('uses weak/list/wildcard validation and never mistakes quoted commas for wildcard tags', async () => {
      const { app, assets } = await application(platform);
      await app.listen(0, '127.0.0.1');
      const path = assets.getManifest().entries.live;
      const initial = await send(app, path);
      const tag = initial.headers['etag'];
      if (typeof tag !== 'string') throw new Error('Missing asset ETag');
      for (const condition of [tag, `W/${tag}`, '*', `"old,tag", W/${tag}`]) {
        const response = await send(app, path, { 'if-none-match': condition });
        expect(response.status, condition).toBe(304);
        expect(response.body).toBe('');
        expect(response.headers['etag']).toBe(tag);
      }
      for (const condition of [
        '"old"',
        '"prefix,*,suffix"',
        `"old", *, ${tag}`,
      ]) {
        const response = await send(app, path, { 'if-none-match': condition });
        expect(response.status, condition).toBe(200);
        expect(response.body).toBe(initial.body);
      }
    });
    it('rejects unknown versions, maps, declarations and encoded filesystem paths without immutable error caching', async () => {
      const { app, assets } = await application(platform);
      await app.listen(0, '127.0.0.1');
      const manifest = assets.getManifest();
      const prefix = `/_nestvexa/assets/${manifest.version}`;
      const targets = [
        '/_nestvexa/assets/old/index.js',
        `${prefix}/missing.js`,
        `${prefix}/index.js.map`,
        `${prefix}/index.d.ts`,
        `${prefix}/package.json`,
        `${prefix}/constructor`,
        `${prefix}/__proto__`,
        `${prefix}/%2e%2e%2fpackage.json`,
        `${prefix}/..%5cpackage.json`,
        `${prefix}/%2fetc%2fpasswd`,
        `${prefix}/C%3a%5cWindows%5cwin.ini`,
      ];
      for (const path of targets) {
        const response = await send(app, path, { 'if-none-match': '*' });
        expect(response.status, path).toBe(404);
        expect(response.headers['cache-control'], path).toBe('no-store');
        expect(response.body, path).not.toContain('node_modules');
        expect(response.body, path).not.toContain('ENOENT');
      }
      expect(() => assets.read(manifest.version, '../package.json')).toThrow(
        'not found',
      );
    });
    it.each(['uri', 'header'] as const)(
      'keeps assets version neutral with a global prefix and %s API versioning',
      async (versioning) => {
        const { app, assets } = await application(
          platform,
          { path: '/ui/client', basePath: '/host' },
          versioning,
        );
        await app.listen(0, '127.0.0.1');
        const manifest = assets.getManifest();
        expect(manifest.entries.live).toBe(
          `/host/ui/client/${manifest.version}/index.js`,
        );
        expect((await send(app, manifest.entries.live)).status).toBe(200);
        expect((await send(app, manifest.entries.alpine)).status).toBe(200);
        expect(
          (await send(app, `/ui/client/${manifest.version}/index.js`)).status,
        ).toBe(404);
        const apiPath =
          versioning === 'uri' ? '/host/v1/api/health' : '/host/api/health';
        const headers = versioning === 'header' ? { 'X-API-Version': '1' } : {};
        expect(JSON.parse((await send(app, apiPath, headers)).body)).toEqual({
          ok: true,
        });
        if (versioning === 'header')
          expect((await send(app, apiPath)).status).toBe(404);
        if (versioning === 'uri')
          expect((await send(app, '/host/api/health')).status).toBe(404);
      },
    );
    it('isolates application shutdown and rejects closed service access', async () => {
      const first = await application(platform);
      const second = await application(platform);
      await Promise.all([
        first.app.listen(0, '127.0.0.1'),
        second.app.listen(0, '127.0.0.1'),
      ]);
      const firstManifest = first.assets.getManifest();
      const secondManifest = second.assets.getManifest();
      expect(first.assets).not.toBe(second.assets);
      expect(firstManifest).not.toBe(secondManifest);
      expect(firstManifest.version).toBe(secondManifest.version);
      await first.app.close();
      apps.delete(first.app);
      expect(() => first.assets.getManifest()).toThrow('not ready');
      expect(() =>
        first.assets.read(firstManifest.version, 'index.js'),
      ).toThrow('not ready');
      await expect(first.assets.onModuleInit()).rejects.toThrow('shut down');
      expect((await send(second.app, secondManifest.entries.live)).status).toBe(
        200,
      );
    });
  },
);

describe('single asset owner per application', () => {
  it.each([
    [{}, {}],
    [{ path: '/assets' }, { path: '/other-assets' }],
    [{ basePath: '/first' }, { basePath: '/second' }],
  ] as const)(
    'rejects competing registrations %# before accepting traffic',
    async (first, second) => {
      await expect(
        Test.createTestingModule({
          imports: [first, second].map((entry) =>
            NestvexaAssetsModule.register(entry),
          ),
        }).compile(),
      ).rejects.toThrow('once per application');
    },
  );
});
