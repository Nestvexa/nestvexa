import { createHash } from 'node:crypto';
import type { RealtimeBroker, RealtimeEvent } from './broker.js';
import { parseChannel, RealtimeTokenError } from './token.js';
import type { TokenSigner } from './token.js';

export interface RealtimeIdentity {
  readonly binding: string;
}
export type IdentityResolver = () =>
  RealtimeIdentity | Promise<RealtimeIdentity>;
export interface RealtimePolicy {
  /** Re-checked on subscribe, periodically and before delivery (cached per revalidation window). */
  readonly authorizeChannel: (
    identity: RealtimeIdentity,
    channel: string,
  ) => boolean | Promise<boolean>;
}
export interface HubLimits {
  readonly maxConnections: number;
  readonly maxConnectionsPerIdentity: number;
  readonly queueLimit: number;
  readonly heartbeatMs: number;
  readonly revalidateMs: number;
}
/** Transport-specific writer. `send` returns false when the client cannot keep up. */
export interface RealtimeSink {
  send(event: RealtimeEvent): boolean;
  heartbeat(): void;
  close(reason: RealtimeCloseReason): void;
}
export type RealtimeCloseReason =
  'revoked' | 'expired' | 'forbidden' | 'slow-consumer' | 'shutdown' | 'client';
export class RealtimeRejection extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 429 | 503,
    readonly code: string,
  ) {
    super(code);
    this.name = 'RealtimeRejection';
  }
}

interface Connection {
  readonly identity: RealtimeIdentity;
  readonly identityKey: string;
  readonly resolve: IdentityResolver;
  readonly channels: ReadonlySet<string>;
  readonly sink: RealtimeSink;
  readonly expiresAt: number;
  readonly authorized: Map<string, number>;
  pending: number;
  /** Sequential delivery preserves event order per connection. */
  chain: Promise<void>;
  closed: boolean;
  timers: ReturnType<typeof setInterval>[];
}
function key(binding: string): string {
  return createHash('sha256').update(binding).digest('base64url');
}

/**
 * Owns live subscriptions. One broker subscription per channel is shared by all
 * local connections and released with the last one.
 */
export class RealtimeHub {
  readonly #connections = new Set<Connection>();
  readonly #channels = new Map<
    string,
    { readonly connections: Set<Connection>; release?: () => void }
  >();
  #closing = false;
  constructor(
    private readonly broker: RealtimeBroker,
    private readonly signer: TokenSigner,
    private readonly policy: RealtimePolicy,
    private readonly limits: HubLimits,
  ) {}
  get size(): number {
    return this.#connections.size;
  }
  async #identity(resolve: IdentityResolver): Promise<RealtimeIdentity> {
    let identity: RealtimeIdentity;
    try {
      identity = await resolve();
    } catch {
      throw new RealtimeRejection(401, 'IDENTITY_REQUIRED');
    }
    if (
      !identity ||
      typeof identity.binding !== 'string' ||
      identity.binding.length < 16 ||
      identity.binding.length > 1024
    )
      throw new RealtimeRejection(401, 'IDENTITY_REQUIRED');
    return Object.freeze({ binding: identity.binding });
  }
  /** Verify tokens and current authorization, then attach a transport sink. */
  async connect(
    resolve: IdentityResolver,
    tokens: readonly string[],
    sink: RealtimeSink,
    lastEventIds: ReadonlyMap<string, string> = new Map(),
  ): Promise<{ readonly channels: readonly string[]; close(): void }> {
    if (this.#closing) throw new RealtimeRejection(503, 'REALTIME_SHUTDOWN');
    if (!Array.isArray(tokens) || !tokens.length || tokens.length > 32)
      throw new RealtimeRejection(400, 'INVALID_SUBSCRIPTION');
    const identity = await this.#identity(resolve);
    const channels = new Set<string>();
    let expiresAt = Number.MAX_SAFE_INTEGER;
    for (const token of tokens) {
      try {
        const claims = this.signer.verify(token, identity.binding);
        for (const channel of claims.channels) channels.add(channel);
        expiresAt = Math.min(expiresAt, claims.expiresAt);
      } catch (error) {
        throw new RealtimeRejection(
          error instanceof RealtimeTokenError ? 403 : 400,
          'INVALID_SUBSCRIPTION',
        );
      }
    }
    if (channels.size > 64)
      throw new RealtimeRejection(400, 'TOO_MANY_CHANNELS');
    const now = Date.now();
    const authorized = new Map<string, number>();
    for (const channel of channels) {
      if (!(await this.policy.authorizeChannel(identity, channel)))
        throw new RealtimeRejection(403, 'CHANNEL_FORBIDDEN');
      authorized.set(channel, now);
    }
    if (this.#closing) throw new RealtimeRejection(503, 'REALTIME_SHUTDOWN');
    const identityKey = key(identity.binding);
    if (this.#connections.size >= this.limits.maxConnections)
      throw new RealtimeRejection(503, 'REALTIME_CAPACITY');
    let perIdentity = 0;
    for (const connection of this.#connections)
      if (connection.identityKey === identityKey) perIdentity++;
    if (perIdentity >= this.limits.maxConnectionsPerIdentity)
      throw new RealtimeRejection(429, 'TOO_MANY_CONNECTIONS');
    const connection: Connection = {
      identity,
      identityKey,
      resolve,
      channels,
      sink,
      expiresAt,
      authorized,
      pending: 0,
      chain: Promise.resolve(),
      closed: false,
      timers: [],
    };
    this.#connections.add(connection);
    try {
      for (const channel of channels) await this.#attach(channel, connection);
    } catch (error) {
      this.#close(connection, 'shutdown');
      throw error instanceof RealtimeRejection
        ? error
        : new RealtimeRejection(503, 'BROKER_UNAVAILABLE');
    }
    const heartbeat = setInterval(() => {
      if (!connection.closed) sink.heartbeat();
    }, this.limits.heartbeatMs);
    heartbeat.unref();
    const revalidate = setInterval(() => {
      void this.#revalidate(connection);
    }, this.limits.revalidateMs);
    revalidate.unref();
    connection.timers.push(heartbeat, revalidate);
    const expiry = Math.min(expiresAt - Date.now(), 2_147_483_647);
    const timer = setTimeout(
      () => this.#close(connection, 'expired'),
      Math.max(0, expiry),
    );
    timer.unref();
    connection.timers.push(timer as unknown as ReturnType<typeof setInterval>);
    // Replay missed events, then deliver live events through the same queue.
    for (const [channel, last] of lastEventIds)
      if (channels.has(channel))
        for (const event of this.broker.replay(channel, last))
          this.#enqueue(connection, event);
    return Object.freeze({
      channels: Object.freeze([...channels].sort()),
      close: () => this.#close(connection, 'client'),
    });
  }
  async #attach(channel: string, connection: Connection): Promise<void> {
    let entry = this.#channels.get(channel);
    if (!entry) {
      entry = { connections: new Set() };
      this.#channels.set(channel, entry);
      const target = entry;
      target.release = await this.broker.subscribe(channel, (event) => {
        for (const subscriber of [...target.connections])
          this.#enqueue(subscriber, event);
      });
    }
    entry.connections.add(connection);
  }
  #enqueue(connection: Connection, event: RealtimeEvent): void {
    if (connection.closed) return;
    if (connection.pending >= this.limits.queueLimit) {
      this.#close(connection, 'slow-consumer');
      return;
    }
    connection.pending++;
    connection.chain = connection.chain
      .then(() => this.#deliver(connection, event))
      .catch(() => this.#close(connection, 'forbidden'))
      .finally(() => {
        connection.pending--;
      });
  }
  async #deliver(connection: Connection, event: RealtimeEvent): Promise<void> {
    const checked = connection.authorized.get(event.channel) ?? 0;
    if (Date.now() - checked >= this.limits.revalidateMs) {
      let allowed: boolean;
      try {
        allowed = await this.policy.authorizeChannel(
          connection.identity,
          event.channel,
        );
      } catch {
        allowed = false;
      }
      if (!allowed) {
        this.#close(connection, 'forbidden');
        return;
      }
      connection.authorized.set(event.channel, Date.now());
    }
    if (connection.closed) return;
    if (Date.now() >= connection.expiresAt) {
      this.#close(connection, 'expired');
      return;
    }
    if (!connection.sink.send(event)) this.#close(connection, 'slow-consumer');
  }
  async #revalidate(connection: Connection): Promise<void> {
    if (connection.closed) return;
    try {
      const identity = await this.#identity(connection.resolve);
      if (key(identity.binding) !== connection.identityKey) {
        this.#close(connection, 'revoked');
        return;
      }
      for (const channel of connection.channels) {
        if (!(await this.policy.authorizeChannel(identity, channel))) {
          this.#close(connection, 'forbidden');
          return;
        }
        connection.authorized.set(channel, Date.now());
      }
    } catch {
      this.#close(connection, 'revoked');
    }
  }
  #close(connection: Connection, reason: RealtimeCloseReason): void {
    if (connection.closed) return;
    connection.closed = true;
    for (const timer of connection.timers) clearInterval(timer);
    this.#connections.delete(connection);
    for (const channel of connection.channels) {
      const entry = this.#channels.get(channel);
      if (!entry) continue;
      entry.connections.delete(connection);
      if (!entry.connections.size) {
        entry.release?.();
        this.#channels.delete(channel);
      }
    }
    try {
      connection.sink.close(reason);
    } catch {
      // A failed transport close must not prevent subscription cleanup.
    }
  }
  /** Close every connection for an identity binding, for example on logout. */
  revoke(binding: string): number {
    const identityKey = key(binding);
    let count = 0;
    for (const connection of [...this.#connections])
      if (connection.identityKey === identityKey) {
        this.#close(connection, 'revoked');
        count++;
      }
    return count;
  }
  /** Close subscriptions for one channel, for example after a permission change. */
  closeChannel(channel: string): void {
    const name = parseChannel(channel);
    for (const connection of [...(this.#channels.get(name)?.connections ?? [])])
      this.#close(connection, 'forbidden');
  }
  shutdown(): void {
    this.#closing = true;
    for (const connection of [...this.#connections])
      this.#close(connection, 'shutdown');
  }
}
