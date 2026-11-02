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
import { IslandRegistry } from '@nestvexa/islands';
import {
  Action,
  Computed,
  LiveComponent,
  LiveRuntime,
  NestvexaModule,
  State,
  configureNestvexa,
} from 'nestvexa';

const port = Number(process.env['PORT'] ?? 3112);
const views = fileURLToPath(new URL('../views', import.meta.url));
const publicDirectory = fileURLToPath(new URL('./public/', import.meta.url));
const csp =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

/** Server-side island allowlist; the client bundle holds the matching module map. */
const islands = new IslandRegistry([
  { id: 'revenue-chart', framework: 'react', strategy: 'immediate' },
  { id: 'activity-feed', framework: 'vue', strategy: 'visible' },
  { id: 'status-widget', framework: 'svelte', strategy: 'idle' },
  { id: 'broken-island', framework: 'custom', strategy: 'immediate' },
]);

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

@Controller()
class Pages {
  constructor(@Inject(LiveRuntime) private readonly live: LiveRuntime) {}
  @Get('hybrid')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('hybrid')
  async hybrid(@Req() request: SessionRequest) {
    request.session.csrf ??= randomBytes(32).toString('base64url');
    return {
      title: 'Hybrid dashboard',
      notifications: await this.live.mount(Notifications, request),
      feed: islands.render(
        'activity-feed',
        { items: ['Dashboard opened', '<b>escaped</b> markup stays text'] },
        { key: 'feed', label: 'Activity feed (Vue)' },
      ),
      widget: islands.render(
        'status-widget',
        { label: 'Sync' },
        { label: 'Status (Svelte)' },
      ),
      broken: islands.render(
        'broken-island',
        {},
        { fallback: 'This widget is unavailable; the page keeps working.' },
      ),
    };
  }
  @Get('api/health')
  health() {
    return { status: 'ok' };
  }
  @Get('islands/:file')
  @Header('Cache-Control', 'no-cache')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  async client(@Param('file') file: string): Promise<string> {
    if (!/^islands\.js$/.test(file)) throw new NotFoundException();
    return readFile(publicDirectory + file, 'utf8');
  }
  @Get('islands/chunks/:file')
  @Header('Cache-Control', 'public, max-age=31536000, immutable')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  async chunk(@Param('file') file: string): Promise<string> {
    // Only content-hashed chunk names produced by the build are served.
    if (!/^[A-Za-z0-9_-]+-[A-Z0-9]{8}\.js$/.test(file))
      throw new NotFoundException();
    return readFile(`${publicDirectory}chunks/${file}`, 'utf8').catch(() => {
      throw new NotFoundException();
    });
  }
}

@Module({
  imports: [
    NestvexaModule.forRoot(
      { views: { root: views, layout: 'layout' }, live: { enabled: true } },
      {
        components: [Notifications],
        useFactory: () => ({
          origin: `http://127.0.0.1:${port}`,
          resolveIdentity(request: object) {
            const value = request as Partial<SessionRequest>;
            if (!value.session?.csrf || !value.sessionID)
              throw new UnauthorizedException();
            return {
              binding: `guest-session:${value.sessionID}`,
              csrfToken: value.session.csrf,
            };
          },
          authorize: (_identity, component, action) =>
            component === 'notifications' &&
            ['$mount', 'notify', 'toggleChart'].includes(action),
        }),
      },
    ),
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
