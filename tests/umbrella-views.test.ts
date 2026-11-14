import 'reflect-metadata';
import {
  Controller,
  Get,
  Inject,
  Module,
  NotFoundException,
  Query,
  Render,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HbsEngine,
  NestvexaModule,
  configureNestvexa,
  grantPermissions,
  permissionHelpers,
} from '../packages/nestvexa/dist/index.js';
import type { ConfigureNestvexaOptions } from '../packages/nestvexa/dist/index.js';

/**
 * The umbrella wires `views.namespaces`/`views.themes` into its Handlebars
 * engine and installs the opt-in `ViewErrorPageFilter` from
 * `configureNestvexa(app, { errorPages })`, on Express and Fastify.
 */
const roles: Record<string, readonly string[]> = {
  editor: ['posts.view', 'posts.edit'],
  viewer: ['posts.view'],
};
const policy = (role: string) => (ability: string) => {
  if (role === 'broken') throw new Error('policy outage');
  return roles[role]?.includes(ability) === true;
};

@Controller()
class PagesController {
  constructor(@Inject(HbsEngine) private readonly engine: HbsEngine) {}
  @Get('admin')
  @Render('admin::dashboard')
  admin() {
    return { title: 'Admin' };
  }
  @Get('admin/report')
  @Render('admin::report')
  report() {
    return { title: 'Report' };
  }
  @Get('themed')
  themed(@Query('theme') theme?: string) {
    return this.engine.render(
      'home',
      { title: 'Home' },
      theme === undefined ? {} : { theme },
    );
  }
  @Get('posts')
  posts(@Query('role') role = 'viewer') {
    return this.engine.render(
      'posts',
      { title: 'Posts' },
      { helpers: permissionHelpers(policy(role)) },
    );
  }
  @Get('granted')
  @Render('granted')
  granted(@Query('role') role = 'viewer') {
    return {
      title: 'Granted',
      can: grantPermissions(policy(role), ['posts.edit', 'posts.delete']),
    };
  }
  @Get('missing-thing')
  missing() {
    throw new NotFoundException('No such <thing>');
  }
  @Get('crash')
  crash() {
    throw new Error('database password=hunter2 leaked');
  }
  @Get('broken')
  @Render('broken')
  broken() {
    return { title: 'Broken' };
  }
}

const apps: INestApplication[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; admin: string; dark: string } {
  const base = mkdtempSync(join(tmpdir(), 'nv-umbrella-views-'));
  roots.push(base);
  const root = join(base, 'views');
  const admin = join(base, 'admin-views');
  const dark = join(base, 'themes', 'dark');
  const files: Record<string, string> = {
    [join(root, 'layout.hbs')]:
      '<!doctype html><html><head><title>{{title}}</title></head><body>{{body}}</body></html>',
    [join(root, 'home.hbs')]: '<main data-theme="base">{{title}}</main>',
    [join(root, 'posts.hbs')]:
      '<ul>{{#if (can "posts.view")}}<li id="view">View</li>{{/if}}{{#if (can "posts.edit")}}<li id="edit">Edit</li>{{/if}}{{#if (cannot "posts.edit")}}<li id="readonly">Read only</li>{{/if}}</ul>',
    [join(root, 'granted.hbs')]:
      '{{#if can.[posts.edit]}}<button id="edit">Edit</button>{{/if}}{{#if can.[posts.delete]}}<button id="delete">Delete</button>{{/if}}',
    [join(root, 'broken.hbs')]: '<p>ok</p>\n<p>{{> missingPartial}}</p>',
    [join(root, 'errors', '404.hbs')]:
      '<h1 id="error">{{status}} {{title}}</h1><p id="message">{{message}}</p>',
    [join(root, 'errors', '500.hbs')]:
      '<h1 id="error">{{status}} {{title}}</h1><p id="message">{{message}}</p>',
    [join(root, 'vendor', 'admin', 'report.hbs')]:
      '<section id="report" data-source="app-override">{{title}}</section>',
    [join(admin, 'dashboard.hbs')]:
      '<section id="dashboard" data-source="namespace">{{title}}</section>',
    [join(admin, 'report.hbs')]:
      '<section id="report" data-source="namespace">{{title}}</section>',
    [join(dark, 'home.hbs')]: '<main data-theme="dark">{{title}}</main>',
  };
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
  mkdirSync(dark, { recursive: true });
  return { root, admin, dark };
}

async function start(
  platform: 'express' | 'fastify',
  options?: ConfigureNestvexaOptions,
  errorViews = true,
): Promise<{ app: INestApplication; origin: string }> {
  const { root, admin, dark } = fixture();
  @Module({
    imports: [
      NestvexaModule.forRoot({
        views: {
          root,
          layout: 'layout',
          namespaces: { admin },
          themes: { dark },
        },
      }),
    ],
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
  await configureNestvexa(
    app,
    options ??
      (errorViews
        ? {
            errorPages: {
              views: { '404': 'errors/404', '5xx': 'errors/500' },
              log: () => undefined,
            },
          }
        : undefined),
  );
  await app.listen(0, '127.0.0.1');
  return { app, origin: await app.getUrl() };
}
const html = { accept: 'text/html,application/xhtml+xml' };

describe.each(['express', 'fastify'] as const)(
  'umbrella views on %s',
  (platform) => {
    it('renders @Render namespaced views, preferring the application vendor override', async () => {
      const { origin } = await start(platform);
      const admin = await fetch(`${origin}/admin`);
      expect(admin.status).toBe(200);
      const page = await admin.text();
      expect(page).toContain(
        '<section id="dashboard" data-source="namespace">Admin</section>',
      );
      expect(page).toContain('<title>Admin</title>');
      const report = await (await fetch(`${origin}/admin/report`)).text();
      expect(report).toContain('data-source="app-override"');
    });

    it('selects a registered theme override and falls back to the base view', async () => {
      const { origin } = await start(platform);
      expect(
        await (await fetch(`${origin}/themed?theme=dark`)).text(),
      ).toContain('data-theme="dark"');
      expect(await (await fetch(`${origin}/themed`)).text()).toContain(
        'data-theme="base"',
      );
      // An unregistered theme is a server error, never a filesystem lookup.
      const unknown = await fetch(`${origin}/themed?theme=..%2F..%2Fetc`, {
        headers: html,
      });
      expect(unknown.status).toBe(500);
      expect(await unknown.text()).not.toContain('etc');
    });

    it('gates markup with per-request permission helpers, failing closed', async () => {
      const { origin } = await start(platform);
      const editor = await (await fetch(`${origin}/posts?role=editor`)).text();
      expect(editor).toContain('id="edit"');
      expect(editor).not.toContain('id="readonly"');
      const viewer = await (await fetch(`${origin}/posts?role=viewer`)).text();
      expect(viewer).toContain('id="view"');
      expect(viewer).not.toContain('id="edit"');
      expect(viewer).toContain('id="readonly"');
      const broken = await (await fetch(`${origin}/posts?role=broken`)).text();
      expect(broken).not.toContain('id="view"');
      expect(broken).not.toContain('id="edit"');
      const granted = await (
        await fetch(`${origin}/granted?role=editor`)
      ).text();
      expect(granted).toContain('id="edit"');
      expect(granted).not.toContain('id="delete"');
    });

    it('renders configured error views for pages and Nest JSON for API clients', async () => {
      const { origin } = await start(platform);
      const notFound = await fetch(`${origin}/missing-thing`, {
        headers: html,
      });
      expect(notFound.status).toBe(404);
      expect(notFound.headers.get('content-type')).toContain('text/html');
      expect(notFound.headers.get('cache-control')).toBe('no-store');
      const page = await notFound.text();
      expect(page).toContain('<title>Not Found</title>');
      expect(page).toContain('<h1 id="error">404 Not Found</h1>');
      expect(page).toContain('No such &lt;thing&gt;');
      const route = await fetch(`${origin}/no/such/route`, { headers: html });
      expect(route.status).toBe(404);
      expect(await route.text()).toContain('404 Not Found');
      const crash = await fetch(`${origin}/crash`, { headers: html });
      expect(crash.status).toBe(500);
      const body = await crash.text();
      expect(body).toContain('500 Internal Server Error');
      expect(body).not.toContain('hunter2');
      const api = await fetch(`${origin}/missing-thing`, {
        headers: { accept: 'application/json' },
      });
      expect(api.status).toBe(404);
      expect(await api.json()).toMatchObject({
        statusCode: 404,
        message: 'No such <thing>',
      });
      const apiCrash = await fetch(`${origin}/crash`);
      expect(await apiCrash.json()).toEqual({
        statusCode: 500,
        message: 'Internal server error',
      });
    });

    it('shows the development page with the failing template and line only when enabled', async () => {
      const { origin } = await start(platform, {
        errorPages: { development: true, log: () => undefined },
      });
      const response = await fetch(`${origin}/broken`, { headers: html });
      expect(response.status).toBe(500);
      const page = await response.text();
      expect(page).toContain('<mark data-nv-template>broken.hbs</mark>');
      expect(page).toContain('<mark data-nv-line>2</mark>');
      expect(page).toContain('Development error page');
    });

    it('keeps Nest default errors without errorPages and rejects late or invalid options', async () => {
      const { app, origin } = await start(platform, undefined, false);
      const response = await fetch(`${origin}/missing-thing`, {
        headers: html,
      });
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain(
        'application/json',
      );
      await expect(
        configureNestvexa(app, { errorPages: { development: true } }),
      ).rejects.toThrow('first call only');
      await expect(configureNestvexa(app)).resolves.toBeUndefined();
    });
  },
);

describe('configureNestvexa errorPages validation', () => {
  it('rejects a caller-supplied render function', async () => {
    const { root } = fixture();
    @Module({ imports: [NestvexaModule.forRoot({ views: { root } })] })
    class AppModule {}
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    apps.push(app);
    const forged: unknown = { errorPages: { render: () => 'x' } };
    await expect(
      configureNestvexa(app, forged as ConfigureNestvexaOptions),
    ).rejects.toThrow('without render');
  });
});
