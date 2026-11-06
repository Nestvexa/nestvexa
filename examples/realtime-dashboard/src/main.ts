import 'reflect-metadata';
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Inject,
  Module,
  Post,
  Redirect,
  Render,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { LiveRuntime, NestvexaModule, configureNestvexa } from 'nestvexa';
import type { LiveIdentity } from 'nestvexa';
import { RealtimeModule, RealtimeService } from '@nestvexa/realtime';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import session from 'express-session';
import {
  Dashboard,
  DashboardDataModule,
  authorizeChannel,
  connectReportJobs,
  viewerOf,
} from './dashboard.js';
import type { SessionRequest } from './dashboard.js';

const port = Number(process.env['PORT'] ?? 3116);
const origin = `http://127.0.0.1:${port}`;
const root = fileURLToPath(new URL('../views', import.meta.url));
const csp =
  "default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** A public pseudonym and a CSRF token for every new guest session. */
function prepare(request: SessionRequest): void {
  request.session.csrf ??= randomBytes(32).toString('base64url');
  request.session.viewerName ??= `Viewer-${randomBytes(3).toString('hex').toUpperCase()}`;
}
function sameToken(left: unknown, right: string | undefined): boolean {
  if (typeof left !== 'string' || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

const viewerActions = [
  '$mount',
  '$sync',
  'heartbeat',
  'recordOrder',
  'startReport',
  'cancelReport',
];
/** Live policy: viewers read and record orders; only operators raise incidents. */
function authorizeLive(
  identity: LiveIdentity,
  component: string,
  action: string,
): boolean {
  if (component !== 'dashboard') return false;
  if (action === 'raiseIncident')
    return identity.binding.endsWith(':role:operator');
  return viewerActions.includes(action);
}

@Controller()
class Pages {
  constructor(
    @Inject(LiveRuntime) private readonly live: LiveRuntime,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('home')
  async home(@Req() request: SessionRequest) {
    prepare(request);
    const viewer = viewerOf(request);
    return {
      title: 'Operations dashboard',
      csrf: request.session.csrf,
      operator: viewer.role === 'operator',
      dashboard: await this.live.mount(Dashboard, request),
    };
  }
  /**
   * Demonstration role switch. A real host derives roles from its own
   * authentication; here any guest may choose, which is why the operator
   * channel only carries sample data.
   */
  @Post('role')
  @Redirect('/', 303)
  role(@Req() request: SessionRequest) {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (!sameToken(body['_csrf'], request.session.csrf))
      throw new ForbiddenException('Invalid or missing CSRF token');
    const role = body['role'];
    if (role !== 'viewer' && role !== 'operator')
      throw new BadRequestException('Unknown role');
    const before = viewerOf(request).binding;
    request.session.role = role;
    // Close streams opened under the previous role; tokens are bound to it.
    this.realtime.revoke(before);
  }
  @Get('api/health')
  health() {
    return { status: 'ok' };
  }
  @Get('dashboard.css')
  @Header('Content-Type', 'text/css; charset=utf-8')
  styles() {
    return [
      'body{font-family:system-ui,sans-serif;max-width:56rem;margin:0 auto;padding:1rem;line-height:1.5;color:#1b1b1b;background:#fff}',
      '.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(12rem,1fr));gap:1rem;padding:0;list-style:none}',
      '.tile{border:2px solid #555;border-radius:8px;padding:.75rem}',
      '.tile output{display:block;font-size:2rem;font-variant-numeric:tabular-nums}',
      'button{padding:.4rem .8rem;font:inherit;margin:.25rem .25rem .25rem 0}',
      'input{padding:.4rem;border:2px solid #555;border-radius:4px;font:inherit}',
      '.error{color:#b00020}',
      ':focus-visible{outline:3px solid #1a5fb4;outline-offset:2px}',
    ].join('');
  }
}

/** Shared identity: the binding includes the role, never anything from the body. */
function identityOf(request: object): LiveIdentity {
  const value = request as Partial<SessionRequest>;
  if (!value.session?.csrf) throw new UnauthorizedException();
  return {
    binding: viewerOf(request).binding,
    csrfToken: value.session.csrf,
  };
}

@Module({
  imports: [
    RealtimeModule.forRoot({
      // Random per start: tokens do not survive a restart. Production uses
      // stable deployment secrets (first signs, all verify, for rotation).
      secrets: [randomBytes(48).toString('base64url')],
      origin,
      resolveIdentity: (request) => ({ binding: viewerOf(request).binding }),
      authorizeChannel,
    }),
    NestvexaModule.forRoot(
      { views: { root, layout: 'layout' }, live: { enabled: true } },
      {
        browser: { realtime: { endpoint: '/_nestvexa/realtime' } },
        components: [Dashboard],
        imports: [DashboardDataModule],
        inject: [RealtimeService],
        useFactory: (realtime: RealtimeService) => ({
          origin,
          realtime,
          // Each open dashboard polls once per heartbeat plus realtime refreshes.
          maxRequestsPerMinute: 240,
          resolveIdentity: identityOf,
          authorize: authorizeLive,
        }),
      },
    ),
  ],
  controllers: [Pages],
})
class AppModule {}

const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  logger: ['error', 'warn'],
});
// Local guest demonstration: production hosts supply authentication, a
// persistent session store, a deployment secret and HTTPS-only cookies.
app.use(
  session({
    name: 'nvdash.sid',
    secret: randomBytes(48).toString('base64url'),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      secure: false,
      maxAge: 30 * 60_000,
    },
  }),
);
await configureNestvexa(app);
connectReportJobs(app.get(RealtimeService));
app.enableShutdownHooks();
await app.listen(port, '127.0.0.1');
console.log(`Realtime dashboard: ${await app.getUrl()}`);
