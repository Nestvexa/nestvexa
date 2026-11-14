import 'reflect-metadata';
import {
  Controller,
  Get,
  Header,
  Inject,
  Module,
  Query,
  Render,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  Action,
  HbsEngine,
  LiveComponent,
  LiveRuntime,
  NestvexaModule,
  State,
  configureNestvexa,
  grantPermissions,
  permissionHelpers,
} from 'nestvexa';
import type { ViewPermissionCheck } from 'nestvexa';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import session from 'express-session';

declare module 'express-session' {
  interface SessionData {
    csrf?: string;
  }
}
interface SessionRequest {
  session: session.Session & Partial<session.SessionData>;
  sessionID: string;
}

const port = Number(process.env['PORT'] ?? 4100);
const directory = (path: string) =>
  fileURLToPath(new URL(`../${path}`, import.meta.url));
const policy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

/**
 * Demonstration roles. A real application derives the decision from its
 * authenticated principal; the query parameter only makes the tour visible.
 */
const roles: Readonly<Record<string, readonly string[]>> = {
  editor: ['posts.view', 'posts.edit'],
  viewer: ['posts.view'],
};
function checkFor(role: unknown): ViewPermissionCheck {
  const granted =
    typeof role === 'string' && Object.hasOwn(roles, role) ? roles[role] : [];
  return (ability) => granted?.includes(ability) === true;
}
/** Only registered theme names reach the engine; anything else is the default. */
const themes = ['dark'] as const;
function themeOf(value: unknown): (typeof themes)[number] | undefined {
  return themes.find((theme) => theme === value);
}

/**
 * `nv:cloak` hides the interactive panel until the client initializes it;
 * `nv:class` toggles CSS classes from boolean public state (no inline styles).
 */
@LiveComponent({ name: 'tour-panel', view: 'tour-panel' })
class TourPanel {
  @State() urgent = false;
  @State() archived = false;
  @State() toggles = 0;
  @Action() toggleUrgent(): void {
    this.urgent = !this.urgent;
    this.toggles++;
  }
  @Action() toggleArchived(): void {
    this.archived = !this.archived;
    this.toggles++;
  }
}

/** Mounted only when scrolled into view; the placeholder is server HTML. */
@LiveComponent({
  name: 'tour-feed',
  view: 'tour-feed',
  lazy: 'visible',
  placeholder: 'tour-feed-placeholder',
})
class TourFeed {
  @State() headline = 'Latest updates';
  @State() items = ['Namespaced views', 'Theme overrides', 'Error pages'];
}

function csrf(request: SessionRequest): void {
  request.session.csrf ??= randomBytes(32).toString('base64url');
}

@Controller()
class TourController {
  constructor(
    @Inject(LiveRuntime) private readonly live: LiveRuntime,
    @Inject(HbsEngine) private readonly engine: HbsEngine,
  ) {}

  /** Theme selection needs `RenderOptions.theme`, so this page renders explicitly. */
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', policy)
  async home(@Req() request: SessionRequest, @Query('theme') theme?: string) {
    csrf(request);
    const selected = themeOf(theme);
    return this.engine.render(
      'home',
      {
        title: 'Nestvexa views tour',
        theme: selected ?? 'default',
        panel: await this.live.mount(TourPanel, request),
      },
      selected === undefined ? {} : { theme: selected },
    );
  }

  @Get('lazy')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', policy)
  @Render('lazy')
  async lazy(@Req() request: SessionRequest) {
    csrf(request);
    return {
      title: 'Lazy Live component',
      feed: await this.live.mount(TourFeed, request),
    };
  }

  /** Per-request `can`/`cannot` helpers delegate to the host policy. */
  @Get('posts')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', policy)
  posts(@Query('role') role?: string) {
    return this.engine.render(
      'posts',
      { title: 'Posts', role: role ?? 'guest' },
      { helpers: permissionHelpers(checkFor(role)) },
    );
  }

  /** `@Render` handlers receive precomputed decisions as view data instead. */
  @Get('posts/granted')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', policy)
  @Render('posts-granted')
  granted(@Query('role') role?: string) {
    return {
      title: 'Posts (precomputed permissions)',
      role: role ?? 'guest',
      can: grantPermissions(checkFor(role), ['posts.edit', 'posts.delete']),
    };
  }

  @Get('admin')
  @Header('Content-Security-Policy', policy)
  @Render('admin::dashboard')
  admin() {
    return { title: 'Admin dashboard' };
  }

  @Get('admin/settings')
  @Header('Content-Security-Policy', policy)
  @Render('admin::settings')
  settings() {
    return { title: 'Admin settings' };
  }

  @Get('boom')
  boom(): never {
    throw new Error('Simulated failure with a secret: token=do-not-show');
  }

  @Get('api/health')
  health() {
    return { status: 'ok' };
  }

  @Get('tour.css')
  @Header('Content-Type', 'text/css; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  stylesheet() {
    return [
      // Ship this rule with every page that uses nv:cloak.
      '[nv\\:cloak]{display:none!important}',
      'body{font:16px/1.5 system-ui,sans-serif;margin:2rem;max-width:48rem;color:#1f2328;background:#fff}',
      'body[data-theme="dark"]{color:#f0f3f6;background:#0d1117}',
      'body[data-theme="dark"] a{color:#79c0ff}',
      'button{font:inherit;min-height:2.75rem;margin:.25rem}',
      '.tour-status{padding:.5rem;border:2px solid transparent}',
      '.is-urgent{border-color:#d1242f}',
      '.is-archived{color:#57606a;text-decoration:line-through}',
      '.spacer{height:2400px}',
    ].join('');
  }
}

@Module({
  imports: [
    NestvexaModule.forRoot(
      {
        views: {
          root: directory('views'),
          layout: 'layout',
          namespaces: { admin: directory('modules/admin/views') },
          themes: { dark: directory('themes/dark') },
        },
        live: { enabled: true },
      },
      {
        components: [TourPanel, TourFeed],
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
            (component === 'tour-panel' &&
              ['$mount', 'toggleUrgent', 'toggleArchived'].includes(action)) ||
            (component === 'tour-feed' && ['$mount', '$sync'].includes(action)),
        }),
      },
    ),
  ],
  controllers: [TourController],
})
class AppModule {}

const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
// Local demonstration only: production needs a persistent session store and a deployment secret.
app.use(
  session({
    secret: randomBytes(48).toString('base64url'),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'strict', secure: false },
  }),
);
await configureNestvexa(app, {
  // Opt-in view-rendered error pages: 404/5xx views for browser pages, Nest's
  // JSON body for API and Live calls. Development diagnostics stay off unless
  // explicitly requested.
  errorPages: {
    views: { '404': 'errors/404', '5xx': 'errors/500' },
    development: process.env['VIEWS_TOUR_DEV_ERRORS'] === '1',
    log: (error, status) =>
      console.error(
        `views-tour ${status}: ${error instanceof Error ? error.message : 'non-Error thrown'}`,
      ),
  },
});
app.enableShutdownHooks();
await app.listen(port, '127.0.0.1');
console.log(`Nestvexa views tour: ${await app.getUrl()}`);
