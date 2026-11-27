/**
 * Adapters that plug into @nestvexa/realtime: cross-replica pub/sub (Redis
 * PUBLISH/SUBSCRIBE), shared presence and a durable job queue. The broker
 * implementation ships in @nestvexa/realtime for compatibility; this entry
 * point is the documented distributed-mode import. See
 * docs/adr/0032-distributed-state-and-redis.md.
 */
import { RespRealtimeBroker } from '@nestvexa/realtime';
import type {
  RealtimeBroker,
  RealtimePresenceOptions,
} from '@nestvexa/realtime';
import { RedisPresenceStore } from './presence-store.js';

export {
  RespRealtimeBroker as RedisRealtimeBroker,
  type RespBrokerOptions as RedisRealtimeBrokerOptions,
} from '@nestvexa/realtime';
export { RedisJobQueue, type RedisJobQueueOptions } from './job-queue.js';
export {
  RedisPresenceStore,
  type RedisPresenceStoreOptions,
} from './presence-store.js';

export interface RedisRealtimeOptions {
  readonly host?: string;
  readonly port?: number;
  /** Optional AUTH password; never logged. */
  readonly password?: string;
  /**
   * Prefix isolating one application/environment on a shared server
   * (default `nestvexa:`). Presence keys live under `<prefix>presence:`.
   */
  readonly prefix?: string;
  /** Events kept per channel for reconnect replay on this replica (default 100). */
  readonly replaySize?: number;
  /**
   * Shared presence (default on; `ttlMs` defaults to 30 s). `false` keeps
   * presence per replica, which is only correct for a single replica.
   */
  readonly presence?: false | { readonly ttlMs?: number };
}

/**
 * Distributed realtime from one Redis configuration: spread the result into
 * `RealtimeModule.forRoot({ ...redisRealtime({ host, port }), ... })`. It
 * sets the Redis broker and, by default, `RedisPresenceStore` presence, so
 * presence counts every replica whenever Redis is configured this way.
 */
export function redisRealtime(options: RedisRealtimeOptions = {}): {
  readonly broker: RealtimeBroker;
  readonly presence?: RealtimePresenceOptions;
} {
  const prefix = options.prefix ?? 'nestvexa:';
  if (typeof prefix !== 'string' || !/^[a-z0-9:._-]{0,55}$/.test(prefix))
    throw new Error('Invalid Redis realtime prefix');
  const connection = {
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.password === undefined ? {} : { password: options.password }),
  };
  const broker = new RespRealtimeBroker({
    ...connection,
    prefix,
    ...(options.replaySize === undefined
      ? {}
      : { replaySize: options.replaySize }),
  });
  if (options.presence === false) return Object.freeze({ broker });
  const ttlMs = options.presence?.ttlMs;
  return Object.freeze({
    broker,
    presence: Object.freeze({
      store: new RedisPresenceStore({
        ...connection,
        prefix: `${prefix}presence:`,
      }),
      ...(ttlMs === undefined ? {} : { ttlMs }),
    }),
  });
}
