import { LiveProtocolError } from './protocol.js';

interface Operation {
  readonly controller: AbortController;
  readonly timeoutMs?: number;
}
const operations = new WeakMap<object, Operation>();

/** Runtime-only: open the cancellation scope of one component operation. */
export function beginOperation(
  instance: object,
  timeoutMs: number | undefined,
): AbortController {
  const controller = new AbortController();
  operations.set(instance, {
    controller,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return controller;
}

/** Runtime-only: close the scope; later `liveAbortSignal` calls throw. */
export function endOperation(instance: object): void {
  operations.delete(instance);
}

/**
 * The AbortSignal of the component's current request operation. It aborts
 * when a `timeoutMs` deadline elapses or the application starts shutting
 * down; pass it to fetch, database drivers or timers so hook and action I/O
 * actually stops. Calling it outside a running Live operation throws.
 */
export function liveAbortSignal(component: object): AbortSignal {
  const operation = operations.get(component);
  if (!operation)
    throw new Error(
      'liveAbortSignal is only available while a Live operation is running',
    );
  return operation.controller.signal;
}

/**
 * Runtime-only: run one hook/action call under the component deadline. On
 * expiry the operation signal aborts with the same 504 error the request
 * fails with. The awaited work is abandoned, not undone.
 */
export async function withinDeadline<T>(
  instance: object,
  code: 'HOOK_TIMEOUT' | 'ACTION_TIMEOUT',
  work: () => T | Promise<T>,
): Promise<T> {
  const operation = operations.get(instance);
  if (operation?.timeoutMs === undefined) return work();
  const { controller, timeoutMs } = operation;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new LiveProtocolError(
            code,
            504,
            'Live component deadline exceeded',
          );
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
