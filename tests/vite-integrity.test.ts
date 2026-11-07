/**
 * Subresource Integrity for Vite manifest tags (CORE-045): hashes computed
 * from the built files when the manifest is read, `integrity` plus
 * `crossorigin` on scripts, preloads and stylesheets, and a real Chromium
 * refusing a tampered asset.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  ViteAssets,
  ViteConfigurationError,
  renderAssetTags,
  subresourceIntegrity,
  verifySubresourceIntegrity,
} from '../packages/vite/dist/index.js';

// The entry imports the preloaded chunk, so both integrity checks matter.
const entry =
  "import './shared-XyZ98765.js';\nwindow.__app = window.__shared + 1;\n";
const shared = 'window.__shared = 41;\n';
const style = 'body { margin: 0 }\n';
let outDir: string;

async function build(directory: string): Promise<void> {
  await mkdir(join(directory, '.vite'), { recursive: true });
  await mkdir(join(directory, 'assets'), { recursive: true });
  await writeFile(join(directory, 'assets', 'app-AbCdEf12.js'), entry);
  await writeFile(join(directory, 'assets', 'shared-XyZ98765.js'), shared);
  await writeFile(join(directory, 'assets', 'app-Q1w2E3r4.css'), style);
  await writeFile(
    join(directory, '.vite', 'manifest.json'),
    JSON.stringify({
      'client/app.ts': {
        file: 'assets/app-AbCdEf12.js',
        src: 'client/app.ts',
        isEntry: true,
        imports: ['_shared.js'],
        css: ['assets/app-Q1w2E3r4.css'],
      },
      '_shared.js': { file: 'assets/shared-XyZ98765.js' },
    }),
  );
}
const sha = (algorithm: string, text: string) =>
  `${algorithm}-${createHash(algorithm).update(text).digest('base64')}`;

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'nestvexa-sri-'));
  await build(outDir);
});
afterAll(async () => {
  if (dirname(resolve(outDir)) !== resolve(tmpdir()))
    throw new Error('Unsafe cleanup');
  await rm(outDir, { recursive: true, force: true });
});

describe('integrity metadata', () => {
  it('hashes exact bytes and verifies like a browser', () => {
    const integrity = subresourceIntegrity(entry);
    expect(integrity).toBe(sha('sha384', entry));
    expect(subresourceIntegrity(entry, 'sha512')).toBe(sha('sha512', entry));
    expect(verifySubresourceIntegrity(entry, integrity)).toBe(true);
    expect(verifySubresourceIntegrity(Buffer.from(entry), integrity)).toBe(
      true,
    );
    // Tampering by a single byte fails.
    expect(verifySubresourceIntegrity(`${entry} `, integrity)).toBe(false);
    expect(verifySubresourceIntegrity(entry.replace('1', '2'), integrity)).toBe(
      false,
    );
    // Only the strongest algorithm counts; malformed metadata fails closed.
    expect(
      verifySubresourceIntegrity(
        entry,
        `${sha('sha256', entry)} ${sha('sha512', 'other')}`,
      ),
    ).toBe(false);
    expect(
      verifySubresourceIntegrity(
        entry,
        `${sha('sha256', 'other')} ${sha('sha384', entry)}`,
      ),
    ).toBe(true);
    expect(verifySubresourceIntegrity(entry, 'md5-abc')).toBe(false);
    expect(verifySubresourceIntegrity(entry, '')).toBe(false);
  });
});

describe('ViteAssets integrity', () => {
  it('adds integrity and crossorigin to every production tag', () => {
    const assets = new ViteAssets({
      apps: {
        web: {
          entries: ['client/app.ts'],
          manifest: join(outDir, '.vite', 'manifest.json'),
          integrity: true,
        },
      },
    });
    expect(assets.entry('web').integrity).toEqual({
      '/assets/app-AbCdEf12.js': sha('sha384', entry),
      '/assets/shared-XyZ98765.js': sha('sha384', shared),
      '/assets/app-Q1w2E3r4.css': sha('sha384', style),
    });
    expect(assets.tags('web', { nonce: 'bm9uY2UtdmFsdWUtMDEyMzQ1Njc=' })).toBe(
      [
        '<meta property="csp-nonce" nonce="bm9uY2UtdmFsdWUtMDEyMzQ1Njc=">',
        `<link rel="stylesheet" href="/assets/app-Q1w2E3r4.css" crossorigin="anonymous" integrity="${sha('sha384', style)}">`,
        `<link rel="modulepreload" href="/assets/shared-XyZ98765.js" crossorigin="anonymous" integrity="${sha('sha384', shared)}" nonce="bm9uY2UtdmFsdWUtMDEyMzQ1Njc=">`,
        `<script type="module" src="/assets/app-AbCdEf12.js" crossorigin="anonymous" integrity="${sha('sha384', entry)}" nonce="bm9uY2UtdmFsdWUtMDEyMzQ1Njc="></script>`,
      ].join(''),
    );
  });

  it('honors the algorithm, a CDN base and an explicit crossorigin', () => {
    const assets = new ViteAssets({
      apps: {
        web: {
          entries: ['client/app.ts'],
          manifest: join(outDir, '.vite', 'manifest.json'),
          base: 'https://cdn.example/app/',
          crossOrigin: 'use-credentials',
          integrity: 'sha512',
        },
      },
    });
    const tags = assets.tags('web');
    expect(tags).toContain(
      `src="https://cdn.example/app/assets/app-AbCdEf12.js" crossorigin="use-credentials" integrity="${sha('sha512', entry)}"`,
    );
  });

  it('keeps tags unchanged without integrity and in development', () => {
    const plain = new ViteAssets({
      apps: {
        web: {
          entries: ['client/app.ts'],
          manifest: join(outDir, '.vite', 'manifest.json'),
        },
      },
    });
    expect(plain.entry('web').integrity).toBeUndefined();
    expect(plain.tags('web')).not.toContain('integrity');
    const dev = new ViteAssets({
      mode: 'development',
      apps: { web: { entries: ['client/app.ts'], integrity: true } },
    });
    expect(dev.tags('web')).not.toContain('integrity');
    expect(
      renderAssetTags({ scripts: ['/a.js'], styles: [], preloads: [] }),
    ).toBe('<script type="module" src="/a.js"></script>');
  });

  it('fails at startup for missing files, unknown algorithms or no outDir', async () => {
    const broken = await mkdtemp(join(tmpdir(), 'nestvexa-sri-broken-'));
    try {
      await build(broken);
      await rm(join(broken, 'assets', 'shared-XyZ98765.js'));
      const options = (app: Record<string, unknown>) => ({
        apps: {
          web: {
            entries: ['client/app.ts'],
            manifest: join(broken, '.vite', 'manifest.json'),
            ...app,
          },
        },
      });
      expect(() => new ViteAssets(options({ integrity: true }))).toThrow(
        /shared-XyZ98765\.js is missing/,
      );
      expect(
        () =>
          new ViteAssets(
            options({ integrity: 'md5' }) as unknown as ConstructorParameters<
              typeof ViteAssets
            >[0],
          ),
      ).toThrow(ViteConfigurationError);
      await writeFile(
        join(broken, 'manifest.json'),
        await readFile(join(broken, '.vite', 'manifest.json')),
      );
      expect(
        () =>
          new ViteAssets({
            apps: {
              web: {
                entries: ['client/app.ts'],
                manifest: join(broken, 'manifest.json'),
                integrity: true,
              },
            },
          }),
      ).toThrow(/needs outDir/);
      expect(
        () =>
          new ViteAssets({
            apps: {
              web: {
                entries: ['client/app.ts'],
                manifest: join(broken, 'manifest.json'),
                integrity: true,
                outDir: 'relative/dir',
              },
            },
          }),
      ).toThrow(/absolute/);
    } finally {
      await rm(broken, { recursive: true, force: true });
    }
  });
});

describe('a browser refuses tampered assets', () => {
  let browser: Browser;
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const assets = new ViteAssets({
      apps: {
        web: {
          entries: ['client/app.ts'],
          manifest: join(outDir, '.vite', 'manifest.json'),
          integrity: true,
        },
      },
    });
    // Tags are computed once at startup; files are read per request, so a
    // file changed afterwards models a tampered CDN or proxy copy.
    const head = assets.tags('web');
    server = createServer((request, response) => {
      void (async () => {
        if (request.url === '/') {
          response.setHeader('content-type', 'text/html; charset=utf-8');
          response.end(
            `<!doctype html><html><head><meta charset="utf-8"><title>SRI</title>${head}</head><body></body></html>`,
          );
          return;
        }
        const name = (request.url ?? '').replace(/^\/assets\//, '');
        if (!/^[A-Za-z0-9-]+\.(?:js|css)$/.test(name)) {
          response.statusCode = 404;
          response.end();
          return;
        }
        response.setHeader(
          'content-type',
          name.endsWith('.css')
            ? 'text/css; charset=utf-8'
            : 'text/javascript; charset=utf-8',
        );
        response.end(await readFile(join(outDir, 'assets', name)));
      })();
    });
    await new Promise<void>((done) => server.listen(3843, '127.0.0.1', done));
    base = 'http://127.0.0.1:3843';
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => server.close(() => done()));
  });

  it(
    'runs intact assets and blocks a tampered entry',
    { timeout: 60_000 },
    async () => {
      const page = await browser.newPage();
      try {
        await page.goto(`${base}/`);
        await page.waitForFunction(() => Reflect.get(window, '__app') === 42);
        // Tamper with the built entry after the tags were rendered.
        await writeFile(
          join(outDir, 'assets', 'app-AbCdEf12.js'),
          "window.__app = 'tampered';\n",
        );
        const errors: string[] = [];
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(message.text());
        });
        await page.reload();
        await expect
          .poll(() => errors.some((text) => /integrity/i.test(text)))
          .toBe(true);
        expect(await page.evaluate(() => Reflect.get(window, '__app'))).toBe(
          undefined,
        );
      } finally {
        await writeFile(join(outDir, 'assets', 'app-AbCdEf12.js'), entry);
        await page.close();
      }
    },
  );
});
