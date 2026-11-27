import { createHash } from 'node:crypto';
import type { RealtimeBroker, RealtimeEvent } from './broker.js';
import { parseChannel, RealtimeTokenError } from './token.js';
import type { TokenSigner } from './token.js';
import { kernelIdentityOf } from './kernel.js';
import type { RealtimeKernelPrincipal } from './kernel.js';
import { channelKind, startSpan } from './instrumentation.js';
import type {
  RealtimeInstrumentation,
  RealtimeSpan,
} from './instrumentation.js';

export interface RealtimeIdentity {
  readonly binding: string;
  /**
   * The kernel principal, set by realtime only when `kernelIdentity` is
   * configured (the binding is then scoped to the principal and tenant).
   */
  readonly principal?: RealtimeKernelPrincipal;
  /** The kernel tenant, set by realtime only when `kernelIdentity` is configured. */
  readonly tenant?: string;
}
export type IdentityResolver = () =>
  RealtimeIdentity | Promise<RealtimeIdentity>;
/** Public descriptor of a connected identity; never the binding itself. */
export interface PresenceMember {
  /** Stable public member id (1–128 of `A-Z a-z 0-9 _ . : @ -`). */
  readonly id: string;
  /** Optional public display label (≤128 characters). */
  readonly label?: string;
}
export interface PresenceSnapshot {
  readonly channel: string;
  /** Distinct members sorted by id, at most `maxPresenceMembers`. */
  readonly members: readonly PresenceMember[];
  /** Distinct members connected, before truncation. */
  readonly total: number;
  readonly truncated: boolean;
}
export interface RealtimePolicy {
  /** Re-checked on subscribe, periodically and before delivery (cached per revalidation window). */
  readonly authorizeChannel: (
    identity: RealtimeIdentity,
    channel: string,
  ) => boolean | Promise<boolean>;
  /**
   * Optional presence descriptor resolved once per connection. Identities for
   * which it returns undefined are connected but not listed.
   */
  readonly describePresence?: (
    identity: RealtimeIdentity,
  ) => PresenceMember | undefined | Promise<PresenceMember | undefined>;
}
export interface HubLimits {
  readonly maxConnections: number;
  readonly maxConnectionsPerIdentity: number;
  /** Undelivered events queued per connection; beyond it the connection closes (`slow-consumer`). */
  readonly queueLimit: number;
  /**
   * Bytes of undelivered events queued per connection (default 4 MiB).
   * Beyond it the connection closes as `slow-consumer`.
   */
  readonly maxQueuedBytes?: number;
  /**
   * How long a congested transport (buffer above its bound) may take to drain
   * before the connection closes as `slow-consumer` (default 10 000 ms).
   */
  readonly drainTimeoutMs?: number;
  readonly heartbeatMs: number;
  readonly revalidateMs: number;
  /** Subscription attempts per identity per minute (default 60). */
  readonly subscribesPerMinute?: number;
  /** Identity-attributed publishes per identity per minute (default 120). */
  readonly publishesPerMinute?: number;
  /** Members returned by one presence query (default 100). */
  readonly maxPresenceMembers?: number;
}
/** Transport-specific writer. `send` returns false when the client cannot keep up. */
export interface RealtimeSink {
  /** Write one event; false when the transport buffer is above its bound. */
  send(event: RealtimeEvent): boolean;
  /**
   * Optional drain signal, called once after `send` returned false. When the
   * sink implements it, the hub stops writing, keeps later events in the
   * connection's bounded queue (`queueLimit`, `maxQueuedBytes`) and resumes
   * when `listener` runs; a transport that does not drain within
   * `drainTimeoutMs` is closed as `slow-consumer`. Without it, false closes
   * the connection at once.
   */
  onDrain?(listener: () => void): void;
  heartbeat(): void;
  close(reason: RealtimeCloseReason): void;
}
export type RealtimeCloseReason =
  'revoked' | 'expired' | 'forbidden' | 'slow-consumer' | 'shutdown' | 'client';
export interface HubHooks {
  /** A member joined or left `channel` on this hub (presence changed). */
  readonly onPresenceChange?: (channel: string) => void;
}
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
  readonly member: PresenceMember | undefined;
  readonly expiresAt: number;
  readonly authorized: Map<string, number>;
  /** Undelivered events in order; the head is the one being delivered. */
  readonly queue: { readonly event: RealtimeEvent; readonly bytes: number }[];
  queuedBytes: number;
  /** Delivery is suspended on a policy lookup or a congested transport. */
  waiting: boolean;
  /** Closes a congested connection that did not drain in time. */
  drainTimer: ReturnType<typeof setTimeout> | undefined;
  closed: boolean;
  timers: ReturnType<typeof setInterval>[];
  /** Lifetime span, ended with the close reason. */
  readonly span: RealtimeSpan;
}
function key(binding: string): string {
  return createHash('sha256').update(binding).digest('base64url');
}
/** Approximate wire size of an event, charged against `maxQueuedBytes`. */
function eventBytes(event: RealtimeEvent): number {
  return (
    64 +
    event.channel.length +
    event.id.length +
    Buffer.byteLength(JSON.stringify(event.data) ?? 'null')
  );
}
/** Validate a public presence descriptor (also applied to entries read from a shared store). */
export function presenceMember(value: unknown): PresenceMember | undefined {
  if (value === undefined) return undefined;
  const id: unknown =
    value && typeof value === 'object' ? Reflect.get(value, 'id') : undefined;
  const label: unknown =
    value && typeof value === 'object'
      ? Reflect.get(value, 'label')
      : undefined;
  if (
    typeof id !== 'string' ||
    !/^[A-Za-z0-9_.:@-]{1,128}$/.test(id) ||
    (label !== undefined && (typeof label !== 'string' || label.length > 128))
  )
    throw new Error('Invalid realtime presence member');
  return Object.freeze(label === undefined ? { id } : { id, label });
}
/** Bounded fixed-window counters keyed by identity hash. */
class RateWindow {
  readonly #buckets = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly maxKeys = 10_000,
  ) {}
  /** Count one attempt; false once the identity exceeded its window budget. */
  take(identityKey: string, now = Date.now()): boolean {
    let bucket = this.#buckets.get(identityKey);
    if (bucket && now - bucket.start >= this.windowMs) {
      this.#buckets.delete(identityKey);
      bucket = undefined;
    }
    if (!bucket) {
      if (this.#buckets.size >= this.maxKeys)
        for (const [entry, value] of this.#buckets)
          if (now - value.start >= this.windowMs) this.#buckets.delete(entry);
      // Fail closed rather than grow without bound under an identity flood.
      if (this.#buckets.size >= this.maxKeys) return false;
      bucket = { start: now, count: 0 };
      this.#buckets.set(identityKey, bucket);
    }
    return ++bucket.count <= this.limit;
  }
  clear(): void {
    this.#buckets.clear();
  }
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
  readonly #subscribes: RateWindow;
  readonly #publishes: RateWindow;
  readonly #maxPresence: number;
  readonly #maxQueuedBytes: number;
  readonly #drainTimeoutMs: number;
  constructor(
    private readonly broker: RealtimeBroker,
    private readonly signer: TokenSigner,
    private readonly policy: RealtimePolicy,
    private readonly limits: HubLimits,
    /** Optional tracing hook (`nestvexa.realtime.*` spans); see `RealtimeModuleOptions`. */
    private readonly instrumentation?: RealtimeInstrumentation,
    private readonly hooks: HubHooks = {},
  ) {
    const positive = (value: number, name: string) => {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error(`Invalid realtime limit ${name}`);
      return value;
    };
    this.#subscribes = new RateWindow(
      positive(limits.subscribesPerMinute ?? 60, 'subscribesPerMinute'),
    );
    this.#publishes = new RateWindow(
      positive(limits.publishesPerMinute ?? 120, 'publishesPerMinute'),
    );
    this.#maxPresence = positive(
      limits.maxPresenceMembers ?? 100,
      'maxPresenceMembers',
    );
    this.#maxQueuedBytes = positive(
      limits.maxQueuedBytes ?? 4_194_304,
      'maxQueuedBytes',
    );
    this.#drainTimeoutMs = positive(
      limits.drainTimeoutMs ?? 10_000,
      'drainTimeoutMs',
    );
  }
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
    // Kernel fields come from the service resolver (never from the host's).
    const kernel = kernelIdentityOf(identity);
    if (!kernel) throw new RealtimeRejection(401, 'IDENTITY_REQUIRED');
    return Object.freeze({ binding: identity.binding, ...kernel });
  }
  /**
   * Verify tokens and current authorization, then attach a transport sink.
   * Traced as `nestvexa.realtime.subscribe` (rejections carry their code); an
   * accepted connection is a `nestvexa.realtime.connection` span ending with
   * its close reason.
   */
  async connect(
    resolve: IdentityResolver,
    tokens: readonly string[],
    sink: RealtimeSink,
    lastEventIds: ReadonlyMap<string, string> = new Map(),
    transport = 'custom',
  ): Promise<{ readonly channels: readonly string[]; close(): void }> {
    const span = startSpan(
      this.instrumentation,
      'nestvexa.realtime.subscribe',
      {
        'nestvexa.realtime.transport': transport,
        'nestvexa.realtime.tokens': Array.isArray(tokens) ? tokens.length : 0,
      },
    );
    try {
      const subscription = await this.#connect(
        resolve,
        tokens,
        sink,
        lastEventIds,
        transport,
      );
      span.end('ok', {
        'nestvexa.realtime.channels': subscription.channels.length,
      });
      return subscription;
    } catch (error) {
      span.end(
        'error',
        error instanceof RealtimeRejection
          ? { status: error.status, 'nestvexa.error_code': error.code }
          : {},
      );
      throw error;
    }
  }
  async #connect(
    resolve: IdentityResolver,
    tokens: readonly string[],
    sink: RealtimeSink,
    lastEventIds: ReadonlyMap<string, string>,
    transport: string,
  ): Promise<{ readonly channels: readonly string[]; close(): void }> {
    if (this.#closing) throw new RealtimeRejection(503, 'REALTIME_SHUTDOWN');
    if (!Array.isArray(tokens) || !tokens.length || tokens.length > 32)
      throw new RealtimeRejection(400, 'INVALID_SUBSCRIPTION');
    const identity = await this.#identity(resolve);
    // Every attempt counts, including rejected tokens: bounds token guessing
    // and reconnect storms per identity.
    if (!this.#subscribes.take(key(identity.binding)))
      throw new RealtimeRejection(429, 'RATE_LIMITED');
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
    let member: PresenceMember | undefined;
    try {
      member = presenceMember(await this.policy.describePresence?.(identity));
    } catch {
      throw new RealtimeRejection(403, 'PRESENCE_REJECTED');
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
      member,
      expiresAt,
      authorized,
      queue: [],
      queuedBytes: 0,
      waiting: false,
      drainTimer: undefined,
      closed: false,
      timers: [],
      span: startSpan(this.instrumentation, 'nestvexa.realtime.connection', {
        'nestvexa.realtime.transport': transport,
        'nestvexa.realtime.channels': channels.size,
      }),
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
    if (member) this.#presenceChanged(channels);
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
        // Sized once per event, shared by every local subscriber.
        const bytes = eventBytes(event);
        for (const subscriber of [...target.connections])
          this.#enqueue(subscriber, event, bytes);
      });
    }
    entry.connections.add(connection);
  }
  /**
   * Queue an event for one connection. The bound is on what is still queued
   * when an event arrives, not on one write: a burst that a healthy transport
   * absorbs as it drains is delivered in full, while a connection whose queue
   * reaches `queueLimit` events or `maxQueuedBytes` is closed.
   */
  #enqueue(
    connection: Connection,
    event: RealtimeEvent,
    bytes = eventBytes(event),
  ): void {
    if (connection.closed) return;
    if (
      connection.queue.length >= this.limits.queueLimit ||
      connection.queuedBytes + bytes > this.#maxQueuedBytes
    ) {
      this.#close(connection, 'slow-consumer');
      return;
    }
    connection.queue.push({ event, bytes });
    connection.queuedBytes += bytes;
    this.#pump(connection);
  }
  /**
   * Deliver queued events in order: synchronously while authorization is
   * fresh and the transport accepts writes; suspended during a policy lookup
   * and until a congested transport drains.
   */
  #pump(connection: Connection): void {
    while (!connection.closed && !connection.waiting) {
      const head = connection.queue[0];
      if (!head) return;
      const admitted = this.#admit(connection, head.event);
      if (admitted === false) return;
      if (admitted !== true) {
        connection.waiting = true;
        void admitted.then((allowed) => {
          connection.waiting = false;
          if (!allowed || connection.closed) return;
          this.#send(connection);
          this.#pump(connection);
        });
        return;
      }
      this.#send(connection);
    }
  }
  /**
   * True when the head event may be delivered now, false when the connection
   * was closed instead, or a promise while the channel is re-authorized.
   */
  #admit(
    connection: Connection,
    event: RealtimeEvent,
  ): boolean | Promise<boolean> {
    const checked = connection.authorized.get(event.channel) ?? 0;
    if (Date.now() - checked >= this.limits.revalidateMs)
      return (async () => {
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
          return false;
        }
        connection.authorized.set(event.channel, Date.now());
        return this.#admit(connection, event);
      })();
    if (connection.closed) return false;
    if (Date.now() >= connection.expiresAt) {
      this.#close(connection, 'expired');
      return false;
    }
    return true;
  }
  /** Write the head event; suspend delivery while the transport is congested. */
  #send(connection: Connection): void {
    const head = connection.queue.shift();
    if (!head) return;
    connection.queuedBytes -= head.bytes;
    const span = startSpan(this.instrumentation, 'nestvexa.realtime.deliver', {
      'nestvexa.realtime.channel_kind': channelKind(head.event.channel),
    });
    let sent: boolean;
    try {
      sent = connection.sink.send(head.event);
    } catch {
      span.end('error');
      this.#close(connection, 'forbidden');
      return;
    }
    span.end('ok', { 'nestvexa.realtime.backpressure': !sent });
    if (sent) return;
    const sink = connection.sink;
    if (typeof sink.onDrain !== 'function') {
      this.#close(connection, 'slow-consumer');
      return;
    }
    // Congested: the write was accepted, but the buffer is above its bound.
    // Later events wait in the bounded queue; a transport that does not
    // drain in time belongs to a stalled client.
    connection.waiting = true;
    const timer = setTimeout(
      () => this.#close(connection, 'slow-consumer'),
      this.#drainTimeoutMs,
    );
    timer.unref();
    connection.drainTimer = timer;
    let drained = false;
    sink.onDrain(() => {
      if (drained || connection.closed) return;
      drained = true;
      clearTimeout(timer);
      connection.drainTimer = undefined;
      connection.waiting = false;
      this.#pump(connection);
    });
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
    clearTimeout(connection.drainTimer);
    connection.queue.length = 0;
    connection.queuedBytes = 0;
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
    if (connection.member) this.#presenceChanged(connection.channels);
    try {
      connection.sink.close(reason);
    } catch {
      // A failed transport close must not prevent subscription cleanup.
    }
    connection.span.end(
      reason === 'client' || reason === 'shutdown' ? 'ok' : 'error',
      { 'nestvexa.realtime.close_reason': reason },
    );
  }
  #presenceChanged(channels: Iterable<string>): void {
    const notify = this.hooks.onPresenceChange;
    if (!notify) return;
    for (const channel of channels)
      try {
        notify(channel);
      } catch {
        // Presence propagation is best effort and never breaks a connection.
      }
  }
  /** Channels with at least one listed presence member on this hub. */
  presenceChannels(): string[] {
    const channels: string[] = [];
    for (const [channel, entry] of this.#channels)
      for (const connection of entry.connections)
        if (!connection.closed && connection.member) {
          channels.push(channel);
          break;
        }
    return channels;
  }
  /**
   * Charge one identity-attributed publish. Returns false when the identity
   * exceeded `publishesPerMinute`.
   */
  takePublish(identity: RealtimeIdentity): boolean {
    return this.#publishes.take(key(identity.binding));
  }
  /**
   * Distinct presence members currently connected to `channel` on this hub
   * (this process). The caller must authorize the reader; see
   * `RealtimeService.presence`.
   */
  presence(channel: string): PresenceSnapshot {
    const name = parseChannel(channel);
    const members = new Map<string, PresenceMember>();
    for (const connection of this.#channels.get(name)?.connections ?? [])
      if (!connection.closed && connection.member)
        members.set(connection.member.id, connection.member);
    const sorted = [...members.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    return Object.freeze({
      channel: name,
      members: Object.freeze(sorted.slice(0, this.#maxPresence)),
      total: sorted.length,
      truncated: sorted.length > this.#maxPresence,
    });
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
    this.#subscribes.clear();
    this.#publishes.clear();
  }
}
