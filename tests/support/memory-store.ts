import { MemoryLiveStore } from '../../packages/live/dist/index.js';

/** The default process-local store, with its synchronous inspection helpers. */
export function memoryStore(runtime: {
  readonly store: unknown;
}): MemoryLiveStore {
  if (!(runtime.store instanceof MemoryLiveStore))
    throw new Error('Expected the default MemoryLiveStore');
  return runtime.store;
}
