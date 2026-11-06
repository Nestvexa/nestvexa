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
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { PassThrough } from 'node:stream';
import { MemoryRealtimeBroker } from './broker.js';
import type { RealtimeBroker, RealtimeEvent } from './broker.js';
import { RealtimeHub, RealtimeRejection } from './hub.js';
import type {
  HubLimits,
  PresenceMember,
  PresenceSnapshot,
  RealtimeCloseReason,
  RealtimeIdentity,
  RealtimeSink,
} from './hub.js';
import { createTokenSigner, parseChannel } from './token.js';
import type { TokenSigner } from './token.js';

export const REALTIME_OPTIONS = Symbol('nv:realtime-options');
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
  return limits;
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
  constructor(
    @Inject(REALTIME_OPTIONS) readonly options: RealtimeModuleOptions,
  ) {
    const limits = validate(options);
    this.endpoint = endpointOf(options.endpoint);
    this.broker = options.broker ?? new MemoryRealtimeBroker();
    this.signer = createTokenSigner({
      secrets: options.secrets,
      ...(options.tokenTtlMs === undefined
        ? {}
        : { ttlMs: options.tokenTtlMs }),
    });
    this.hub = new RealtimeHub(this.broker, this.signer, options, limits);
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
   * Members connected to `channel` on this replica, for a reader who may read
   * the channel now (403 otherwise). Presence is per process: with several
   * replicas each one reports its own connections.
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
    return this.hub.presence(name);
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
    /** Server-Sent Events stream. EventSource resends the last `id` as Last-Event-ID. */
    @Get('sse')
    @Header('Cache-Control', 'no-store')
    @Header('X-Accel-Buffering', 'no')
    @Header('X-Content-Type-Options', 'nosniff')
    async sse(
      @Req() request: object,
      @Query('t') tokens: unknown,
    ): Promise<StreamableFile> {
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
  const { WebSocketServer } = await import('ws');
  const server = new WebSocketServer({ noServer: true, maxPayload: 65_536 });
  const http = app.getHttpServer() as {
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
  return () => {
    http.off('upgrade', upgrade);
    for (const client of server.clients) client.terminate();
    server.close();
  };
}
