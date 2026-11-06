/**
 * Adapters that plug into @nestvexa/realtime: cross-replica pub/sub (Redis
 * PUBLISH/SUBSCRIBE), shared presence and a durable job queue. The broker
 * implementation ships in @nestvexa/realtime for compatibility; this entry
 * point is the documented distributed-mode import. See
 * docs/adr/0032-distributed-state-and-redis.md.
 */
export {
  RespRealtimeBroker as RedisRealtimeBroker,
  type RespBrokerOptions as RedisRealtimeBrokerOptions,
} from '@nestvexa/realtime';
export { RedisJobQueue, type RedisJobQueueOptions } from './job-queue.js';
export {
  RedisPresenceStore,
  type RedisPresenceStoreOptions,
} from './presence-store.js';
