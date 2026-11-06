/**
 * Cross-replica realtime pub/sub (Redis PUBLISH/SUBSCRIBE). The implementation
 * ships in @nestvexa/realtime for compatibility; this entry point is the
 * documented distributed-mode import. See docs/adr/0032-distributed-state-and-redis.md.
 */
export {
  RespRealtimeBroker as RedisRealtimeBroker,
  type RespBrokerOptions as RedisRealtimeBrokerOptions,
} from '@nestvexa/realtime';
