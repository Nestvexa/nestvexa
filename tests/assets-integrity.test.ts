/**
 * Subresource Integrity for the bundled client assets (CORE-045,
 * `nestvexa/assets`): the manifest carries SHA-384 metadata for the exact
 * served bytes, `{{nvScripts}}` with `browser.integrity` emits integrity and
 * crossorigin on the boot module and module preloads, and Chromium refuses a
 * tampered client module.
 */
import 'reflect-metadata';
import { Controller, Get, Render } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LiveComponent,
  NestvexaBrowserService,
  NestvexaModule,
  State,
  configureNestvexa,
} from '../packages/nestvexa/dist/index.js';
import { NestvexaAssetsService } from '../packages/nestvexa/dist/assets.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

@LiveComponent({ name: 'integrity-probe', view: 'integrity-probe' })
class IntegrityProbe {
  @State() ready = true;
}
@Controller()
class Pages {
  @Get('page')
  @Render('page')
  page() {
    return {};
  }
}

const sha384 = (bytes: Buffer | string) =>
  `sha384-${createHash('sha384').update(bytes).digest('base64')}`;

async function start(platform: 'express' | 'fastify', integrity: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'nestvexa-assets-sri-'));
  cleanup.push(async () => {
    if (dirname(resolve(root)) !== resolve(tmpdir()))
      throw new Error('Unsafe cleanup');
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, 'integrity-probe.hbs'), '<p>{{ready}}</p>');
  await writeFile(
    join(root, 'page.hbs'),
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SRI</title>{{nvScripts}}</head><body><p>ok</p></body></html>',
  );
  const module = await Test.createTestingModule({
    imports: [
      NestvexaModule.forRoot(
        { views: { root }, live: { enabled: true } },
        {
          components: [IntegrityProbe],
          browser: { integrity },
          useFactory: () => ({
            origin: 'http://127.0.0.1:3844',
            resolveIdentity: () => ({
              binding: 'integrity-session-0001',
              csrfToken: 'integrity-csrf-0123456789abcdefghijk',
            }),
            authorize: () => true,
          }),
        },
      ),
    ],
    controllers: [Pages],
  }).compile();
  const app: INestApplication =
    platform === 'fastify'
      ? module.createNestApplication(new FastifyAdapter(), { logger: false })
      : module.createNestApplication({ logger: false });
  await configureNestvexa(app);
  await app.listen(0, '127.0.0.1');
  cleanup.push(() => app.close());
  return { app, base: await app.getUrl() };
}

describe.each(['express', 'fastify'] as const)(
  'client asset integrity: %s',
  (platform) => {
    it('publishes SHA-384 metadata for the exact served bytes', async () => {
      const { app, base } = await start(platform, false);
      const manifest = app.get(NestvexaAssetsService).getManifest();
      expect(Object.isFrozen(manifest.integrity)).toBe(true);
      expect(Object.keys(manifest.integrity).sort()).toEqual(
        Object.values(manifest.files).sort(),
      );
      for (const url of Object.values(manifest.files)) {
        const body = Buffer.from(
          await (await fetch(`${base}${url}`)).arrayBuffer(),
        );
        expect(manifest.integrity[url]).toBe(sha384(body));
        expect(manifest.integrity[url]).not.toBe(
          sha384(Buffer.concat([body, Buffer.from(' ')])),
        );
      }
      // Without the browser option the layout tag is unchanged.
      const html = await (await fetch(`${base}/page`)).text();
      expect(html).toContain(
        '<script type="module" src="/_nestvexa/boot.js"></script>',
      );
      expect(html).not.toContain('integrity=');
    });

    it('adds integrity and crossorigin to the boot module and its preloads', async () => {
      const { app, base } = await start(platform, true);
      const manifest = app.get(NestvexaAssetsService).getManifest();
      const html = await (await fetch(`${base}/page`)).text();
      const boot = await (await fetch(`${base}/_nestvexa/boot.js`)).text();
      for (const url of [
        manifest.entries.live,
        manifest.entries.alpine,
        manifest.entries.alpineAdapter,
      ])
        expect(html).toContain(
          `<link rel="modulepreload" href="${url}" integrity="${manifest.integrity[url] ?? ''}" crossorigin="anonymous">`,
        );
      expect(html).toContain(
        `<script type="module" src="/_nestvexa/boot.js" integrity="${sha384(boot)}" crossorigin="anonymous"></script>`,
      );
      expect(
        app.get(NestvexaBrowserService).scripts('bm9uY2UtMDEyMzQ1Njc4OQ==')
          .value,
      ).toContain('crossorigin="anonymous" nonce="bm9uY2UtMDEyMzQ1Njc4OQ=="');
    });
  },
);

describe('browser integrity option validation', () => {
  it('rejects non-boolean values and manual mode', () => {
    expect(() =>
      NestvexaModule.forRoot(
        { live: { enabled: true } },
        {
          components: [IntegrityProbe],
          browser: { integrity: 'yes' as unknown as boolean },
          useFactory: () => {
            throw new Error('not reached');
          },
        },
      ),
    ).toThrow(/integrity option must be a boolean/);
    expect(() =>
      NestvexaModule.forRoot(
        { live: { enabled: true } },
        {
          components: [IntegrityProbe],
          browser: { mode: 'manual', integrity: true },
          useFactory: () => {
            throw new Error('not reached');
          },
        },
      ),
    ).toThrow(/manual mode/);
  });
});

describe('Chromium enforces client asset integrity', () => {
  it('starts with intact assets and refuses a tampered Live client', async () => {
    const { app, base } = await start('express', true);
    const live = app.get(NestvexaAssetsService).getManifest().entries.live;
    const browser = await chromium.launch();
    cleanup.push(() => browser.close());
    const load = async (tamper: boolean) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      if (tamper)
        await page.route(`${base}${live}`, async (route) => {
          const response = await route.fetch();
          await route.fulfill({
            response,
            body: `${await response.text()}\nglobalThis.__tampered = true;`,
          });
        });
      await page.goto(`${base}/page`);
      // A string, so the test runner does not rewrite the browser's import().
      const outcome = await page.evaluate<string>(
        "import('/_nestvexa/boot.js').then((module) => ('app' in module ? 'started' : 'missing'), () => 'blocked')",
      );
      const tampered = await page.evaluate(() =>
        Reflect.get(globalThis, '__tampered'),
      );
      await context.close();
      return { outcome, tampered, errors };
    };
    const intact = await load(false);
    expect(intact.outcome).toBe('started');
    expect(intact.errors.filter((text) => /integrity/i.test(text))).toEqual([]);
    const tampered = await load(true);
    expect(tampered.outcome).toBe('blocked');
    expect(tampered.tampered).toBeUndefined();
    expect(tampered.errors.some((text) => /integrity/i.test(text))).toBe(true);
  }, 60_000);
});
