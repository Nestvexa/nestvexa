import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InertiaModule, InertiaPage } from '../packages/inertia/dist/index.js';
import type { InertiaSsrRenderer } from '../packages/inertia/dist/index.js';
import {
  ViteConfigurationError,
  ViteSsrError,
  createSsrRenderer,
  isMainModule,
  moduleSsrRenderer,
} from '../packages/vite/dist/index.js';

// Boots several Nest hosts: allow for slow CI/developer machines.
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const page = {
  component: 'Home',
  props: { errors: {}, title: 'Hi' },
  url: '/',
  version: '1',
};

describe('createSsrRenderer', () => {
  it('renders from a fresh copy of the serialized page', async () => {
    const seen: unknown[] = [];
    const renderer = createSsrRenderer({
      load: async () => ({
        render: (received: { props: Record<string, unknown> }) => {
          seen.push(received);
          received.props['mutated'] = true;
          return { head: ['<title>x</title>'], body: '<div id="app"></div>' };
        },
      }),
    });
    const result = await renderer.render(page, JSON.stringify(page));
    expect(result).toEqual({
      head: ['<title>x</title>'],
      body: '<div id="app"></div>',
    });
    expect(seen[0]).not.toBe(page);
    expect(page.props).not.toHaveProperty('mutated');
  });

  it('revives big-integer markers like @inertiajs/core parsePage', async () => {
    let received: unknown;
    const renderer = createSsrRenderer({
      load: async () => ({
        render: (value: unknown) => {
          received = value;
          return { head: [], body: '' };
        },
      }),
    });
    const json = JSON.stringify({
      ...page,
      preserveBigIntegers: true,
      props: {
        errors: {},
        id: { $bigint: '9007199254740993' },
        list: [{ $bigint: '-1' }],
      },
    });
    await renderer.render(page, json);
    expect(
      (received as { props: { id: unknown; list: unknown[] } }).props.id,
    ).toBe(9007199254740993n);
    expect((received as { props: { list: unknown[] } }).props.list[0]).toBe(
      -1n,
    );
  });

  it('loads once, retries after a failed load, and honours cache: false', async () => {
    let loads = 0;
    let fail = true;
    const renderer = createSsrRenderer({
      load: async () => {
        loads++;
        if (fail) throw new Error('boom');
        return { render: () => ({ head: [], body: 'ok' }) };
      },
    });
    await expect(renderer.load()).rejects.toMatchObject({
      type: 'component-resolution',
    });
    fail = false;
    await renderer.render(page, JSON.stringify(page));
    await renderer.render(page, JSON.stringify(page));
    expect(loads).toBe(2);
    let uncached = 0;
    const fresh = createSsrRenderer({
      cache: false,
      load: async () => {
        uncached++;
        return { render: () => ({ head: [], body: '' }) };
      },
    });
    await fresh.render(page, '{}');
    await fresh.render(page, '{}');
    expect(uncached).toBe(2);
  });

  it.each([
    ['missing export', { other: () => null }, 'invalid-response'],
    [
      'throwing render',
      {
        render: () => {
          throw new Error('render broke');
        },
      },
      'render',
    ],
    [
      'rejecting render',
      { render: async () => Promise.reject(new Error('x')) },
      'render',
    ],
    [
      'bad shape',
      { render: () => ({ head: 'nope', body: 1 }) },
      'invalid-response',
    ],
    [
      'non-string head entry',
      { render: () => ({ head: [1], body: '' }) },
      'invalid-response',
    ],
  ])('classifies %s', async (_label, module, type) => {
    const renderer = createSsrRenderer({ load: async () => module });
    const error: unknown = await renderer
      .render(page, JSON.stringify(page))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ViteSsrError);
    expect((error as ViteSsrError).type).toBe(type);
  });

  it('times out slow renders', async () => {
    const renderer = createSsrRenderer({
      timeoutMs: 20,
      load: async () => ({
        render: () => new Promise((resolve) => setTimeout(resolve, 500)),
      }),
    });
    await expect(renderer.render(page, '{}')).rejects.toMatchObject({
      type: 'timeout',
    });
  });

  it('supports a custom export name and validates options', async () => {
    const renderer = createSsrRenderer({
      exportName: 'renderPage',
      load: async () => ({ renderPage: () => ({ head: [], body: 'custom' }) }),
    });
    expect((await renderer.render(page, '{}')).body).toBe('custom');
    expect(() =>
      createSsrRenderer({ load: async () => ({}), timeoutMs: 0 }),
    ).toThrow(ViteConfigurationError);
    expect(() => moduleSsrRenderer('relative/ssr.js')).toThrow(
      ViteConfigurationError,
    );
    expect(isMainModule('file:///definitely/not/the/entry.js')).toBe(false);
  });
});

describe('in-process SSR through @nestvexa/inertia (fallback vs strict)', () => {
  let directory: string;
  const apps: INestApplication[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nestvexa-vite-ssr-'));
    await writeFile(
      join(directory, 'ssr.mjs'),
      [
        'export function render(page) {',
        "  if (page.component === 'Broken') throw new Error('secret stack detail');",
        '  const json = JSON.stringify(page).replace(/\\//g, "\\\\/").replace(/</g, "\\\\u003c");',
        '  return { head: ["<title>SSR " + page.component + "</title>"],',
        '    body: `<script data-page="app" type="application/json">${json}</script><div data-server-rendered="true" id="app"><h1>${page.props.title}</h1></div>` };',
        '}',
      ].join('\n'),
    );
  });
  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
    await rm(directory, { recursive: true, force: true });
  });

  async function start(
    renderer: InertiaSsrRenderer,
    mode: 'fallback' | 'strict',
  ): Promise<string> {
    @Controller()
    class PagesController {
      @Get()
      @InertiaPage('Home')
      home() {
        return { title: 'Hello <SSR>' };
      }

      @Get('broken')
      @InertiaPage('Broken')
      broken() {
        return { title: 'never' };
      }
    }
    @Module({
      imports: [
        InertiaModule.forRoot({ version: '1', ssr: { renderer, mode } }),
      ],
      controllers: [PagesController],
    })
    class AppModule {}
    const app = await NestFactory.create(AppModule, { logger: false });
    apps.push(app);
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it('embeds SSR markup on success and falls back to the client document on failure', async () => {
    const base = await start(
      moduleSsrRenderer(join(directory, 'ssr.mjs')),
      'fallback',
    );
    const ok = await fetch(`${base}/`);
    const html = await ok.text();
    expect(ok.status).toBe(200);
    expect(html).toContain('<title>SSR Home</title>');
    expect(html).toContain('data-server-rendered="true"');
    expect(html).toContain('"title":"Hello \\u003cSSR>"');
    const broken = await fetch(`${base}/broken`);
    const fallback = await broken.text();
    expect(broken.status).toBe(200);
    expect(fallback).toContain('<div id="app"></div>');
    expect(fallback).not.toContain('secret stack detail');
    // JSON visits never touch the SSR renderer.
    const json = await fetch(`${base}/broken`, {
      headers: { 'X-Inertia': 'true', 'X-Inertia-Version': '1' },
    });
    expect(json.headers.get('x-inertia')).toBe('true');
  });

  it('propagates SSR failures as 500 in strict mode without leaking details', async () => {
    const base = await start(
      moduleSsrRenderer(join(directory, 'ssr.mjs')),
      'strict',
    );
    expect((await fetch(`${base}/`)).status).toBe(200);
    const broken = await fetch(`${base}/broken`);
    expect(broken.status).toBe(500);
    expect(await broken.text()).not.toContain('secret stack detail');
  });

  it('falls back when the SSR bundle is missing (fallback) and fails in strict mode', async () => {
    const missing = moduleSsrRenderer(join(directory, 'missing.mjs'));
    const fallback = await start(missing, 'fallback');
    const page = await fetch(`${fallback}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<div id="app"></div>');
    const strict = await start(
      moduleSsrRenderer(join(directory, 'missing.mjs')),
      'strict',
    );
    expect((await fetch(`${strict}/`)).status).toBe(500);
  });
});

describe('production does not require Vite', () => {
  it('no emitted module statically imports vite', async () => {
    const dist = new URL('../packages/vite/dist/', import.meta.url);
    for (const file of await readdir(dist)) {
      if (!file.endsWith('.js')) continue;
      const source = await readFile(new URL(file, dist), 'utf8');
      expect(source).not.toMatch(
        /from\s+['"]vite['"]|import\(\s*['"]vite['"]\s*\)/,
      );
    }
  });
});
