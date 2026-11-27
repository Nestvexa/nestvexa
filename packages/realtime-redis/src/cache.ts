/**
 * Shared `CacheStore` for @nestvexa/cache: tags, invalidation and
 * cross-process stampede locks visible to every instance. This entry point
 * never loads @nestvexa/live.
 */
export { RedisCacheStore, type RedisCacheStoreOptions } from './cache-store.js';
