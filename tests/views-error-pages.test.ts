import 'reflect-metadata';
import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Module,
  NotFoundException,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import {
  ViewError,
  ViewErrorPageFilter,
  errorStatus,
  renderErrorPage,
  templateLocation,
} from '../packages/views/dist/index.js';

let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'nestvexa-errors-'));
  await mkdir(path.join(root, 'errors'));
  await writeFile(
    path.join(root, 'errors', '404.hbs'),
    '<h1>Missing: {{title}}</h1><p>{{message}}</p>',
  );
  await writeFile(
    path.join(root, 'errors', 'default.hbs'),
    '<h1>{{status}} {{title}}</h1>{{message}}',
  );
  await writeFile(path.join(root, 'errors', 'broken.hbs'), '{{#if x}}');
  await writeFile(path.join(root, 'page.hbs'), 'line one\n{{explode}}');
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('error page rendering', () => {
  it('derives status and template locations structurally', () => {
    expect(errorStatus(new NotFoundException())).toBe(404);
    expect(errorStatus(new Error('x'))).toBe(500);
    expect(errorStatus({ getStatus: () => 302 })).toBe(500);
    const error = new ViewError(
      'RENDER_FAILED',
      'Unable to render view: home (partials/a.hbs:12)',
    );
    expect(templateLocation(new Error('outer', { cause: error }))).toEqual({
      template: 'partials/a.hbs',
      line: 12,
    });
    expect(
      templateLocation(
        new ViewError('RENDER_FAILED', 'Unable to render view: home (x.hbs)'),
      ),
    ).toEqual({ template: 'x.hbs', line: undefined });
    expect(templateLocation(new Error('plain (x:1)'))).toBeUndefined();
  });
  it('renders configured production views without leaking server errors', async () => {
    const engine = new HbsEngine({ root, cache: true });
    const render = (view: string, model: Readonly<Record<string, unknown>>) =>
      engine.render(view, model);
    const views = { '404': 'errors/404', '5xx': 'errors/default' };
    const missing = await renderErrorPage(
      new NotFoundException('No <such> page'),
      { render, views },
    );
    expect(missing).toEqual({
      status: 404,
      html: '<h1>Missing: Not Found</h1><p>No &lt;such&gt; page</p>',
    });
    const crash = await renderErrorPage(new Error('db password=secret'), {
      render,
      views,
    });
    expect(crash.status).toBe(500);
    expect(crash.html).toBe('<h1>500 Internal Server Error</h1>');
    // An unmapped status gets the built-in minimal page.
    const bad = await renderErrorPage(new BadRequestException('Bad <input>'), {
      render,
      views,
    });
    expect(bad.status).toBe(400);
    expect(bad.html).toContain('<p>Bad &lt;input&gt;</p>');
    // A failing error view falls back instead of throwing.
    const fallback = await renderErrorPage(new Error('x'), {
      render,
      views: { default: 'errors/broken' },
    });
    expect(fallback.html).toContain('500 Internal Server Error');
    expect(fallback.html).not.toContain('x</');
  });
  it('shows an escaped development page naming the template and line', async () => {
    const engine = new HbsEngine({
      root,
      helpers: {
        explode: () => {
          throw new Error('<script>alert(1)</script>');
        },
      },
    });
    const error = await engine.render('page', {}).catch((e: unknown) => e);
    const page = await renderErrorPage(error, { development: true });
    expect(page.status).toBe(500);
    expect(page.html).toContain(
      'Template <mark data-nv-template>page.hbs</mark> line <mark data-nv-line>2</mark>',
    );
    expect(page.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page.html).not.toContain('<script>alert');
    expect(page.html).toContain('Unable to render view: page (page.hbs:2)');
  });
});

@Controller()
class ErrorsController {
  constructor(@Inject(HbsEngine) private readonly engine: HbsEngine) {}
  @Get('missing')
  missing(): never {
    throw new NotFoundException('Nothing at this <path>');
  }
  @Get('crash')
  crash(): never {
    throw new Error('internal detail');
  }
  @Get('template')
  template(): Promise<string> {
    return this.engine.render('page', {});
  }
}

for (const platform of ['express', 'fastify'] as const)
  describe(`ViewErrorPageFilter on ${platform}`, () => {
    let app: INestApplication;
    let base: string;
    const logged: number[] = [];
    beforeAll(async () => {
      const engine = new HbsEngine({
        root,
        helpers: {
          explode: () => {
            throw new Error('template helper failed');
          },
        },
      });
      @Module({
        controllers: [ErrorsController],
        providers: [{ provide: HbsEngine, useValue: engine }],
      })
      class AppModule {}
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app =
        platform === 'express'
          ? moduleRef.createNestApplication({ logger: false })
          : moduleRef.createNestApplication(new FastifyAdapter(), {
              logger: false,
            });
      app.useGlobalFilters(
        new ViewErrorPageFilter({
          render: (view, model) => engine.render(view, model),
          views: { '404': 'errors/404', default: 'errors/default' },
          log: (_error, status) => logged.push(status),
        }),
      );
      await app.listen(0, '127.0.0.1');
      base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    });
    afterAll(async () => {
      await app.close();
    });
    const get = (route: string, accept: string) =>
      fetch(`${base}${route}`, { headers: { accept } });
    it('renders HTML error views for page requests', async () => {
      const missing = await get('/missing', 'text/html,application/xhtml+xml');
      expect(missing.status).toBe(404);
      expect(missing.headers.get('content-type')).toContain('text/html');
      expect(missing.headers.get('cache-control')).toBe('no-store');
      expect(await missing.text()).toBe(
        '<h1>Missing: Not Found</h1><p>Nothing at this &lt;path&gt;</p>',
      );
      const crash = await get('/crash', 'text/html');
      expect(crash.status).toBe(500);
      expect(await crash.text()).toBe('<h1>500 Internal Server Error</h1>');
      const broken = await get('/template', 'text/html');
      expect(broken.status).toBe(500);
      expect(await broken.text()).not.toContain('template helper failed');
      expect(logged).toEqual([500, 500]);
    });
    it('keeps the Nest JSON body for API, Live and action requests', async () => {
      const missing = await get('/missing', 'application/json');
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({
        message: 'Nothing at this <path>',
        error: 'Not Found',
        statusCode: 404,
      });
      const crash = await get('/crash', '*/*');
      expect(crash.status).toBe(500);
      expect(await crash.json()).toEqual({
        statusCode: 500,
        message: 'Internal server error',
      });
    });
  });

describe('ViewErrorPageFilter development page', () => {
  it('serves template diagnostics over HTTP', async () => {
    const engine = new HbsEngine({
      root,
      helpers: {
        explode: () => {
          throw new Error('dev failure');
        },
      },
    });
    @Module({
      controllers: [ErrorsController],
      providers: [{ provide: HbsEngine, useValue: engine }],
    })
    class DevModule {}
    const moduleRef = await Test.createTestingModule({
      imports: [DevModule],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalFilters(
      new ViewErrorPageFilter({ development: true, log: () => undefined }),
    );
    await app.listen(0, '127.0.0.1');
    try {
      const response = await fetch(
        `${(await app.getUrl()).replace('[::1]', '127.0.0.1')}/template`,
        { headers: { accept: 'text/html' } },
      );
      expect(response.status).toBe(500);
      const html = await response.text();
      expect(html).toContain('<mark data-nv-template>page.hbs</mark>');
      expect(html).toContain('<mark data-nv-line>2</mark>');
      expect(html).toContain('dev failure');
    } finally {
      await app.close();
    }
  });
});
