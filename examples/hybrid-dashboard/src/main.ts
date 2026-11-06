import 'reflect-metadata';
import {
  Controller,
  Get,
  Header,
  Inject,
  Module,
  NotFoundException,
  Param,
  Render,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import session from 'express-session';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ActionsModule, jobRunnerQueue } from '@nestvexa/actions';
import { IslandRegistry } from '@nestvexa/islands';
import type { IslandServerRenderer } from '@nestvexa/islands';
import { MemoryInstrumentation } from '@nestvexa/observability';
import { JobRunner } from '@nestvexa/realtime';
import {
  Action,
  Computed,
  LiveComponent,
  LiveRuntime,
  NestvexaModule,
  State,
  configureNestvexa,
} from 'nestvexa';
import { DashboardActions, DashboardModule, ISLANDS } from './dashboard.js';

const port = Number(process.env['PORT'] ?? 3112);
const origin = `http://127.0.0.1:${port}`;
const views = fileURLToPath(new URL('../views', import.meta.url));
const publicDirectory = fileURLToPath(new URL('./public/', import.meta.url));
const csp =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

/** SSR renderers come from the Node bundle built by build-client.mjs. */
async function loadRenderers(): Promise<Record<string, IslandServerRenderer>> {
  const loaded: unknown = await import(
    new URL('./ssr/islands-ssr.js', import.meta.url).href
  );
  const renderers: unknown =
    typeof loaded === 'object' && loaded !== null
      ? Reflect.get(loaded, 'renderers')
      : undefined;
  if (typeof renderers !== 'object' || renderers === null)
    throw new Error('Island SSR bundle has no renderers export');
  return renderers as Record<string, IslandServerRenderer>;
}

/**
 * Server registry from the build-time manifest (ids, frameworks, props
 * schemas, limits). The browser loader bundles the same manifest.
 */
const islands = IslandRegistry.fromManifest(
  JSON.parse(await readFile(`${publicDirectory}islands-manifest.json`, 'utf8')),
  {
    // Demo key per process; production hosts load a managed secret.
    signingKeys: [randomBytes(32)],
    renderers: await loadRenderers(),
    onRenderError: (error, id) =>
      console.error(`Island ${id} SSR failed`, error),
  },
);
/** Page context shared by every island: design tokens and display-only user data. */
const islandContext = islands.contextScript({
  locale: 'en',
  direction: 'ltr',
  theme: { accent: '#2f5bff', surface: '#f6f7fb', radius: '8px' },
  user: { name: 'Guest' },
});
const spans = new MemoryInstrumentation(200);
const jobs = new JobRunner({ concurrency: 2, maxJobs: 200 });

/** Live component that owns one React island inside its own morphed markup. */
@LiveComponent({ name: 'notifications', view: 'notifications' })
class Notifications {
  @State() count = 0;
  @State() showChart = true;
  @Computed() get chartIsland(): string {
    // Rendered as trusted markup through a triple-stash in this view only.
    return islands.render(
      'revenue-chart',
      { title: 'Revenue by quarter', values: [12, 19, 7, 15] },
      {
        key: 'chart',
        label: 'Revenue chart (React)',
        fallback: 'Loading chart…',
      },
    ).value;
  }
  @Action() notify(): void {
    this.count++;
  }
  @Action() toggleChart(): void {
    this.showChart = !this.showChart;
  }
}
interface SessionRequest {
  session: session.Session & { csrf?: string };
  sessionID: string;
}
function page(request: SessionRequest, title: string) {
  request.session.csrf ??= randomBytes(32).toString('base64url');
  return { title, csrf: request.session.csrf, islandContext };
}

@Controller()
class Pages {
  constructor(@Inject(LiveRuntime) private readonly live: LiveRuntime) {}
  @Get('hybrid')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('hybrid')
  async hybrid(@Req() request: SessionRequest) {
    return {
      ...page(request, 'Hybrid dashboard'),
      notifications: await this.live.mount(Notifications, request),
      kpi: await islands.renderSsr(
        'react-kpi',
        { label: 'Active users', value: 42 },
        { label: 'Active users (React, SSR)', context: { locale: 'en' } },
      ),
      feed: await islands.renderSsr(
        'activity-feed',
        { items: ['Dashboard opened', '<b>escaped</b> markup stays text'] },
        {
          key: 'feed',
          label: 'Activity feed (Vue, SSR)',
          noscript: 'Live activity updates need JavaScript.',
        },
      ),
      widget: await islands.renderSsr(
        'status-widget',
        { label: 'Sync', workspace: 'demo' },
        { label: 'Status (Svelte, SSR)' },
      ),
      broken: islands.render(
        'broken-island',
        {},
        { fallback: 'This widget is unavailable; the page keeps working.' },
      ),
    };
  }
  @Get('hybrid/about')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('about')
  about(@Req() request: SessionRequest) {
    return page(request, 'About the hybrid dashboard');
  }
  @Get('hybrid/diagnostics')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('diagnostics')
  async diagnostics(@Req() request: SessionRequest) {
    const ids = ['origin-react', 'origin-vue', 'origin-svelte'];
    return {
      ...page(request, 'Island diagnostics'),
      origins: await Promise.all(
        ids.map((id) => islands.renderSsr(id, {}, { label: id })),
      ),
    };
  }
  @Get('api/health')
  health() {
    return { status: 'ok' };
  }
  /** Demo telemetry: action spans recorded through the observability interface. */
  @Get('api/action-spans')
  @Header('Cache-Control', 'no-store')
  actionSpans() {
    return spans.records.map((record) => ({
      name: record.name,
      outcome: record.outcome,
      attributes: record.attributes,
    }));
  }
  @Get('islands-loader.js')
  @Header('Cache-Control', 'no-cache')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  loader(): Promise<string> {
    return readFile(`${publicDirectory}islands-loader.js`, 'utf8');
  }
  @Get('islands/:file')
  @Header('Cache-Control', 'public, max-age=31536000, immutable')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  island(@Param('file') file: string): Promise<string> {
    return this.#hashed(`${publicDirectory}islands/`, file);
  }
  @Get('islands/chunks/:file')
  @Header('Cache-Control', 'public, max-age=31536000, immutable')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  chunk(@Param('file') file: string): Promise<string> {
    return this.#hashed(`${publicDirectory}islands/chunks/`, file);
  }
  /** Only content-hashed file names produced by the build are served. */
  #hashed(directory: string, file: string): Promise<string> {
    if (!/^[A-Za-z0-9_-]+-[A-Z0-9]{8}\.js$/.test(file))
      throw new NotFoundException();
    return readFile(directory + file, 'utf8').catch(() => {
      throw new NotFoundException();
    });
  }
}

function identity(request: object) {
  const value = request as Partial<SessionRequest>;
  if (!value.session?.csrf || !value.sessionID) return null;
  return {
    subject: `guest-session:${value.sessionID}`,
    csrfToken: value.session.csrf,
  };
}

@Module({
  providers: [{ provide: ISLANDS, useValue: islands }],
  exports: [ISLANDS],
})
class IslandsModule {}

@Module({
  imports: [
    NestvexaModule.forRoot(
      { views: { root: views, layout: 'layout' }, live: { enabled: true } },
      {
        components: [Notifications],
        useFactory: () => ({
          origin,
          resolveIdentity(request: object) {
            const resolved = identity(request);
            if (!resolved) throw new UnauthorizedException();
            return {
              binding: resolved.subject,
              csrfToken: resolved.csrfToken,
            };
          },
          authorize: (_identity, component, action) =>
            component === 'notifications' &&
            ['$mount', 'notify', 'toggleChart'].includes(action),
        }),
      },
    ),
    // Typed server actions called from the React, Vue and Svelte islands.
    ActionsModule.register({
      groups: [DashboardActions],
      imports: [DashboardModule, IslandsModule],
      origin,
      resolveIdentity: identity,
      authorize: (_identity, action) =>
        action.group === 'dashboard' || action.group === '_jobs',
      jobs: {
        queue: jobRunnerQueue(jobs),
        channel: JobRunner.channel,
        pollAfterMs: 100,
      },
      instrumentation: spans,
    }),
  ],
  controllers: [Pages],
})
class AppModule {}

const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
// Local guest demonstration only; production hosts supply real sessions and identity.
app.use(
  session({
    secret: randomBytes(48).toString('base64url'),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'strict', secure: false },
  }),
);
await configureNestvexa(app);
app.enableShutdownHooks();
await app.listen(port, '127.0.0.1');
console.log(`Hybrid dashboard: ${await app.getUrl()}/hybrid`);
