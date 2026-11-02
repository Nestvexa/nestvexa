import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ViteAssets,
  ViteConfigurationError,
  cspNonce,
  cspNonceMiddleware,
  defaultCspDirectives,
  normalizeBase,
  parseViteManifest,
  renderAssetTags,
  resolveEntryAssets,
  viteInertiaRootView,
} from '../packages/vite/dist/index.js';
import {
  PageNotFoundError,
  PageRegistryError,
  createPageRegistry,
  isPageName,
} from '../packages/vite/dist/pages.js';

// Shape produced by `vite build` with build.manifest (Vite 8.3.5): entry with a
// shared static import, CSS on both, and a code-split dynamic page.
const manifestJson = {
  'client/app.tsx': {
    file: 'assets/app-B9xk2Q_a.js',
    name: 'app',
    src: 'client/app.tsx',
    isEntry: true,
    imports: ['_vendor-C1a2b3c4.js'],
    dynamicImports: ['client/pages/Home.tsx'],
    css: ['assets/app-D4e5f6g7.css'],
  },
  '_vendor-C1a2b3c4.js': {
    file: 'assets/vendor-C1a2b3c4.js',
    name: 'vendor',
    css: ['assets/vendor-H8i9j0k1.css'],
  },
  'client/pages/Home.tsx': {
    file: 'assets/Home-L2m3n4o5.js',
    name: 'Home',
    src: 'client/pages/Home.tsx',
    isDynamicEntry: true,
    imports: ['_vendor-C1a2b3c4.js'],
  },
  'client/admin.ts': {
    file: 'assets/admin-P6q7r8s9.js',
    src: 'client/admin.ts',
    isEntry: true,
    imports: ['_vendor-C1a2b3c4.js'],
  },
};

describe('Vite manifest parsing', () => {
  it('accepts a real manifest shape and freezes chunk records', () => {
    const manifest = parseViteManifest(JSON.stringify(manifestJson));
    expect(manifest.size).toBe(4);
    expect(manifest.get('client/app.tsx')?.isEntry).toBe(true);
    expect(Object.isFrozen(manifest.get('client/app.tsx'))).toBe(true);
  });

  it.each([
    ['traversal file', { a: { file: '../secret.js' } }],
    ['absolute file', { a: { file: '/etc/passwd' } }],
    ['scheme file', { a: { file: 'javascript:alert(1)' } }],
    ['backslash file', { a: { file: 'assets\\app.js' } }],
    ['query in file', { a: { file: 'assets/app.js?x=1' } }],
    ['quote in file', { a: { file: 'assets/a".js' } }],
    ['unsafe css', { a: { file: 'a.js', css: ['../x.css'] } }],
    ['unknown import', { a: { file: 'a.js', imports: ['missing'] } }],
    ['non-string imports', { a: { file: 'a.js', imports: [1] } }],
    ['array root', []],
    ['chunk not object', { a: 'x' }],
  ])('rejects %s', (_label, value) => {
    expect(() => parseViteManifest(value)).toThrow(ViteConfigurationError);
  });

  it('rejects invalid JSON with a clear error', () => {
    expect(() => parseViteManifest('{not json')).toThrow(/not valid JSON/);
  });
});

describe('entry asset resolution', () => {
  const manifest = parseViteManifest(manifestJson);

  it('collects the entry script, static-import preloads and all CSS', () => {
    expect(resolveEntryAssets(manifest, ['client/app.tsx'], '/build/')).toEqual(
      {
        scripts: ['/build/assets/app-B9xk2Q_a.js'],
        preloads: ['/build/assets/vendor-C1a2b3c4.js'],
        styles: [
          '/build/assets/vendor-H8i9j0k1.css',
          '/build/assets/app-D4e5f6g7.css',
        ],
      },
    );
  });

  it('never preloads dynamic imports (code-split pages load on demand)', () => {
    const assets = resolveEntryAssets(manifest, ['client/app.tsx']);
    expect(assets.preloads.join()).not.toContain('Home');
  });

  it('deduplicates shared chunks across several entries', () => {
    const assets = resolveEntryAssets(manifest, [
      'client/app.tsx',
      'client/admin.ts',
    ]);
    expect(assets.scripts).toEqual([
      '/assets/app-B9xk2Q_a.js',
      '/assets/admin-P6q7r8s9.js',
    ]);
    expect(assets.preloads).toEqual(['/assets/vendor-C1a2b3c4.js']);
  });

  it('supports an absolute CDN base', () => {
    const assets = resolveEntryAssets(
      manifest,
      ['client/app.tsx'],
      'https://cdn.example.test/app/',
    );
    expect(assets.scripts[0]).toBe(
      'https://cdn.example.test/app/assets/app-B9xk2Q_a.js',
    );
  });

  it('fails for missing and non-entry chunks', () => {
    expect(() => resolveEntryAssets(manifest, ['client/nope.ts'])).toThrow(
      /no entry client\/nope\.ts/,
    );
    expect(() =>
      resolveEntryAssets(manifest, ['client/pages/Home.tsx']),
    ).toThrow(/not a Vite build entry/);
  });

  it.each([
    '//evil.test/',
    'javascript:alert(1)/',
    '/build',
    '/build/?x=/',
    'ftp://cdn.test/',
    'https://user:pw@cdn.test/',
  ])('rejects unsafe base %s', (base) => {
    expect(() => normalizeBase(base)).toThrow(ViteConfigurationError);
  });
});

describe('asset tags', () => {
  const assets = {
    scripts: ['/build/assets/app.js'],
    styles: ['/build/assets/app.css'],
    preloads: ['https://cdn.test/a&b/vendor.js'],
  };

  it('renders nonce-bound module tags, preloads and the csp-nonce meta', () => {
    expect(renderAssetTags(assets, { nonce: 'abcDEF123+/=' })).toBe(
      '<meta property="csp-nonce" nonce="abcDEF123+/=">' +
        '<link rel="stylesheet" href="/build/assets/app.css">' +
        '<link rel="modulepreload" href="https://cdn.test/a&amp;b/vendor.js" nonce="abcDEF123+/=">' +
        '<script type="module" src="/build/assets/app.js" nonce="abcDEF123+/="></script>',
    );
  });

  it('omits nonce attributes without a nonce and adds crossorigin when asked', () => {
    const html = renderAssetTags(assets, { crossOrigin: 'anonymous' });
    expect(html).not.toContain('nonce');
    expect(html).toContain('crossorigin="anonymous"');
  });

  it.each(['"><script>alert(1)</script>', 'short', 'has space here', ''])(
    'rejects invalid nonce %j',
    (nonce) => {
      expect(() => renderAssetTags(assets, { nonce })).toThrow(
        ViteConfigurationError,
      );
    },
  );
});

describe('ViteAssets', () => {
  let directory: string;
  let manifestPath: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nestvexa-vite-assets-'));
    manifestPath = join(directory, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifestJson));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('resolves per-app tags with a per-request nonce and a content version', () => {
    const assets = new ViteAssets({
      apps: {
        react: {
          entries: ['client/app.tsx'],
          manifest: manifestPath,
          base: '/build/react/',
        },
        admin: {
          entries: ['client/admin.ts'],
          manifest: manifestPath,
          base: '/build/admin/',
        },
      },
    });
    expect(assets.apps).toEqual(['react', 'admin']);
    expect(assets.tags('react', { nonce: 'n0nce-value' })).toContain(
      '<script type="module" src="/build/react/assets/app-B9xk2Q_a.js" nonce="n0nce-value"></script>',
    );
    expect(assets.entry('admin').scripts).toEqual([
      '/build/admin/assets/admin-P6q7r8s9.js',
    ]);
    expect(assets.version('react')).toMatch(/^[0-9a-f]{16}$/);
    expect(assets.version('react')).toBe(assets.version('admin'));
    expect(assets.manifestPath('react')).toBe(manifestPath);
    expect(() => assets.tags('vue')).toThrow(/Unknown Vite app "vue"/);
  });

  it('changes the version when the manifest content changes', async () => {
    const other = join(directory, 'other.json');
    await writeFile(
      other,
      JSON.stringify({ ...manifestJson, 'x.ts': { file: 'assets/x.js' } }),
    );
    const first = new ViteAssets({
      apps: { a: { entries: ['client/app.tsx'], manifest: manifestPath } },
    });
    const second = new ViteAssets({
      apps: { a: { entries: ['client/app.tsx'], manifest: other } },
    });
    expect(first.version('a')).not.toBe(second.version('a'));
  });

  it('fails fast at startup when the build has not run', () => {
    expect(
      () =>
        new ViteAssets({
          apps: {
            a: {
              entries: ['client/app.tsx'],
              manifest: join(directory, 'missing.json'),
            },
          },
        }),
    ).toThrow(/Vite manifest not found .*run `vite build`/);
    expect(
      () => new ViteAssets({ apps: { a: { entries: ['client/app.tsx'] } } }),
    ).toThrow(/needs a manifest path/);
  });

  it('emits dev-server URLs in development without reading a manifest', () => {
    const assets = new ViteAssets({
      mode: 'development',
      devOrigin: 'http://localhost:5173/ignored',
      apps: { app: { entries: ['client/app.tsx'], base: '/build/' } },
    });
    expect(assets.entry('app').scripts).toEqual([
      'http://localhost:5173/build/@vite/client',
      'http://localhost:5173/build/client/app.tsx',
    ]);
    expect(assets.version('app')).toBe('dev');
  });

  it.each([
    [{ apps: {} }, /at least one app/],
    [{ apps: { 'bad key': { entries: ['a.ts'] } } }, /Invalid Vite app key/],
    [{ apps: { a: { entries: ['../a.ts'] } } }, /safe relative entries/],
    [{ apps: { a: { entries: [] } } }, /safe relative entries/],
    [{ mode: 'staging', apps: { a: { entries: ['a.ts'] } } }, /mode must be/],
    [
      {
        mode: 'development',
        devOrigin: 'ftp://x',
        apps: { a: { entries: ['a.ts'] } },
      },
      /devOrigin/,
    ],
  ])('rejects invalid options %#', (options, message) => {
    expect(
      () =>
        new ViteAssets(options as ConstructorParameters<typeof ViteAssets>[0]),
    ).toThrow(message);
  });
});

describe('Inertia root view', () => {
  const assets = new ViteAssets({
    mode: 'development',
    apps: { react: { entries: ['client/app.tsx'] } },
  });
  const context = {
    app: 'react',
    title: '<Users> & "friends"',
    head: '',
    body: '<script data-page="app" type="application/json">{}</script><div id="app"></div>',
    nonce: 'abcdefgh12345678',
  };

  it('prints escaped title, nonce-bound tags, head and body', () => {
    const html = viteInertiaRootView(assets)(context);
    expect(html).toMatch(/^<!doctype html><html lang="en">/);
    expect(html).toContain(
      '<title>&lt;Users&gt; &amp; &quot;friends&quot;</title>',
    );
    expect(html).toContain(
      '<script type="module" src="/client/app.tsx" nonce="abcdefgh12345678"></script>',
    );
    expect(html).toContain(`<body>${context.body}</body>`);
  });

  it('does not duplicate the title when the SSR head carries one', () => {
    const html = viteInertiaRootView(assets, { lang: 'ar-EG' })({
      ...context,
      head: '<title data-inertia="">From SSR</title>',
    });
    expect(html.match(/<title/g)).toHaveLength(1);
    expect(html).toContain('<html lang="ar-EG">');
  });

  it('maps Inertia app keys to Vite apps and validates the language', () => {
    expect(
      viteInertiaRootView(assets, { app: () => 'react' })({
        ...context,
        app: 'default',
      }),
    ).toContain('/client/app.tsx');
    expect(() => viteInertiaRootView(assets, { lang: 'en"><x' })).toThrow();
  });
});

describe('CSP nonce middleware', () => {
  it('generates a fresh nonce per request, sets the header and exposes it', () => {
    const middleware = cspNonceMiddleware();
    const seen: string[] = [];
    for (let index = 0; index < 3; index++) {
      const request = {};
      const headers: Record<string, string> = {};
      let called = false;
      middleware(
        request as never,
        {
          setHeader: (name: string, value: string) => (headers[name] = value),
        } as never,
        () => (called = true),
      );
      const nonce = cspNonce(request);
      expect(called).toBe(true);
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      expect(headers['Content-Security-Policy']).toBe(
        defaultCspDirectives(nonce ?? ''),
      );
      // Fastify wraps the raw Node request in `request.raw`.
      expect(cspNonce({ raw: request })).toBe(nonce);
      seen.push(nonce ?? '');
    }
    expect(new Set(seen).size).toBe(3);
    expect(cspNonce({})).toBeUndefined();
  });

  it('supports report-only rollout and custom directives', () => {
    const headers: Record<string, string> = {};
    cspNonceMiddleware({
      reportOnly: true,
      directives: (nonce) => `script-src 'nonce-${nonce}'`,
    })(
      {} as never,
      {
        setHeader: (name: string, value: string) => (headers[name] = value),
      } as never,
      () => undefined,
    );
    expect(Object.keys(headers)).toEqual([
      'Content-Security-Policy-Report-Only',
    ]);
    expect(() => cspNonceMiddleware({ bytes: 8 })).toThrow();
  });

  it('default policy forbids inline script and plugins and allows strict-dynamic chunks', () => {
    const policy = defaultCspDirectives('N');
    expect(policy).toContain("script-src 'nonce-N' 'strict-dynamic'");
    expect(policy).not.toContain('unsafe-inline');
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'none'");
  });
});

describe('page registry', () => {
  const Home = { default: 'Home component' };
  const loaders = {
    './pages/Home.tsx': async () => Home,
    './pages/Users/Index.tsx': async () => ({ default: 'Users' }),
  };

  it('maps explicit glob keys to component names and loads lazily', async () => {
    const registry = createPageRegistry(loaders, {
      base: './pages/',
      extensions: ['.tsx'],
    });
    expect(registry.names).toEqual(['Home', 'Users/Index']);
    expect(registry.has('Users/Index')).toBe(true);
    await expect(registry.load('Home')).resolves.toBe(Home);
  });

  it('accepts eager globs', async () => {
    const registry = createPageRegistry(
      { './pages/Home.vue': Home },
      { base: './pages/' },
    );
    await expect(registry.load('Home')).resolves.toBe(Home);
  });

  it.each([
    'Missing',
    '../Home',
    './pages/Home.tsx',
    'Home.tsx',
    '__proto__',
    'constructor',
    'toString',
    'Users//Index',
    '/Home',
    'x'.repeat(201),
  ])('never resolves %j', async (name) => {
    const registry = createPageRegistry(loaders, { base: './pages/' });
    expect(registry.has(name)).toBe(false);
    await expect(registry.load(name)).rejects.toBeInstanceOf(PageNotFoundError);
  });

  it('rejects registries outside the base, with odd names or duplicates', () => {
    expect(() =>
      createPageRegistry({ './other/Home.tsx': Home }, { base: './pages/' }),
    ).toThrow(PageRegistryError);
    expect(() =>
      createPageRegistry({ './pages/My Page.tsx': Home }, { base: './pages/' }),
    ).toThrow(PageRegistryError);
    expect(() =>
      createPageRegistry(
        { './pages/Home.tsx': Home, './pages/Home.jsx': Home },
        { base: './pages/' },
      ),
    ).toThrow(/Duplicate page name Home/);
    expect(() =>
      createPageRegistry(
        { './pages/Home.ts': Home },
        {
          base: './pages/',
          extensions: ['.tsx'],
        },
      ),
    ).toThrow(PageRegistryError);
    expect(() => createPageRegistry(loaders, { base: './pages' })).toThrow();
  });

  it('validates component names', () => {
    expect(isPageName('Users/Index')).toBe(true);
    expect(isPageName('a-b_c/D9')).toBe(true);
    expect(isPageName('a/../b')).toBe(false);
    expect(isPageName(42)).toBe(false);
  });
});
