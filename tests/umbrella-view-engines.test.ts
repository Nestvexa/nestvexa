import 'reflect-metadata';
import { Controller, Get, Module, Render } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NestvexaModule,
  configureNestvexa,
  registerViewEngine,
} from '../packages/nestvexa/dist/index.js';
import type { ViewEngineBridge } from '../packages/nestvexa/dist/index.js';

/** A minimal adapter: renders `<view>` with the model's title, HTML-escaped. */
function fakeEngine(tag: string): ViewEngineBridge & { initialized: number } {
  const escape = (value: unknown) =>
    String(value).replace(
      /[&<>"']/g,
      (character) => `&#${character.charCodeAt(0)};`,
    );
  const engine = {
    initialized: 0,
    async initialize() {
      engine.initialized++;
    },
    async render(view: string, model: Record<string, unknown>) {
      return `<${tag} data-view="${escape(view)}">${escape(model['title'])}</${tag}>`;
    },
    renderFile(
      file: string,
      options: Record<string, unknown>,
      done: (error: Error | null, html?: string) => void,
    ) {
      // Express resolves the file under the views root first.
      void engine
        .render(relative(root, file).replaceAll(sep, '/'), options)
        .then((html) => done(null, html), done);
    },
  };
  return engine;
}

@Controller()
class PagesController {
  @Get('fake')
  @Render('pages/report.fake')
  fake() {
    return { title: '<Report>' };
  }
  @Get('hbs')
  @Render('home')
  hbs() {
    return { title: 'Home' };
  }
}

const apps: INestApplication[] = [];
let root = '';
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  if (root) rmSync(root, { recursive: true, force: true });
});

async function create(platform: 'express' | 'fastify') {
  root = mkdtempSync(join(tmpdir(), 'nv-view-engines-'));
  writeFileSync(join(root, 'home.hbs'), '<h1>{{title}}</h1>');
  mkdirSync(join(root, 'pages'));
  writeFileSync(
    join(root, 'pages', 'report.fake'),
    'unused by the fake engine',
  );
  @Module({
    imports: [NestvexaModule.forRoot({ views: { root } })],
    controllers: [PagesController],
  })
  class AppModule {}
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app =
    platform === 'fastify'
      ? moduleRef.createNestApplication(new FastifyAdapter(), { logger: false })
      : moduleRef.createNestApplication({ logger: false });
  apps.push(app);
  return app;
}

describe.each(['express', 'fastify'] as const)(
  'registerViewEngine on %s',
  (platform) => {
    it('renders the extension with the adapter and other views with HBS', async () => {
      const app = await create(platform);
      await configureNestvexa(app);
      const engine = fakeEngine('section');
      await registerViewEngine(app, 'fake', engine);
      expect(engine.initialized).toBe(1);
      await app.listen(0, '127.0.0.1');
      const origin = await app.getUrl();
      const fake = await fetch(`${origin}/fake`);
      expect(fake.status).toBe(200);
      expect(await fake.text()).toBe(
        '<section data-view="pages/report.fake">&#60;Report&#62;</section>',
      );
      const hbs = await fetch(`${origin}/hbs`);
      expect(await hbs.text()).toBe('<h1>Home</h1>');
    });

    it('rejects invalid extensions, hbs, incomplete adapters and duplicates', async () => {
      const app = await create(platform);
      await configureNestvexa(app);
      for (const extension of [
        'hbs',
        'EJS',
        '.ejs',
        'e/js',
        '',
        'a'.repeat(17),
      ])
        await expect(
          registerViewEngine(app, extension, fakeEngine('p')),
        ).rejects.toThrow('Invalid view engine extension');
      const incomplete: unknown = { render: () => Promise.resolve('') };
      await expect(
        registerViewEngine(app, 'fake', incomplete as ViewEngineBridge),
      ).rejects.toThrow('render() and renderFile()');
      await registerViewEngine(app, 'fake', fakeEngine('p'));
      await expect(
        registerViewEngine(app, 'fake', fakeEngine('p')),
      ).rejects.toThrow('already registered');
    });
  },
);
