/**
 * EXT-006: opt-in `103 Early Hints` for content-hashed assets. The Link
 * values are validated (no header or Link-grammar injection), hints are
 * written only for HTTP/1.1+ GET/HEAD requests before the final headers, and
 * real Express and Fastify Nest hosts deliver them ahead of the page.
 */
import 'reflect-metadata';
import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { request as httpRequest, createServer } from 'node:http';
import type { IncomingHttpHeaders, Server, ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  formatEarlyHint,
  sendEarlyHints,
} from '../packages/core/dist/index.js';
import type { EarlyHint } from '../packages/core/dist/index.js';
import {
  LiveComponent,
  NestvexaBrowserService,
  NestvexaModule,
  State,
  configureNestvexa,
} from '../packages/nestvexa/dist/index.js';
import { ViteAssets, assetEarlyHints } from '../packages/vite/dist/index.js';

const hints: readonly EarlyHint[] = [
  { href: '/assets/app-AbCdEf12.js', rel: 'modulepreload' },
  { href: '/assets/app-Q1w2E3r4.css', rel: 'preload', as: 'style' },
];
const expectedLinks = [
  '</assets/app-AbCdEf12.js>; rel=modulepreload',
  '</assets/app-Q1w2E3r4.css>; rel=preload; as=style',
];

interface Received {
  readonly informational: { status: number; headers: IncomingHttpHeaders }[];
  readonly status: number;
  readonly body: string;
}
function get(port: number, path: string, method = 'GET'): Promise<Received> {
  return new Promise((done, fail) => {
    const informational: Received['informational'] = [];
    const request = httpRequest(
      { host: '127.0.0.1', port, path, method },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (body += chunk));
        response.on('end', () =>
          done({ informational, status: response.statusCode ?? 0, body }),
        );
      },
    );
    request.on('information', (info) =>
      informational.push({ status: info.statusCode, headers: info.headers }),
    );
    request.on('error', fail);
    request.end();
  });
}
/** Raw HTTP/1.0 exchange: 1xx responses must never reach such clients. */
function http10(port: number): Promise<string> {
  return new Promise((done, fail) => {
    const socket = connect(port, '127.0.0.1', () =>
      socket.write('GET / HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n'),
    );
    let text = '';
    socket.setEncoding('latin1');
    socket.on('data', (chunk: string) => (text += chunk));
    socket.on('end', () => done(text));
    socket.on('error', fail);
  });
}
function listen(server: Server, port: number): Promise<void> {
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => done());
  });
}
function close(server: Server): Promise<void> {
  return new Promise((done) => server.close(() => done()));
}

describe('formatEarlyHint', () => {
  it('serializes modulepreload, preload and preconnect links', () => {
    expect(hints.map(formatEarlyHint)).toEqual(expectedLinks);
    expect(
      formatEarlyHint({
        href: 'https://cdn.example.com/assets/app-1.js',
        rel: 'modulepreload',
        crossOrigin: 'anonymous',
      }),
    ).toBe(
      '<https://cdn.example.com/assets/app-1.js>; rel=modulepreload; crossorigin',
    );
    expect(
      formatEarlyHint({
        href: '/fonts/a.woff2',
        rel: 'preload',
        as: 'font',
        crossOrigin: 'use-credentials',
      }),
    ).toBe(
      '</fonts/a.woff2>; rel=preload; as=font; crossorigin=use-credentials',
    );
    expect(
      formatEarlyHint({ href: 'https://cdn.example.com', rel: 'preconnect' }),
    ).toBe('<https://cdn.example.com>; rel=preconnect');
  });

  it('refuses header and Link-grammar injection and unsafe URLs', () => {
    const unsafe: EarlyHint[] = [
      { href: '/a.js\r\nSet-Cookie: x=1', rel: 'modulepreload' },
      { href: '/a.js\n', rel: 'modulepreload' },
      { href: '/a.js>; rel=stylesheet', rel: 'modulepreload' },
      { href: '/a.js; rel=prefetch', rel: 'modulepreload' },
      { href: '/a.js, </evil.js>', rel: 'modulepreload' },
      { href: '/a b.js', rel: 'modulepreload' },
      { href: '/"a.js', rel: 'modulepreload' },
      { href: '//evil.example/a.js', rel: 'modulepreload' },
      { href: 'http://cdn.example.com/a.js', rel: 'modulepreload' },
      { href: 'javascript:alert(1)', rel: 'modulepreload' },
      { href: 'assets/a.js', rel: 'modulepreload' },
      { href: '', rel: 'modulepreload' },
      { href: '/a.js', rel: 'stylesheet' as never },
      { href: '/a.css', rel: 'preload' },
      { href: '/a.css', rel: 'preload', as: 'document' as never },
      { href: 'https://cdn.example.com', rel: 'preconnect', as: 'script' },
      { href: '/a.js', rel: 'modulepreload', crossOrigin: 'evil' as never },
    ];
    for (const hint of unsafe) expect(() => formatEarlyHint(hint)).toThrow();
  });
});

describe('sendEarlyHints on a Node server', () => {
  const port = 4240;
  let server: Server;
  let sent: boolean[] = [];
  let mode: 'normal' | 'late' | 'invalid' = 'normal';
  beforeAll(async () => {
    server = createServer((request, response: ServerResponse) => {
      if (mode === 'late') {
        response.writeHead(200, { 'content-type': 'text/html' });
        sent.push(sendEarlyHints(response, hints));
      } else if (mode === 'invalid') {
        try {
          sendEarlyHints(response, [
            { href: '/a.js\r\nX-Evil: 1', rel: 'modulepreload' },
          ]);
        } catch {
          sent.push(false);
        }
      } else sent.push(sendEarlyHints(response, hints));
      response.end(request.method === 'HEAD' ? undefined : '<p>page</p>');
    });
    await listen(server, port);
  });
  afterAll(() => close(server));
  afterEach(() => {
    sent = [];
    mode = 'normal';
  });

  it('writes one 103 with every link before the final response', async () => {
    const received = await get(port, '/');
    expect(sent).toEqual([true]);
    expect(received.status).toBe(200);
    expect(received.body).toBe('<p>page</p>');
    expect(received.informational).toHaveLength(1);
    expect(received.informational[0]?.status).toBe(103);
    expect(received.informational[0]?.headers['link']).toBe(
      expectedLinks.join(', '),
    );
  });

  it('sends hints for HEAD, but not for other methods', async () => {
    expect((await get(port, '/', 'HEAD')).informational).toHaveLength(1);
    const posted = await get(port, '/', 'POST');
    expect(posted.informational).toHaveLength(0);
    expect(sent).toEqual([true, false]);
  });

  it('never sends a 1xx to an HTTP/1.0 client', async () => {
    const raw = await http10(port);
    expect(raw.startsWith('HTTP/1.1 200')).toBe(true);
    expect(raw).not.toContain('103');
    expect(sent).toEqual([false]);
  });

  it('does nothing after the final headers were sent', async () => {
    mode = 'late';
    const received = await get(port, '/');
    expect(received.informational).toHaveLength(0);
    expect(sent).toEqual([false]);
  });

  it('refuses an injected link before anything is written', async () => {
    mode = 'invalid';
    const received = await get(port, '/');
    expect(received.informational).toHaveLength(0);
    expect(received.status).toBe(200);
    expect(sent).toEqual([false]);
  });

  it('ignores targets without a Node response and empty hint lists', () => {
    expect(sendEarlyHints({}, hints)).toBe(false);
    expect(sendEarlyHints(null, hints)).toBe(false);
    expect(() =>
      sendEarlyHints(
        {},
        Array.from({ length: 33 }, (_, index) => ({
          href: `/a${index}.js`,
          rel: 'modulepreload' as const,
        })),
      ),
    ).toThrow(/more than 32/);
    expect(() => sendEarlyHints({}, 'x' as never)).toThrow();
  });
});

@Controller()
class HintedPages {
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  page(@Res({ passthrough: true }) response: unknown): string {
    sendEarlyHints(response, hints);
    return '<p>page</p>';
  }
  @Get('plain')
  plain(): string {
    return 'no hints';
  }
}

describe.each([
  ['express', 4241],
  ['fastify', 4242],
] as const)('Nest %s host', (platform, port) => {
  let app: INestApplication;
  beforeAll(async () => {
    app =
      platform === 'fastify'
        ? await NestFactory.create(
            {
              module: class HintedModule {},
              controllers: [HintedPages],
            },
            new FastifyAdapter(),
            { logger: false },
          )
        : await NestFactory.create(
            { module: class HintedModule {}, controllers: [HintedPages] },
            { logger: false },
          );
    await app.listen(port, '127.0.0.1');
  });
  afterAll(() => app.close());

  it('delivers 103 Early Hints before the rendered page', async () => {
    const received = await get(port, '/');
    expect(received.status).toBe(200);
    expect(received.body).toBe('<p>page</p>');
    expect(received.informational.map((info) => info.status)).toEqual([103]);
    expect(received.informational[0]?.headers['link']).toBe(
      expectedLinks.join(', '),
    );
  });

  it('is opt-in: routes that do not call it send no informational response', async () => {
    const received = await get(port, '/plain');
    expect(received.body).toBe('no hints');
    expect(received.informational).toHaveLength(0);
  });
});

@LiveComponent({ name: 'hints-probe', view: 'hints-probe' })
class HintsProbe {
  @State() ready = true;
}
@Controller()
class UmbrellaPages {
  constructor(
    @Inject(NestvexaBrowserService)
    private readonly browser: NestvexaBrowserService,
  ) {}
  @Get('page')
  @Header('Content-Type', 'text/html; charset=utf-8')
  page(@Res({ passthrough: true }) response: unknown): string {
    this.browser.writeEarlyHints(response);
    return `<!doctype html>${this.browser.scripts().value}`;
  }
}

describe.each([
  ['express', false, 4243],
  ['fastify', true, 4244],
] as const)(
  'NestvexaBrowserService.writeEarlyHints (%s, integrity %s)',
  (platform, integrity, port) => {
    let app: INestApplication;
    let root: string;
    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), 'nestvexa-hints-'));
      await writeFile(join(root, 'hints-probe.hbs'), '<p>{{ready}}</p>');
      const module = await Test.createTestingModule({
        imports: [
          NestvexaModule.forRoot(
            { views: { root }, live: { enabled: true } },
            {
              components: [HintsProbe],
              browser: { integrity },
              useFactory: () => ({
                origin: `http://127.0.0.1:${port}`,
                resolveIdentity: () => ({
                  binding: 'hints-session-000001',
                  csrfToken: 'hints-csrf-0123456789abcdefghijklm',
                }),
                authorize: () => true,
              }),
            },
          ),
        ],
        controllers: [UmbrellaPages],
      }).compile();
      app =
        platform === 'fastify'
          ? module.createNestApplication(new FastifyAdapter(), {
              logger: false,
            })
          : module.createNestApplication({ logger: false });
      await configureNestvexa(app);
      await app.listen(port, '127.0.0.1');
    });
    afterAll(async () => {
      await app.close();
      if (dirname(resolve(root)) !== resolve(tmpdir()))
        throw new Error('Unsafe cleanup');
      await rm(root, { recursive: true, force: true });
    });

    it('hints exactly the content-addressed client modules the page preloads', async () => {
      const browser = app.get(NestvexaBrowserService);
      const listed = browser.earlyHints();
      expect(listed).toHaveLength(3);
      for (const hint of listed) {
        expect(hint.href).toMatch(/^\/_nestvexa\/assets\/[^/]+\/[a-z-]+\.js$/);
        expect(hint.rel).toBe('modulepreload');
        expect(hint.crossOrigin).toBe(integrity ? 'anonymous' : undefined);
      }
      // The generated, no-store boot module is never hinted.
      expect(listed.some((hint) => hint.href.endsWith('/boot.js'))).toBe(false);
      const received = await get(port, '/page');
      expect(received.status).toBe(200);
      expect(received.informational).toHaveLength(1);
      expect(received.informational[0]?.headers['link']).toBe(
        listed.map(formatEarlyHint).join(', '),
      );
      // Every hinted module is served and referenced by the page itself.
      for (const hint of listed) {
        if (integrity) expect(received.body).toContain(`href="${hint.href}"`);
        else expect(received.body).toContain('/boot.js');
        const asset = await fetch(`http://127.0.0.1:${port}${hint.href}`);
        expect(asset.status).toBe(200);
        expect(asset.headers.get('cache-control')).toContain('immutable');
      }
    });
  },
);

describe('ViteAssets.earlyHints', () => {
  let outDir: string;
  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'nestvexa-vite-hints-'));
    await mkdir(join(outDir, '.vite'), { recursive: true });
    await mkdir(join(outDir, 'assets'), { recursive: true });
    await writeFile(join(outDir, 'assets', 'app-AbCdEf12.js'), 'export {}');
    await writeFile(join(outDir, 'assets', 'shared-XyZ98765.js'), '');
    await writeFile(join(outDir, 'assets', 'app-Q1w2E3r4.css'), 'a{}');
    await writeFile(
      join(outDir, '.vite', 'manifest.json'),
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
  });
  afterAll(async () => {
    if (dirname(resolve(outDir)) !== resolve(tmpdir()))
      throw new Error('Unsafe cleanup');
    await rm(outDir, { recursive: true, force: true });
  });
  const manifest = () => join(outDir, '.vite', 'manifest.json');

  it('hints the hashed stylesheet, entry and static imports in production', () => {
    const assets = new ViteAssets({
      apps: { web: { entries: ['client/app.ts'], manifest: manifest() } },
    });
    expect(assets.earlyHints('web').map(formatEarlyHint)).toEqual([
      '</assets/app-Q1w2E3r4.css>; rel=preload; as=style',
      '</assets/app-AbCdEf12.js>; rel=modulepreload',
      '</assets/shared-XyZ98765.js>; rel=modulepreload',
    ]);
  });

  it('adds crossorigin with integrity, matching the tags', () => {
    const assets = new ViteAssets({
      apps: {
        web: {
          entries: ['client/app.ts'],
          manifest: manifest(),
          integrity: true,
        },
      },
    });
    expect(
      assets
        .earlyHints('web')
        .every((hint) => hint.crossOrigin === 'anonymous'),
    ).toBe(true);
    expect(assets.tags('web')).toContain('crossorigin="anonymous"');
  });

  it('sends nothing in development and leaves out relative URLs', () => {
    const dev = new ViteAssets({
      mode: 'development',
      apps: { web: { entries: ['client/app.ts'] } },
    });
    expect(dev.earlyHints('web')).toEqual([]);
    expect(
      assetEarlyHints({
        scripts: ['assets/app.js', '//evil.example/a.js', '/assets/b.js'],
        styles: [],
        preloads: [],
      }),
    ).toEqual([{ href: '/assets/b.js', rel: 'modulepreload' }]);
  });
});
