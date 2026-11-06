import 'reflect-metadata';
import {
  Controller,
  Get,
  Header,
  Inject,
  Injectable,
  Module,
  Render,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { NestFactory, REQUEST } from '@nestjs/core';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  Action,
  Computed,
  LiveComponent,
  LiveRuntime,
  NestvexaModule,
  RealtimeChannels,
  State,
  configureNestvexa,
} from 'nestvexa';
import {
  MemoryRealtimeBroker,
  RealtimeModule,
  RealtimeService,
  attachRealtimeWebSocket,
} from '@nestvexa/realtime';
import { RedisLiveStore, RespConnection } from '@nestvexa/realtime-redis';
import { RedisRealtimeBroker } from '@nestvexa/realtime-redis/realtime';
import { guestFromCookie, issueGuest, presenceId } from './identity.js';
import type { Guest } from './identity.js';

/*
 * One replica of a horizontally scaled Nestvexa app. Without REDIS_PORT it runs
 * standalone (memory broker and Live store). With REDIS_PORT every replica
 * shares Live state (RedisLiveStore) and realtime events (RedisRealtimeBroker);
 * they must also share REALTIME_SECRET, IDENTITY_SECRET and PUBLIC_ORIGIN.
 */
const env = process.env;
const port = Number(env['PORT'] ?? 3220);
const replica = env['REPLICA'] ?? 'a';
const origin = env['PUBLIC_ORIGIN'] ?? `http://127.0.0.1:${port}`;
const transport = (env['REALTIME_TRANSPORT'] ?? 'auto') as
  'auto' | 'sse' | 'websocket' | 'polling';
if (!['auto', 'sse', 'websocket', 'polling'].includes(transport))
  throw new Error('REALTIME_TRANSPORT must be auto, sse, websocket or polling');
const redisPort = env['REDIS_PORT'] ? Number(env['REDIS_PORT']) : undefined;
const redis =
  redisPort === undefined
    ? undefined
    : {
        host: env['REDIS_HOST'] ?? '127.0.0.1',
        port: redisPort,
        ...(env['REDIS_PASSWORD'] ? { password: env['REDIS_PASSWORD'] } : {}),
      };
const prefix = env['REDIS_PREFIX'] ?? 'nvdemo:';
function secret(name: string): string {
  const value = env[name];
  if (value && Buffer.byteLength(value) >= 32) return value;
  if (redis) throw new Error(`${name} (≥32 bytes) is required with REDIS_PORT`);
  return randomBytes(48).toString('base64url');
}
const realtimeSecret = secret('REALTIME_SECRET');
const identitySecret = secret('IDENTITY_SECRET');
export const boardChannel = 'board:public';

interface GuestRequest extends IncomingMessage {
  nvGuest?: Guest;
}
function guestOf(request: unknown): Guest {
  const attached: unknown =
    request && typeof request === 'object'
      ? Reflect.get(request, 'nvGuest')
      : undefined;
  if (attached) return attached as Guest;
  const headers: unknown =
    request && typeof request === 'object'
      ? Reflect.get(request, 'headers')
      : undefined;
  const cookie: unknown =
    headers && typeof headers === 'object'
      ? Reflect.get(headers, 'cookie')
      : undefined;
  const guest = guestFromCookie(
    identitySecret,
    typeof cookie === 'string' ? cookie : undefined,
  );
  if (!guest) throw new UnauthorizedException();
  return guest;
}

/** A value every replica agrees on: a Redis counter, or memory when standalone. */
@Injectable()
export class SharedTotal {
  readonly #redis = redis ? new RespConnection(redis) : undefined;
  #local = 0;
  async read(): Promise<number> {
    if (!this.#redis) return this.#local;
    const value = await this.#redis.command('GET', `${prefix}total`);
    return typeof value === 'string' ? Number(value) : 0;
  }
  async increment(): Promise<number> {
    if (!this.#redis) return ++this.#local;
    const value = await this.#redis.command('INCR', `${prefix}total`);
    if (typeof value !== 'number') throw new Error('Redis INCR failed');
    return value;
  }
  async onApplicationShutdown(): Promise<void> {
    await this.#redis?.close();
  }
}
@Module({ providers: [SharedTotal], exports: [SharedTotal] })
class SharedModule {}

@LiveComponent({ name: 'replica-board', view: 'replica-board' })
export class ReplicaBoard {
  constructor(
    @Inject(SharedTotal) private readonly shared: SharedTotal,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
    @Inject(REQUEST) private readonly request: unknown,
  ) {}
  /** Component state: lives in the shared Live store, so any replica continues it. */
  @State() clicks = 0;
  @State() total = 0;
  @State() viewers = 0;
  @RealtimeChannels() channels(): string[] {
    return [boardChannel];
  }
  @Computed() get renderedBy(): string {
    return replica;
  }
  async dehydrate(): Promise<void> {
    this.total = await this.shared.read();
    const identity = { binding: guestOf(this.request).binding };
    this.viewers = (await this.realtime.presence(identity, boardChannel)).total;
  }
  @Action() async increment(): Promise<void> {
    this.clicks++;
    await this.shared.increment();
    // Every replica's subscribers refresh through their own authorized $sync.
    await this.realtime.publish(
      boardChannel,
      { by: replica },
      { identity: { binding: guestOf(this.request).binding } },
    );
  }
}

const csp = `default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`;
@Controller()
class Pages {
  constructor(@Inject(LiveRuntime) private readonly live: LiveRuntime) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('home')
  async home(@Req() request: GuestRequest) {
    return {
      title: 'Distributed Live board',
      replica,
      widget: await this.live.mount(ReplicaBoard, request),
    };
  }
  @Get('api/health')
  health() {
    return { status: 'ok', replica, distributed: redis !== undefined };
  }
}

const root = fileURLToPath(new URL('../views', import.meta.url));
@Module({
  imports: [
    RealtimeModule.forRoot({
      secrets: [realtimeSecret],
      origin,
      broker: redis
        ? new RedisRealtimeBroker({ ...redis, prefix: `${prefix}rt:` })
        : new MemoryRealtimeBroker(),
      resolveIdentity: (request) => ({ binding: guestOf(request).binding }),
      resolveUpgradeIdentity: (request) => ({
        binding: guestOf(request).binding,
      }),
      authorizeChannel: (_identity, channel) => channel === boardChannel,
      describePresence: (identity) => ({
        id: presenceId(identitySecret, identity.binding),
      }),
    }),
    NestvexaModule.forRoot(
      { views: { root, layout: 'layout' }, live: { enabled: true } },
      {
        browser: {
          realtime: { endpoint: '/_nestvexa/realtime', transport },
        },
        components: [ReplicaBoard],
        imports: [SharedModule],
        inject: [RealtimeService],
        useFactory: (realtime: RealtimeService) => ({
          origin,
          realtime,
          ...(redis
            ? {
                store: new RedisLiveStore({
                  ...redis,
                  prefix: `${prefix}live:`,
                }),
              }
            : {}),
          resolveIdentity(request: object) {
            const guest = guestOf(request);
            return { binding: guest.binding, csrfToken: guest.csrf };
          },
          authorize: (_identity, component, action) =>
            component === 'replica-board' &&
            ['$mount', '$sync', 'increment'].includes(action),
        }),
      },
    ),
  ],
  controllers: [Pages],
})
class AppModule {}

const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
// Issue the signed guest cookie on first visit; never trust an unsigned one.
app.use((request: GuestRequest, response: ServerResponse, next: () => void) => {
  const header = request.headers.cookie;
  const existing = guestFromCookie(identitySecret, header);
  if (existing) request.nvGuest = existing;
  else if (request.method === 'GET' && request.url === '/') {
    const issued = issueGuest(identitySecret);
    request.nvGuest = issued.guest;
    response.setHeader('Set-Cookie', issued.cookie);
  }
  next();
});
await configureNestvexa(app);
await attachRealtimeWebSocket(app);
app.enableShutdownHooks();
await app.listen(port, '127.0.0.1');
console.log(
  `Distributed Live replica ${replica} (${redis ? 'Redis' : 'standalone'}): ${await app.getUrl()}`,
);
