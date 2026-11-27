import 'reflect-metadata';
import {
  Controller,
  Get,
  Header,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Post,
  Query,
  Render,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { HttpAdapterHost, NestFactory, REQUEST } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { IncomingMessage } from 'node:http';
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
  downloadLive,
} from 'nestvexa';
import {
  MemoryRealtimeBroker,
  RealtimeModule,
  RealtimeService,
  attachRealtimeWebSocket,
} from '@nestvexa/realtime';
import { RedisLiveStore, RespConnection } from '@nestvexa/realtime-redis';
import { redisRealtime } from '@nestvexa/realtime-redis/realtime';
import {
  guestFromCookie,
  issueGuest,
  presenceId,
  tenantOf,
  tenantPattern,
} from './identity.js';
import type { Guest } from './identity.js';

/*
 * One replica of a horizontally scaled Nestvexa app. Without REDIS_PORT it runs
 * standalone (memory broker and Live store). With REDIS_PORT every replica
 * shares Live state (RedisLiveStore), realtime events (RedisRealtimeBroker) and
 * presence (RedisPresenceStore); they must also share REALTIME_SECRET,
 * IDENTITY_SECRET and PUBLIC_ORIGIN. HTTP_ADAPTER selects Express (default) or
 * Fastify: replicas on different adapters can serve the same app.
 */
const env = process.env;
const port = Number(env['PORT'] ?? 3220);
const replica = env['REPLICA'] ?? 'a';
const origin = env['PUBLIC_ORIGIN'] ?? `http://127.0.0.1:${port}`;
const transport = (env['REALTIME_TRANSPORT'] ?? 'auto') as
  'auto' | 'sse' | 'websocket' | 'polling';
if (!['auto', 'sse', 'websocket', 'polling'].includes(transport))
  throw new Error('REALTIME_TRANSPORT must be auto, sse, websocket or polling');
const adapter = env['HTTP_ADAPTER'] ?? 'express';
if (adapter !== 'express' && adapter !== 'fastify')
  throw new Error('HTTP_ADAPTER must be express or fastify');
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
const exportDelay = Number(env['EXPORT_DELAY_MS'] ?? 1500);
/** Acceptance-only load generator route; never enable it in a deployment. */
const loadTools = env['ACCEPTANCE_LOAD_TOOLS'] === '1';
function secret(name: string): string {
  const value = env[name];
  if (value && Buffer.byteLength(value) >= 32) return value;
  if (redis) throw new Error(`${name} (≥32 bytes) is required with REDIS_PORT`);
  return randomBytes(48).toString('base64url');
}
const realtimeSecret = secret('REALTIME_SECRET');
const identitySecret = secret('IDENTITY_SECRET');
export const boardChannel = 'board:public';
/** Private feed of one tenant: only that tenant's guests may subscribe. */
export const tenantChannel = (tenant: string): string =>
  `tenant:${tenant}:feed`;

/*
 * The shared Redis clients are created once so the readiness probe can check
 * the same connections that serve traffic. Each has its own circuit breaker
 * (docs/guides/resilience.md): while Redis is down a probe fails at once
 * instead of waiting for a timeout.
 */
const liveStore = redis
  ? new RedisLiveStore({ ...redis, prefix: `${prefix}live:` })
  : undefined;
/** One Redis realtime configuration: the broker (also probed by readiness) plus shared presence. */
const realtimeRedis = redis
  ? redisRealtime({
      ...redis,
      prefix: `${prefix}rt:`,
      presence: { ttlMs: Number(env['PRESENCE_TTL_MS'] ?? 30_000) },
    })
  : undefined;
const broker = realtimeRedis?.broker ?? new MemoryRealtimeBroker();
/** Upper bound for one readiness check, so the probe itself never hangs. */
const readinessTimeoutMs = Number(env['READINESS_TIMEOUT_MS'] ?? 1000);
type Check = 'ok' | 'memory' | 'unavailable' | 'resubscribing';
async function check(probe: () => Promise<void>): Promise<Check> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('readiness check timed out')),
          readinessTimeoutMs,
        );
      }),
    ]);
    return 'ok';
  } catch {
    return 'unavailable';
  } finally {
    clearTimeout(timer);
  }
}
/** Store and broker reachability; standalone replicas report `memory`. */
async function readiness(): Promise<{ store: Check; broker: Check }> {
  if (!liveStore || !(broker instanceof RedisRealtimeBroker))
    return { store: 'memory', broker: 'memory' };
  const [store, pubsub] = await Promise.all([
    check(() => liveStore.ping()),
    check(() => broker.ping()),
  ]);
  // Reachable but still restoring channel subscriptions after an outage:
  // events published now would be lost for this replica's browsers.
  return {
    store,
    broker: pubsub === 'ok' && !broker.subscribed ? 'resubscribing' : pubsub,
  };
}

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
    return this.#incr('total');
  }
  /** Side effects of the idempotent `pay` action, counted across replicas. */
  async charge(): Promise<number> {
    return this.#incr('charges');
  }
  async charges(): Promise<number> {
    return this.#get('charges');
  }
  /** Announcements made in one tenant (never readable by another). */
  async notices(tenant: string): Promise<number> {
    return this.#get(`notices:${tenant}`);
  }
  async announce(tenant: string): Promise<number> {
    return this.#incr(`notices:${tenant}`);
  }
  async #get(name: string): Promise<number> {
    if (!this.#redis) return this.#counts.get(name) ?? 0;
    const value = await this.#redis.command('GET', `${prefix}${name}`);
    return typeof value === 'string' ? Number(value) : 0;
  }
  readonly #counts = new Map<string, number>();
  async #incr(name: string): Promise<number> {
    if (!this.#redis) {
      if (name === 'total') return ++this.#local;
      const next = (this.#counts.get(name) ?? 0) + 1;
      this.#counts.set(name, next);
      return next;
    }
    const value = await this.#redis.command('INCR', `${prefix}${name}`);
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
  @RealtimeChannels() channels(): string[] {
    return [boardChannel];
  }
  @Computed() get renderedBy(): string {
    return replica;
  }
  @Computed() get httpAdapter(): string {
    return adapter;
  }
  /**
   * Shared data is read on every render, never copied into `@State`: a
   * realtime refresh then stays read-only (one request, no new revision)
   * instead of a refused refresh followed by a commit.
   */
  @Computed({ async: true }) async total(): Promise<number> {
    return this.shared.read();
  }
  @Computed({ async: true }) async viewers(): Promise<number> {
    const identity = { binding: guestOf(this.request).binding };
    return (await this.realtime.presence(identity, boardChannel)).total;
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
  /**
   * A non-repeatable side effect. With RedisLiveStore the replay record is
   * shared, so a retry with the same request ID on any replica replays the
   * first response instead of charging again.
   */
  @Action({ idempotent: true }) async pay(): Promise<void> {
    await this.shared.charge();
  }
  /**
   * One export per identity at a time across replicas (a Redis lease held
   * for the action's duration). EXPORT_DELAY_MS stands in for real work.
   */
  /**
   * A single-use attachment. With RedisLiveStore the download record is
   * shared, so the URL (also inside a replayed response) works on any
   * replica, exactly once.
   */
  @Action({ idempotent: true }) receipt(): void {
    downloadLive(this, {
      filename: 'receipt-' + replica + '.txt',
      contentType: 'text/plain; charset=utf-8',
      body: 'Receipt rendered by replica ' + replica,
    });
  }
  @Action({ concurrency: 'identity' }) async exportAll(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, exportDelay));
  }
}

/**
 * A tenant-private feed: its channel and data are scoped to the guest's
 * tenant, so announcements in one tenant never reach another tenant's
 * browsers on any replica.
 */
@LiveComponent({ name: 'tenant-feed', view: 'tenant-feed' })
export class TenantFeed {
  constructor(
    @Inject(SharedTotal) private readonly shared: SharedTotal,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
    @Inject(REQUEST) private readonly request: unknown,
  ) {}
  @State() sent = 0;
  @RealtimeChannels() channels(): string[] {
    return [tenantChannel(guestOf(this.request).tenant)];
  }
  @Computed() get tenant(): string {
    return guestOf(this.request).tenant;
  }
  @Computed({ async: true }) async notices(): Promise<number> {
    return this.shared.notices(guestOf(this.request).tenant);
  }
  @Action() async announce(): Promise<void> {
    const guest = guestOf(this.request);
    this.sent++;
    await this.shared.announce(guest.tenant);
    await this.realtime.publish(
      tenantChannel(guest.tenant),
      { by: replica },
      { identity: { binding: guest.binding } },
    );
  }
}

const csp = `default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`;
@Controller()
class Pages {
  constructor(
    @Inject(SharedTotal) private readonly shared: SharedTotal,
    @Inject(LiveRuntime) private readonly live: LiveRuntime,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
    @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('home')
  async home(
    @Req() request: GuestRequest,
    @Res({ passthrough: true }) response: object,
    @Query('tenant') tenant?: string,
  ) {
    // Issue the signed guest cookie on first visit; never trust an unsigned
    // one. The platform adapter sets the header on Express and Fastify alike.
    const header = request.headers.cookie;
    const existing = guestFromCookie(identitySecret, header);
    if (existing) request.nvGuest = existing;
    else {
      // A first visit may choose its tenant (`/?tenant=acme`); it is signed
      // into the cookie and cannot change afterwards.
      const issued = issueGuest(
        identitySecret,
        typeof tenant === 'string' && tenantPattern.test(tenant)
          ? tenant
          : 'public',
      );
      request.nvGuest = issued.guest;
      this.host.httpAdapter.setHeader(response, 'Set-Cookie', issued.cookie);
    }
    return {
      title: 'Distributed Live board',
      replica,
      widget: await this.live.mount(ReplicaBoard, request),
      feed: await this.live.mount(TenantFeed, request),
    };
  }
  /**
   * Liveness: the process is up and its event loop answers. It checks no
   * dependency, so a Redis outage never makes an orchestrator restart every
   * replica at once (restarting cannot fix Redis).
   */
  @Get('healthz')
  @Header('Cache-Control', 'no-store')
  liveness() {
    return { status: 'ok', replica };
  }
  /**
   * Readiness: 200 only while the shared Live store and the realtime broker
   * answer (and the broker's channel subscriptions are live); 503 otherwise,
   * so a load balancer stops routing new requests to this replica until
   * Redis is back. Each check is bounded by READINESS_TIMEOUT_MS.
   */
  @Get('readyz')
  @Header('Cache-Control', 'no-store')
  async readinessProbe() {
    const checks = await readiness();
    const ready = Object.values(checks).every(
      (value) => value === 'ok' || value === 'memory',
    );
    if (!ready)
      throw new ServiceUnavailableException({ status: 'unready', checks });
    return { status: 'ready', replica, checks };
  }
  /** Local connection counts (for leak checks in tests). */
  @Get('api/health')
  @Header('Cache-Control', 'no-store')
  health() {
    return {
      status: 'ok',
      replica,
      adapter,
      distributed: redis !== undefined,
      connections: this.realtime.hub.size,
      transports: this.realtime.transports,
    };
  }
  /**
   * Acceptance-only (ACCEPTANCE_LOAD_TOOLS=1, otherwise 404): publish `count`
   * (1-500) padded board events numbered from `offset` from this replica,
   * for the slow-subscriber scenario and the load smoke. Payloads are padded
   * to `bytes` (0-15000, default 15000), under the 16 KiB event limit.
   */
  @Post('api/load/broadcast')
  @Header('Cache-Control', 'no-store')
  async broadcast(
    @Query('count') count?: string,
    @Query('offset') offset?: string,
    @Query('bytes') bytes?: string,
  ) {
    if (!loadTools) throw new NotFoundException();
    const total = Math.min(Math.max(Math.trunc(Number(count)) || 1, 1), 500);
    const first = Math.min(Math.max(Math.trunc(Number(offset)) || 0, 0), 1e6);
    const size =
      bytes === undefined
        ? 15_000
        : Math.min(Math.max(Math.trunc(Number(bytes)) || 0, 0), 15_000);
    const pad = 'x'.repeat(size);
    for (let index = 0; index < total; index++) {
      // `at` lets the load smoke measure delivery latency (same host clock).
      await this.realtime.publish(boardChannel, {
        load: first + index,
        at: Date.now(),
        pad,
      });
      // Yield between publishes: one 500-event request (7.5 MB) in a single
      // turn would exceed maxQueuedBytes (4 MiB) of this replica's own
      // subscribers, which receive local publishes synchronously.
      await new Promise((resolve) => setImmediate(resolve));
    }
    return { published: total, replica };
  }
  /** Side-effect count of the idempotent `pay` action (all replicas). */
  @Get('api/charges')
  @Header('Cache-Control', 'no-store')
  async charges() {
    return { charges: await this.shared.charges() };
  }
}

const root = fileURLToPath(new URL('../views', import.meta.url));
@Module({
  imports: [
    SharedModule,
    RealtimeModule.forRoot({
      secrets: [realtimeSecret],
      origin,
      // Presence across replicas; a crashed replica's viewers lapse by TTL.
      ...(realtimeRedis ?? { broker }),
      resolveIdentity: (request) => ({ binding: guestOf(request).binding }),
      resolveUpgradeIdentity: (request) => ({
        binding: guestOf(request).binding,
      }),
      authorizeChannel: (identity, channel) => {
        if (channel === boardChannel) return true;
        const tenant = tenantOf(identity.binding);
        return tenant !== undefined && channel === tenantChannel(tenant);
      },
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
        components: [ReplicaBoard, TenantFeed],
        imports: [SharedModule],
        inject: [RealtimeService],
        useFactory: (realtime: RealtimeService) => ({
          origin,
          realtime,
          ...(liveStore ? { store: liveStore } : {}),
          resolveIdentity(request: object) {
            const guest = guestOf(request);
            return { binding: guest.binding, csrfToken: guest.csrf };
          },
          authorize: (_identity, component, action) =>
            (component === 'replica-board' &&
              [
                '$mount',
                '$sync',
                'increment',
                'pay',
                'receipt',
                'exportAll',
              ].includes(action)) ||
            (component === 'tenant-feed' &&
              ['$mount', '$sync', 'announce'].includes(action)),
        }),
      },
    ),
  ],
  controllers: [Pages],
})
class AppModule {}

const app =
  adapter === 'fastify'
    ? await NestFactory.create(AppModule, new FastifyAdapter(), {
        logger: ['error', 'warn'],
      })
    : await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
await configureNestvexa(app);
await attachRealtimeWebSocket(app);
app.enableShutdownHooks();
await app.listen(port, '127.0.0.1');
console.log(
  `Distributed Live replica ${replica} on ${adapter} (${redis ? 'Redis' : 'standalone'}): ${await app.getUrl()}`,
);
