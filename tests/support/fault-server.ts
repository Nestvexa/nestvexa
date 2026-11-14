/**
 * TEST SERVER for fault injection (tests/browser/fault-injection.spec.ts).
 * Not an example: the browser spec starts, kills and restarts it on its own
 * port to inject a backend restart and session expiry between Live requests.
 *
 *   FAULT_PORT=4230 FAULT_SECRET=<32+ chars> FAULT_SESSION_TTL_MS=600000 \
 *     pnpm exec tsx tests/support/fault-server.ts
 *
 * Identity is a stateless signed cookie (`nv-fault=<user>.<expiresAt>.<mac>`,
 * HMAC-SHA256 with FAULT_SECRET), so it survives a restart, while Live state
 * lives in the process-local `MemoryLiveStore`, which does not. That is the
 * shape of a deployment with signed-token or shared-store sessions and
 * in-memory Live state: after a restart every open page's state reference is
 * gone (`410`) although its user is still signed in. An expired cookie is no
 * identity (`401`); `GET /` issues a fresh one and `GET /signin` a
 * ten-minute one.
 */
import 'reflect-metadata';
import {
  Controller,
  Get,
  Header,
  Inject,
  Module,
  Redirect,
  Render,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  Action,
  LiveComponent,
  LiveRuntime,
  MemoryLiveStore,
  NestvexaModule,
  State,
  configureNestvexa,
} from '../../packages/nestvexa/dist/index.js';

const port = Number(process.env['FAULT_PORT'] ?? 4230);
const secret = process.env['FAULT_SECRET'] ?? '';
const ttl = Number(process.env['FAULT_SESSION_TTL_MS'] ?? 600_000);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
  throw new Error('FAULT_PORT must be a TCP port');
if (secret.length < 32) throw new Error('FAULT_SECRET must be 32+ characters');
if (!Number.isSafeInteger(ttl) || ttl < 500)
  throw new Error('FAULT_SESSION_TTL_MS must be at least 500');
const origin = `http://127.0.0.1:${port}`;
/** Changes on every start, so the page shows which process rendered it. */
const boot = randomUUID();
const policy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

interface FaultRequest {
  headers: Record<string, string | string[] | undefined>;
  faultUser?: { readonly user: string; readonly expires: number };
}
interface FaultResponse {
  setHeader(name: string, value: string): void;
}

const mac = (value: string) =>
  createHmac('sha256', secret).update(value).digest('base64url');
function issue(
  user: string,
  lifetime = ttl,
): { cookie: string; expires: number } {
  const expires = Date.now() + lifetime;
  const body = `${user}.${expires}`;
  return { cookie: `${body}.${mac(body)}`, expires };
}
/** The signed, unexpired identity of a request, or undefined. */
function identityOf(
  request: FaultRequest,
): { user: string; expires: number } | undefined {
  const header = request.headers['cookie'];
  const value = (typeof header === 'string' ? header : '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('nv-fault='))
    ?.slice('nv-fault='.length);
  const match = /^([a-z]{1,16})\.(\d{1,15})\.([A-Za-z0-9_-]{43})$/.exec(
    value ?? '',
  );
  if (!match) return undefined;
  const [, user = '', expires = '', given = ''] = match;
  const expected = Buffer.from(mac(`${user}.${expires}`));
  const actual = Buffer.from(given);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return undefined;
  if (Number(expires) <= Date.now()) return undefined;
  return { user, expires: Number(expires) };
}

@LiveComponent({ name: 'fault-counter', view: 'fault-counter' })
class FaultCounter {
  @State() count = 0;
  @Action() increment(): void {
    this.count++;
  }
}

@Controller()
class FaultPages {
  constructor(@Inject(LiveRuntime) private readonly live: LiveRuntime) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', policy)
  @Render('home')
  async home(
    @Req() request: FaultRequest,
    @Res({ passthrough: true }) response: FaultResponse,
  ) {
    let identity = identityOf(request);
    if (!identity) {
      const fresh = issue('alice');
      response.setHeader(
        'Set-Cookie',
        `nv-fault=${fresh.cookie}; Path=/; HttpOnly; SameSite=Strict`,
      );
      identity = { user: 'alice', expires: fresh.expires };
    }
    request.faultUser = identity;
    return {
      title: 'Fault injection',
      boot,
      widget: await this.live.mount(FaultCounter, request),
    };
  }
  /** Sign in again with a ten-minute session (after an expiry test). */
  @Get('signin')
  @Redirect('/', 303)
  signin(@Res({ passthrough: true }) response: FaultResponse) {
    const fresh = issue('alice', 600_000);
    response.setHeader(
      'Set-Cookie',
      `nv-fault=${fresh.cookie}; Path=/; HttpOnly; SameSite=Strict`,
    );
    return undefined;
  }
  @Get('api/health')
  health() {
    return { status: 'ok', boot };
  }
  @Get('fault.css')
  @Header('Content-Type', 'text/css; charset=utf-8')
  styles() {
    return 'body{font-family:system-ui,sans-serif;margin:1rem}button{min-height:2.75rem}.reload-hint{display:none}[data-nv-suspended] .reload-hint{display:block}';
  }
}

@Module({
  imports: [
    NestvexaModule.forRoot(
      {
        views: {
          root: fileURLToPath(new URL('./fault-views', import.meta.url)),
          layout: 'layout',
        },
        live: { enabled: true },
      },
      {
        components: [FaultCounter],
        useFactory: () => ({
          origin,
          maxRequestsPerMinute: 5000,
          store: new MemoryLiveStore(),
          resolveIdentity(request: object) {
            const value = request as FaultRequest;
            const identity = value.faultUser ?? identityOf(value);
            if (!identity) throw new UnauthorizedException();
            return {
              binding: `fault-user:${identity.user}`,
              csrfToken: mac(`csrf:${identity.user}:${identity.expires}`),
            };
          },
          authorize: (_identity, component, action) =>
            component === 'fault-counter' &&
            ['$mount', '$sync', 'increment'].includes(action),
        }),
      },
    ),
  ],
  controllers: [FaultPages],
})
class FaultModule {}

const app = await NestFactory.create(FaultModule, { logger: ['error'] });
await configureNestvexa(app);
app.enableShutdownHooks();
await app.listen(port, '127.0.0.1');
console.log(`Fault server ${boot} listening at ${origin}`);
