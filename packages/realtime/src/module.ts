import {
  Controller,
  Get,
  Header,
  HttpException,
  Inject,
  Injectable,
  Module,
  Query,
  Req,
  StreamableFile,
} from '@nestjs/common';
import type {
  DynamicModule,
  INestApplication,
  InjectionToken,
  BeforeApplicationShutdown,
  OnApplicationShutdown,
  OptionalFactoryDependency,
  Type,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { PassThrough } from 'node:stream';
import { MemoryRealtimeBroker } from './broker.js';
import type { RealtimeBroker, RealtimeEvent } from './broker.js';
import { presenceMember, RealtimeHub, RealtimeRejection } from './hub.js';
import type {
  HubLimits,
  PresenceMember,
  PresenceSnapshot,
  RealtimeCloseReason,
  RealtimeIdentity,
  RealtimeSink,
} from './hub.js';
import type { PresenceEntry, RealtimePresenceOptions } from './presence.js';
import { createTokenSigner, parseChannel } from './token.js';
import type { TokenSigner } from './token.js';

export const REALTIME_OPTIONS = Symbol('nv:realtime-options');
/** Server transports, in preference order for `auto` clients. */
export type RealtimeTransportName = 'websocket' | 'sse' | 'polling';
export interface RealtimeModuleOptions {
  /** HMAC secrets (≥32 bytes); the first signs, all verify (rotation). */
  readonly secrets: readonly string[];
  /** Exact public origin; WebSocket upgrades from other origins are refused. */
  readonly origin: string;
  readonly resolveIdentity: (
    request: object,
  ) => RealtimeIdentity | Promise<RealtimeIdentity>;
  readonly authorizeChannel: (
    identity: RealtimeIdentity,
    channel: string,
  ) => boolean | Promise<boolean>;
  /**
   * Optional public presence descriptor per connected identity (for example
   * `{ id: user.publicId, label: user.displayName }`). Never return the binding.
   */
  readonly describePresence?: (
    identity: RealtimeIdentity,
  ) => PresenceMember | undefined | Promise<PresenceMember | undefined>;
  /** WebSocket identity from the raw upgrade request (session middleware does not run there). */
  readonly resolveUpgradeIdentity?: (
    request: IncomingMessage,
  ) => RealtimeIdentity | Promise<RealtimeIdentity>;
  readonly broker?: RealtimeBroker;
  /**
   * Shared presence across replicas (for example `RedisPresenceStore`).
   * Without it `presence()` reports this replica's connections only.
   */
  readonly presence?: RealtimePresenceOptions;
  /**
   * Transports this server offers, in the order `auto` clients try them
   * (default `['websocket', 'sse', 'polling']`). `websocket` is advertised
   * only after `attachRealtimeWebSocket`; disabled routes answer 404.
   */
  readonly transports?: readonly RealtimeTransportName[];
  readonly endpoint?: string;
  readonly tokenTtlMs?: number;
  readonly limits?: Partial<HubLimits>;
}
const defaults: Required<HubLimits> = {
  maxConnections: 1000,
  maxConnectionsPerIdentity: 8,
  queueLimit: 64,
  heartbeatMs: 15_000,
  revalidateMs: 30_000,
  subscribesPerMinute: 60,
  publishesPerMinute: 120,
  maxPresenceMembers: 100,
};
function endpointOf(value: string | undefined): string {
  const endpoint = value ?? '/_nestvexa/realtime';
  if (
    !/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(endpoint) ||
    endpoint.length > 256
  )
    throw new Error('Invalid realtime endpoint');
  return endpoint;
}
function validate(options: RealtimeModuleOptions): HubLimits {
  const origin = new URL(options.origin);
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.origin !== options.origin
  )
    throw new Error('Realtime origin must be an exact HTTP(S) origin');
  if (
    typeof options.resolveIdentity !== 'function' ||
    typeof options.authorizeChannel !== 'function' ||
    (options.describePresence !== undefined &&
      typeof options.describePresence !== 'function')
  )
    throw new Error(
      'Realtime identity and channel authorization policies are required',
    );
  const limits = { ...defaults, ...options.limits };
  for (const [name, value] of Object.entries(limits))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`Invalid realtime limit ${name}`);
  if (limits.heartbeatMs < 1000 || limits.revalidateMs < 1000)
    throw new Error(
      'Realtime heartbeat and revalidation must be at least 1 second',
    );
  const transports = options.transports ?? allTransports;
  if (
    !Array.isArray(transports) ||
    !transports.length ||
    new Set(transports).size !== transports.length ||
    transports.some((name) => !allTransports.includes(name))
  )
    throw new Error(
      'Realtime transports must be a non-empty list of websocket, sse, polling',
    );
  const presence = options.presence;
  if (presence !== undefined) {
    const store: unknown = presence.store;
    const ttl = presence.ttlMs ?? 30_000;
    if (
      !store ||
      typeof store !== 'object' ||
      ['write', 'remove', 'read', 'close'].some(
        (name) => typeof Reflect.get(store, name) !== 'function',
      )
    )
      throw new Error('Realtime presence store must implement PresenceStore');
    if (!Number.isSafeInteger(ttl) || ttl < 3000 || ttl > 600_000)
      throw new Error('Realtime presence ttlMs must be 3000–600000');
  }
  return limits;
}
const allTransports: readonly RealtimeTransportName[] = [
  'websocket',
  'sse',
  'polling',
];
/** Services whose app has the WebSocket transport attached. */
const websocketAttached = new WeakSet<object>();
function byId(a: PresenceMember, b: PresenceMember): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Publish events, sign subscriptions and revoke connections from host code. */
@Injectable()
export class RealtimeService
  implements BeforeApplicationShutdown, OnApplicationShutdown
{
  readonly hub: RealtimeHub;
  readonly broker: RealtimeBroker;
  readonly signer: TokenSigner;
  readonly endpoint: string;
  /** This process's id in shared presence. */
  readonly replica = randomUUID();
  readonly #limits: HubLimits;
  readonly #dirty = new Set<string>();
  readonly #published = new Set<string>();
  #flushTimer: ReturnType<typeof setTimeout> | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #flushing: Promise<void> = Promise.resolve();
  constructor(
    @Inject(REALTIME_OPTIONS) readonly options: RealtimeModuleOptions,
  ) {
    this.#limits = validate(options);
    this.endpoint = endpointOf(options.endpoint);
    this.broker = options.broker ?? new MemoryRealtimeBroker();
    this.signer = createTokenSigner({
      secrets: options.secrets,
      ...(options.tokenTtlMs === undefined
        ? {}
        : { ttlMs: options.tokenTtlMs }),
    });
    const shared = options.presence;
    this.hub = new RealtimeHub(
      this.broker,
      this.signer,
      options,
      this.#limits,
      shared ? { onPresenceChange: (channel) => this.#changed(channel) } : {},
    );
    if (shared) {
      // Rewrite live entries every third of the TTL so they never lapse
      // while this replica runs, and lapse soon after it stops.
      this.#heartbeat = setInterval(
        () => this.#flush([...this.#published, ...this.hub.presenceChannels()]),
        Math.floor((shared.ttlMs ?? 30_000) / 3),
      );
      this.#heartbeat.unref();
    }
  }
  /**
   * Transports clients may use now, in preference order. Served to `auto`
   * clients at `GET <endpoint>/negotiate`.
   */
  get transports(): readonly RealtimeTransportName[] {
    return Object.freeze(
      (this.options.transports ?? allTransports).filter(
        (name) => name !== 'websocket' || websocketAttached.has(this),
      ),
    );
  }
  #changed(channel: string): void {
    this.#dirty.add(channel);
    this.#flushTimer ??= setTimeout(() => {
      this.#flushTimer = undefined;
      this.#flush([...this.#dirty]);
    }, 50);
    this.#flushTimer.unref();
  }
  /** Write this replica's presence for `channels`, one batch at a time. */
  #flush(channels: readonly string[]): void {
    const shared = this.options.presence;
    if (!shared) return;
    const ttl = shared.ttlMs ?? 30_000;
    this.#flushing = this.#flushing.then(async () => {
      for (const channel of new Set(channels)) {
        this.#dirty.delete(channel);
        const local = this.hub.presence(channel);
        try {
          if (local.total) {
            await shared.store.write(
              this.replica,
              channel,
              { members: local.members, total: local.total },
              ttl,
            );
            this.#published.add(channel);
          } else if (this.#published.delete(channel))
            await shared.store.remove(this.replica, channel);
        } catch {
          // Store outage: entries lapse by TTL; the heartbeat rewrites them.
        }
      }
    });
  }
  /**
   * Invalidate subscribers of a channel. `data` is public JSON (≤16 KiB).
   * Pass the acting `identity` for user-triggered publishes: it is charged
   * against `limits.publishesPerMinute` and rejected with 429 beyond it.
   */
  async publish(
    channel: string,
    data: unknown = null,
    options: { readonly identity?: RealtimeIdentity } = {},
  ): Promise<RealtimeEvent> {
    if (
      options.identity !== undefined &&
      !this.hub.takePublish(options.identity)
    )
      throw new HttpException({ statusCode: 429, code: 'RATE_LIMITED' }, 429);
    return this.broker.publish(channel, data);
  }
  /**
   * Members connected to `channel`, for a reader who may read the channel now
   * (403 otherwise). With a `presence` store the result merges every live
   * replica's entry; without one (or while the store is unreachable) it
   * covers this replica's connections only.
   */
  async presence(
    identity: RealtimeIdentity,
    channel: string,
  ): Promise<PresenceSnapshot> {
    const name = parseChannel(channel);
    if (!(await this.options.authorizeChannel(identity, name)))
      throw new HttpException(
        { statusCode: 403, code: 'CHANNEL_FORBIDDEN' },
        403,
      );
    const local = this.hub.presence(name);
    const shared = this.options.presence;
    if (!shared) return local;
    let entries: readonly PresenceEntry[];
    try {
      entries = await shared.store.read(name);
    } catch {
      return local;
    }
    const members = new Map<string, PresenceMember>();
    for (const member of local.members) members.set(member.id, member);
    let total = local.total;
    let truncated = local.truncated;
    for (const entry of entries.slice(0, 1024)) {
      if (entry.replica === this.replica) continue;
      let listed: PresenceMember[];
      try {
        // Store contents are untrusted: re-validate every descriptor.
        listed = (Array.isArray(entry.members) ? entry.members : [])
          .slice(0, 1024)
          .flatMap((value) => presenceMember(value) ?? []);
      } catch {
        continue;
      }
      if (!Number.isSafeInteger(entry.total) || entry.total < listed.length)
        continue;
      for (const member of listed) members.set(member.id, member);
      if (entry.total > listed.length) truncated = true;
      total = Math.max(total, entry.total);
    }
    const sorted = [...members.values()].sort(byId);
    const max = this.#limits.maxPresenceMembers ?? 100;
    return Object.freeze({
      channel: name,
      members: Object.freeze(sorted.slice(0, max)),
      // Exact unless a replica truncated its entry (then a lower bound).
      total: Math.max(total, sorted.length),
      truncated: truncated || sorted.length > max,
    });
  }
  /**
   * Sign a subscription token for the channels this identity may read now.
   * Unauthorized channels are omitted; no token is returned when none remain.
   */
  async sign(
    identity: RealtimeIdentity,
    channels: readonly string[],
  ): Promise<string | undefined> {
    const allowed: string[] = [];
    for (const channel of new Set(channels.map(parseChannel)))
      if (await this.options.authorizeChannel(identity, channel))
        allowed.push(channel);
    return allowed.length
      ? this.signer.sign(identity.binding, allowed)
      : undefined;
  }
  revoke(binding: string): number {
    return this.hub.revoke(binding);
  }
  closeChannel(channel: string): void {
    this.hub.closeChannel(channel);
  }
  /**
   * End every stream before Nest closes the HTTP server: open SSE, long-poll
   * and WebSocket connections would otherwise hold the server open.
   */
  beforeApplicationShutdown(): void {
    this.hub.shutdown();
  }
  async onApplicationShutdown(): Promise<void> {
    this.hub.shutdown();
    clearInterval(this.#heartbeat);
    clearTimeout(this.#flushTimer);
    const shared = this.options.presence;
    if (shared) {
      await this.#flushing;
      // Graceful exit removes this replica's entries; a crash relies on TTL.
      await Promise.allSettled(
        [...this.#published].map((channel) =>
          shared.store.remove(this.replica, channel),
        ),
      );
      this.#published.clear();
      await shared.store.close().catch(() => undefined);
    }
    await this.broker.close();
  }
}

function tokensOf(value: unknown): string[] {
  const list = Array.isArray(value)
    ? value
    : value === undefined
      ? []
      : [value];
  if (list.length > 32 || list.some((item) => typeof item !== 'string'))
    throw new HttpException(
      { statusCode: 400, code: 'INVALID_SUBSCRIPTION' },
      400,
    );
  return list as string[];
}
/** Cursor = base64url JSON map of channel → last delivered event id. */
function parseCursor(value: unknown): Map<string, string> {
  const cursor = new Map<string, string>();
  if (typeof value !== 'string' || !value || value.length > 4096) return cursor;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      for (const [channel, id] of Object.entries(parsed))
        if (typeof id === 'string' && id.length <= 128)
          cursor.set(parseChannel(channel), id);
  } catch {
    return new Map();
  }
  return cursor;
}
function encodeCursor(cursor: ReadonlyMap<string, string>): string {
  return Buffer.from(JSON.stringify(Object.fromEntries(cursor))).toString(
    'base64url',
  );
}
function rejection(error: unknown): never {
  if (error instanceof RealtimeRejection)
    throw new HttpException(
      { statusCode: error.status, code: error.code },
      error.status,
    );
  throw error;
}
function offered(service: RealtimeService, name: RealtimeTransportName): void {
  if (!(service.options.transports ?? allTransports).includes(name))
    throw new HttpException(
      { statusCode: 404, code: 'TRANSPORT_DISABLED' },
      404,
    );
}
function rawRequest(value: object): IncomingMessage {
  const raw: unknown = Reflect.get(value, 'raw');
  return (raw ?? value) as IncomingMessage;
}

function controller(endpoint: string): Type<object> {
  @Controller(endpoint)
  class RealtimeController {
    constructor(
      @Inject(RealtimeService) private readonly service: RealtimeService,
    ) {}
    /** Capability negotiation for `auto` clients: transports in preference order. */
    @Get('negotiate')
    @Header('Cache-Control', 'no-store')
    negotiate(): { transports: readonly RealtimeTransportName[] } {
      return { transports: this.service.transports };
    }
    /** Server-Sent Events stream. EventSource resends the last `id` as Last-Event-ID. */
    @Get('sse')
    @Header('Cache-Control', 'no-store')
    @Header('X-Accel-Buffering', 'no')
    @Header('X-Content-Type-Options', 'nosniff')
    async sse(
      @Req() request: object,
      @Query('t') tokens: unknown,
    ): Promise<StreamableFile> {
      offered(this.service, 'sse');
      const raw = rawRequest(request);
      const header = raw.headers['last-event-id'];
      const cursor = parseCursor(
        typeof header === 'string' ? header : undefined,
      );
      const stream = new PassThrough({ highWaterMark: 16_384 });
      let closed = false;
      const sink: RealtimeSink = {
        send(event) {
          if (closed) return true;
          cursor.set(event.channel, event.id);
          stream.write(
            `id: ${encodeCursor(cursor)}\nevent: invalidate\ndata: ${JSON.stringify(
              {
                channel: event.channel,
                id: event.id,
                data: event.data,
              },
            )}\n\n`,
          );
          return stream.writableLength < 262_144;
        },
        heartbeat() {
          if (!closed) stream.write(': ping\n\n');
        },
        close(reason: RealtimeCloseReason) {
          if (closed) return;
          closed = true;
          stream.end(`event: close\ndata: ${JSON.stringify({ reason })}\n\n`);
        },
      };
      let subscription: Awaited<ReturnType<RealtimeHub['connect']>>;
      try {
        subscription = await this.service.hub.connect(
          () => this.service.options.resolveIdentity(request),
          tokensOf(tokens),
          sink,
          cursor,
        );
      } catch (error) {
        rejection(error);
      }
      stream.write(
        `retry: 3000\nevent: ready\ndata: ${JSON.stringify({ channels: subscription.channels })}\n\n`,
      );
      raw.once('close', () => {
        closed = true;
        subscription.close();
        stream.end();
      });
      return new StreamableFile(stream, {
        type: 'text/event-stream; charset=utf-8',
        disposition: 'inline',
      });
    }
    /** Long-polling fallback: waits up to 25 s for events after `cursor`. */
    @Get('poll')
    @Header('Cache-Control', 'no-store')
    async poll(
      @Req() request: object,
      @Query('t') tokens: unknown,
      @Query('cursor') cursorValue: unknown,
    ): Promise<{
      events: RealtimeEvent[];
      cursor: string;
      channels: readonly string[];
    }> {
      offered(this.service, 'polling');
      const cursor = parseCursor(cursorValue);
      const events: RealtimeEvent[] = [];
      let finish: () => void = () => undefined;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let batch: ReturnType<typeof setTimeout> | undefined;
      const sink: RealtimeSink = {
        send(event) {
          events.push(event);
          cursor.set(event.channel, event.id);
          batch ??= setTimeout(finish, 25);
          return events.length < 64;
        },
        heartbeat() {},
        close: () => finish(),
      };
      let subscription: Awaited<ReturnType<RealtimeHub['connect']>>;
      try {
        subscription = await this.service.hub.connect(
          () => this.service.options.resolveIdentity(request),
          tokensOf(tokens),
          sink,
          cursor,
        );
      } catch (error) {
        rejection(error);
      }
      const timeout = setTimeout(finish, 25_000);
      rawRequest(request).once('close', finish);
      await done;
      clearTimeout(timeout);
      if (batch) clearTimeout(batch);
      subscription.close();
      // A new client starts from the current position without replaying history.
      if (!cursorValue)
        for (const channel of subscription.channels)
          if (!cursor.has(channel)) cursor.set(channel, '');
      return {
        events,
        cursor: encodeCursor(cursor),
        channels: subscription.channels,
      };
    }
  }
  return RealtimeController;
}

export interface RealtimeModuleAsyncOptions<
  Dependencies extends unknown[] = unknown[],
> {
  readonly endpoint?: string;
  readonly imports?: DynamicModule['imports'];
  readonly inject?: (InjectionToken | OptionalFactoryDependency)[];
  readonly useFactory: (
    ...dependencies: Dependencies
  ) => RealtimeModuleOptions | Promise<RealtimeModuleOptions>;
}

/** Opt-in realtime routes; the default Nestvexa install does not load this module. */
@Module({})
export class RealtimeModule {
  static forRoot(options: RealtimeModuleOptions): DynamicModule {
    validate(options);
    return {
      module: RealtimeModule,
      global: true,
      controllers: [controller(endpointOf(options.endpoint))],
      providers: [
        { provide: REALTIME_OPTIONS, useValue: options },
        RealtimeService,
      ],
      exports: [RealtimeService],
    };
  }
  static forRootAsync<Dependencies extends unknown[]>(
    options: RealtimeModuleAsyncOptions<Dependencies>,
  ): DynamicModule {
    const endpoint = endpointOf(options.endpoint);
    return {
      module: RealtimeModule,
      global: true,
      imports: options.imports ?? [],
      controllers: [controller(endpoint)],
      providers: [
        {
          provide: REALTIME_OPTIONS,
          inject: options.inject ?? [],
          useFactory: async (...dependencies: Dependencies) => {
            const resolved = await options.useFactory(...dependencies);
            validate(resolved);
            if (endpointOf(resolved.endpoint ?? endpoint) !== endpoint)
              throw new Error('Realtime endpoint must be static');
            return { ...resolved, endpoint };
          },
        },
        RealtimeService,
      ],
      exports: [RealtimeService],
    };
  }
}

/**
 * Attach the optional WebSocket transport (`ws` peer) at `<endpoint>/ws`.
 * The first client message must be `{"tokens":[...],"cursor":"..."}` within 5 s.
 */
export async function attachRealtimeWebSocket(
  app: INestApplication,
): Promise<() => void> {
  const service = app.get(RealtimeService);
  const resolveUpgrade = service.options.resolveUpgradeIdentity;
  if (!resolveUpgrade)
    throw new Error('WebSocket transport requires resolveUpgradeIdentity');
  if (!(service.options.transports ?? allTransports).includes('websocket'))
    throw new Error('WebSocket transport is disabled by the transports option');
  const candidate: unknown = app.getHttpServer();
  // Startup detection: Express and Fastify expose Node's http.Server; an
  // adapter without upgrade events cannot carry WebSockets.
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    typeof Reflect.get(candidate, 'on') !== 'function' ||
    typeof Reflect.get(candidate, 'off') !== 'function'
  )
    throw new Error(
      'WebSocket transport requires a Node HTTP server (Express or Fastify adapter)',
    );
  const { WebSocketServer } = await import('ws');
  const server = new WebSocketServer({ noServer: true, maxPayload: 65_536 });
  const http = candidate as {
    on(
      event: 'upgrade',
      listener: (
        request: IncomingMessage,
        socket: Duplex,
        head: Buffer,
      ) => void,
    ): void;
    off(
      event: 'upgrade',
      listener: (
        request: IncomingMessage,
        socket: Duplex,
        head: Buffer,
      ) => void,
    ): void;
  };
  const path = `${service.endpoint}/ws`;
  const upgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    const url = new URL(request.url ?? '/', 'http://nestvexa.invalid');
    if (url.pathname !== path) return;
    // Cross-site WebSocket hijacking defense: browsers always send Origin.
    if (request.headers.origin !== service.options.origin) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    server.handleUpgrade(request, socket, head, (ws) => {
      let subscription: { close(): void } | undefined;
      let open = true;
      const sink: RealtimeSink = {
        send(event) {
          if (!open) return true;
          ws.send(
            JSON.stringify({
              type: 'invalidate',
              channel: event.channel,
              id: event.id,
              data: event.data,
            }),
          );
          return ws.bufferedAmount < 262_144;
        },
        heartbeat() {
          if (open) ws.ping();
        },
        close(reason) {
          if (!open) return;
          open = false;
          ws.close(4000, reason);
        },
      };
      const timer = setTimeout(() => sink.close('forbidden'), 5000);
      ws.once('message', (message: Buffer) => {
        clearTimeout(timer);
        void (async () => {
          try {
            const parsed: unknown = JSON.parse(message.toString('utf8'));
            const tokens =
              parsed && typeof parsed === 'object'
                ? Reflect.get(parsed, 'tokens')
                : undefined;
            const cursor =
              parsed && typeof parsed === 'object'
                ? Reflect.get(parsed, 'cursor')
                : undefined;
            subscription = await service.hub.connect(
              () => resolveUpgrade(request),
              tokensOf(tokens),
              sink,
              parseCursor(cursor),
            );
            if (open) ws.send(JSON.stringify({ type: 'ready' }));
            else subscription.close();
          } catch (error) {
            const code =
              error instanceof RealtimeRejection
                ? error.code
                : 'INVALID_SUBSCRIPTION';
            if (open) {
              open = false;
              ws.close(4003, code);
            }
          }
        })();
      });
      ws.on('close', () => {
        open = false;
        clearTimeout(timer);
        subscription?.close();
      });
      ws.on('error', () => ws.terminate());
    });
  };
  http.on('upgrade', upgrade);
  websocketAttached.add(service);
  return () => {
    websocketAttached.delete(service);
    http.off('upgrade', upgrade);
    for (const client of server.clients) client.terminate();
    server.close();
  };
}
