import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { parseChannel } from './token.js';

/** A published invalidation. `data` is public JSON delivered to subscribed browsers. */
export interface RealtimeEvent {
  /** Broker-unique, monotonically ordered per process/channel where supported. */
  readonly id: string;
  readonly channel: string;
  readonly data: unknown;
}
export type RealtimeHandler = (event: RealtimeEvent) => void;
/**
 * Transport-neutral pub/sub. Delivery is at-most-once per connected subscriber;
 * no broker here claims exactly-once delivery.
 */
export interface RealtimeBroker {
  publish(channel: string, data: unknown): Promise<RealtimeEvent>;
  subscribe(channel: string, handler: RealtimeHandler): Promise<() => void>;
  /** Events after `afterId` still in a bounded replay window, if supported. */
  replay(channel: string, afterId: string): readonly RealtimeEvent[];
  close(): Promise<void>;
}

const maxPayloadBytes = 16_384;
export function serializeData(data: unknown): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(data ?? null);
  } catch {
    throw new Error('Realtime event data must be JSON serializable');
  }
  if (text === undefined || Buffer.byteLength(text) > maxPayloadBytes)
    throw new Error('Realtime event data must be JSON of at most 16 KiB');
  return text;
}

/** Single-process broker with a bounded per-channel replay buffer. */
export class MemoryRealtimeBroker implements RealtimeBroker {
  readonly #handlers = new Map<string, Set<RealtimeHandler>>();
  readonly #history = new Map<string, RealtimeEvent[]>();
  readonly #replaySize: number;
  readonly #replayChannels: number;
  #sequence = 0;
  /**
   * `replaySize` events are kept per channel for reconnect replay, for at most
   * `replayChannels` channels (least recently published evicted first), so
   * per-user or per-record channel names cannot grow memory without bound.
   */
  constructor(
    options: {
      readonly replaySize?: number;
      readonly replayChannels?: number;
    } = {},
  ) {
    this.#replaySize = options.replaySize ?? 100;
    this.#replayChannels = options.replayChannels ?? 10_000;
    if (!Number.isSafeInteger(this.#replaySize) || this.#replaySize < 0)
      throw new Error('Invalid realtime replay size');
    if (!Number.isSafeInteger(this.#replayChannels) || this.#replayChannels < 1)
      throw new Error('Invalid realtime replay channel limit');
  }
  async publish(channel: string, data: unknown): Promise<RealtimeEvent> {
    const name = parseChannel(channel);
    const event: RealtimeEvent = Object.freeze({
      id: String(++this.#sequence),
      channel: name,
      data: JSON.parse(serializeData(data)) as unknown,
    });
    this.deliver(event);
    return event;
  }
  /** Deliver an event that originated elsewhere (for example another replica). */
  deliver(event: RealtimeEvent): void {
    if (this.#replaySize) {
      const history = this.#history.get(event.channel) ?? [];
      history.push(event);
      if (history.length > this.#replaySize) history.shift();
      // Re-insert so Map order is least recently published first.
      this.#history.delete(event.channel);
      this.#history.set(event.channel, history);
      while (this.#history.size > this.#replayChannels) {
        const oldest = this.#history.keys().next().value;
        if (oldest === undefined) break;
        this.#history.delete(oldest);
      }
    }
    for (const handler of [...(this.#handlers.get(event.channel) ?? [])])
      handler(event);
  }
  async subscribe(
    channel: string,
    handler: RealtimeHandler,
  ): Promise<() => void> {
    const name = parseChannel(channel);
    const handlers = this.#handlers.get(name) ?? new Set();
    handlers.add(handler);
    this.#handlers.set(name, handlers);
    return () => {
      handlers.delete(handler);
      if (!handlers.size) this.#handlers.delete(name);
    };
  }
  replay(channel: string, afterId: string): readonly RealtimeEvent[] {
    const history = this.#history.get(channel) ?? [];
    const index = history.findIndex((event) => event.id === afterId);
    // Unknown ids (evicted or from another process lifetime) replay nothing;
    // the client refreshes authoritative state after reconnecting.
    return index < 0 ? [] : history.slice(index + 1);
  }
  get subscriptions(): number {
    let count = 0;
    for (const handlers of this.#handlers.values()) count += handlers.size;
    return count;
  }
  /** Channels currently holding replay history (bounded by `replayChannels`). */
  get replayChannels(): number {
    return this.#history.size;
  }
  async close(): Promise<void> {
    this.#handlers.clear();
    this.#history.clear();
  }
}

function command(...parts: string[]): Buffer {
  return Buffer.from(
    `*${parts.length}\r\n` +
      parts
        .map((part) => `$${Buffer.byteLength(part)}\r\n${part}\r\n`)
        .join(''),
  );
}
type Reply = string | number | null | Reply[] | Error;
/** Incremental RESP2 parser for the replies used by PUBLISH/SUBSCRIBE. */
function parseReplies(buffer: Buffer): { replies: Reply[]; rest: Buffer } {
  const replies: Reply[] = [];
  let offset = 0;
  function line(from: number): { text: string; next: number } | undefined {
    const end = buffer.indexOf('\r\n', from);
    if (end < 0) return undefined;
    return { text: buffer.toString('utf8', from, end), next: end + 2 };
  }
  function read(from: number): { value: Reply; next: number } | undefined {
    if (from >= buffer.length) return undefined;
    const type = String.fromCharCode(buffer[from] ?? 0);
    const header = line(from + 1);
    if (!header) return undefined;
    switch (type) {
      case '+':
        return { value: header.text, next: header.next };
      case '-':
        return { value: new Error(header.text), next: header.next };
      case ':':
        return { value: Number(header.text), next: header.next };
      case '$': {
        const length = Number(header.text);
        if (length < 0) return { value: null, next: header.next };
        if (length > 1_048_576) throw new Error('Oversized broker reply');
        if (buffer.length < header.next + length + 2) return undefined;
        return {
          value: buffer.toString('utf8', header.next, header.next + length),
          next: header.next + length + 2,
        };
      }
      case '*': {
        const count = Number(header.text);
        if (count < 0) return { value: null, next: header.next };
        if (count > 1024) throw new Error('Oversized broker reply');
        const items: Reply[] = [];
        let cursor = header.next;
        for (let index = 0; index < count; index++) {
          const item = read(cursor);
          if (!item) return undefined;
          items.push(item.value);
          cursor = item.next;
        }
        return { value: items, next: cursor };
      }
      default:
        throw new Error('Malformed broker reply');
    }
  }
  for (;;) {
    const item = read(offset);
    if (!item) break;
    replies.push(item.value);
    offset = item.next;
  }
  return { replies, rest: buffer.subarray(offset) };
}

export interface RespBrokerOptions {
  readonly host?: string;
  readonly port?: number;
  /** Optional AUTH password; never logged. */
  readonly password?: string;
  /** Prefix isolating this application's channels on a shared server. */
  readonly prefix?: string;
  readonly replaySize?: number;
}
/**
 * Cross-replica pub/sub over the Redis protocol (PUBLISH/SUBSCRIBE), with no
 * client library dependency. Redis pub/sub is fire-and-forget: events published
 * while a replica is disconnected are lost, and clients refresh after reconnect.
 */
export class RespRealtimeBroker implements RealtimeBroker {
  readonly #local: MemoryRealtimeBroker;
  readonly #origin = randomUUID();
  readonly #options: Required<Omit<RespBrokerOptions, 'password'>> & {
    readonly password?: string;
  };
  #publisher: Socket | undefined;
  #subscriber: Socket | undefined;
  #subscribed = new Set<string>();
  /** Channels whose SUBSCRIBE Redis has not confirmed yet. */
  readonly #confirming = new Map<
    string,
    { readonly promise: Promise<void>; readonly resolve: () => void }
  >();
  #pending: {
    resolve: (reply: Reply) => void;
    reject: (error: Error) => void;
  }[] = [];
  #closed = false;
  #resubscribeTimer: ReturnType<typeof setTimeout> | undefined;
  #resubscribeDelay = 100;
  constructor(options: RespBrokerOptions = {}) {
    this.#options = {
      host: options.host ?? '127.0.0.1',
      port: options.port ?? 6379,
      prefix: options.prefix ?? 'nestvexa:',
      replaySize: options.replaySize ?? 100,
      ...(options.password === undefined ? {} : { password: options.password }),
    };
    if (!/^[a-z0-9:._-]{0,64}$/.test(this.#options.prefix))
      throw new Error('Invalid realtime broker prefix');
    this.#local = new MemoryRealtimeBroker({
      replaySize: this.#options.replaySize,
    });
  }
  #connect(subscriber: boolean): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.#options.port, this.#options.host);
      socket.setNoDelay(true);
      let buffer: Buffer = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > 4_194_304) {
          socket.destroy(new Error('Broker reply buffer exceeded'));
          return;
        }
        let parsed: ReturnType<typeof parseReplies>;
        try {
          parsed = parseReplies(buffer);
        } catch (error) {
          socket.destroy(
            error instanceof Error ? error : new Error('Broker error'),
          );
          return;
        }
        buffer = parsed.rest;
        for (const reply of parsed.replies)
          if (subscriber) this.#onMessage(reply);
          else this.#pending.shift()?.resolve(reply);
      });
      socket.once('connect', () => {
        if (this.#options.password !== undefined) {
          // Keep reply order aligned: the AUTH reply is consumed before publishes.
          if (!subscriber)
            this.#pending.push({
              resolve: (reply) => {
                if (reply instanceof Error) socket.destroy();
              },
              reject: () => undefined,
            });
          socket.write(command('AUTH', this.#options.password));
        }
        resolve(socket);
      });
      // Errors after connecting are followed by 'close'; keep a listener so a
      // reset never becomes an uncaught exception.
      socket.on('error', reject);
      socket.on('close', () => {
        if (subscriber) {
          if (this.#subscriber === socket) this.#subscriber = undefined;
          // Never leave a subscribe call waiting on a closed socket; the
          // resubscription restores the channel.
          for (const pending of this.#confirming.values()) pending.resolve();
          this.#confirming.clear();
          this.#scheduleResubscribe();
        } else {
          this.#publisher = undefined;
          for (const pending of this.#pending.splice(0))
            pending.reject(new Error('Realtime broker connection closed'));
        }
      });
    });
  }
  /**
   * Reconnect the subscriber with bounded exponential backoff and restore every
   * channel subscription. Events published while disconnected are not recovered.
   */
  #scheduleResubscribe(): void {
    if (this.#closed || this.#resubscribeTimer || !this.#subscribed.size)
      return;
    const wait = this.#resubscribeDelay;
    this.#resubscribeDelay = Math.min(wait * 2, 5_000);
    this.#resubscribeTimer = setTimeout(() => {
      this.#resubscribeTimer = undefined;
      if (this.#closed || this.#subscriber) return;
      this.#connect(true).then(
        (socket) => {
          if (this.#closed) {
            socket.destroy();
            return;
          }
          this.#subscriber = socket;
          this.#resubscribeDelay = 100;
          for (const name of this.#subscribed)
            socket.write(command('SUBSCRIBE', this.#options.prefix + name));
        },
        () => this.#scheduleResubscribe(),
      );
    }, wait);
    this.#resubscribeTimer.unref();
  }
  #onMessage(reply: Reply): void {
    if (
      Array.isArray(reply) &&
      reply[0] === 'subscribe' &&
      typeof reply[1] === 'string' &&
      reply[1].startsWith(this.#options.prefix)
    ) {
      const name = reply[1].slice(this.#options.prefix.length);
      this.#confirming.get(name)?.resolve();
      this.#confirming.delete(name);
      return;
    }
    if (!Array.isArray(reply) || reply[0] !== 'message') return;
    const [, raw, payload] = reply;
    if (typeof raw !== 'string' || typeof payload !== 'string') return;
    if (!raw.startsWith(this.#options.prefix)) return;
    try {
      const envelope: unknown = JSON.parse(payload);
      if (!envelope || typeof envelope !== 'object') return;
      const origin: unknown = Reflect.get(envelope, 'o');
      const id: unknown = Reflect.get(envelope, 'i');
      if (typeof id !== 'string' || typeof origin !== 'string') return;
      this.#local.deliver(
        Object.freeze({
          id: `${origin}:${id}`,
          channel: parseChannel(raw.slice(this.#options.prefix.length)),
          data: Reflect.get(envelope, 'd') ?? null,
        }),
      );
    } catch {
      // Malformed messages from a shared server are ignored, never delivered.
    }
  }
  async #publisherSocket(): Promise<Socket> {
    if (this.#closed) throw new Error('Realtime broker is closed');
    this.#publisher ??= await this.#connect(false);
    return this.#publisher;
  }
  async publish(channel: string, data: unknown): Promise<RealtimeEvent> {
    const name = parseChannel(channel);
    const id = randomUUID();
    const body = JSON.stringify({
      o: this.#origin,
      i: id,
      d: JSON.parse(serializeData(data)) as unknown,
    });
    const socket = await this.#publisherSocket();
    const reply = await new Promise<Reply>((resolve, reject) => {
      this.#pending.push({ resolve, reject });
      socket.write(command('PUBLISH', this.#options.prefix + name, body));
    });
    if (reply instanceof Error)
      throw new Error('Realtime broker rejected publish');
    return Object.freeze({ id: `${this.#origin}:${id}`, channel: name, data });
  }
  async subscribe(
    channel: string,
    handler: RealtimeHandler,
  ): Promise<() => void> {
    const name = parseChannel(channel);
    if (this.#closed) throw new Error('Realtime broker is closed');
    this.#subscriber ??= await this.#connect(true);
    if (!this.#subscribed.has(name)) {
      this.#subscribed.add(name);
      let resolve: () => void = () => undefined;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      this.#confirming.set(name, { promise, resolve });
      this.#subscriber.write(command('SUBSCRIBE', this.#options.prefix + name));
    }
    // Register first: a message may follow the confirmation in the same read.
    const release = await this.#local.subscribe(name, handler);
    // Resolve only once Redis confirmed the subscription, so callers (the
    // hub's `ready` notice) never report a subscription that can still miss
    // events. A server that never confirms within 5 s does not block forever.
    const pending = this.#confirming.get(name);
    if (pending) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        pending.promise,
        new Promise<void>((done) => {
          timer = setTimeout(done, 5000);
          timer.unref();
        }),
      ]);
      clearTimeout(timer);
    }
    return release;
  }
  replay(channel: string, afterId: string): readonly RealtimeEvent[] {
    return this.#local.replay(channel, afterId);
  }
  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#resubscribeTimer);
    this.#publisher?.destroy();
    this.#subscriber?.destroy();
    await this.#local.close();
  }
}
