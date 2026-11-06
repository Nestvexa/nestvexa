/**
 * Framework-neutral action state machine shared by the generated React
 * hooks, Vue composables, Svelte stores and Live/HBS element helpers. It owns
 * pending/error/data state, optimistic updates with rollback, cancellation of
 * superseded calls and listener bookkeeping; frameworks only subscribe.
 */
import { settle } from './index.js';
import type {
  ActionCallOptions,
  ActionFailure,
  ActionFieldOf,
  ActionOutputOf,
  ActionSettled,
  AnyActionMethod,
} from './index.js';

export type ActionStatus = 'idle' | 'pending' | 'success' | 'error';

export interface ActionState<Output, Field extends string = string> {
  readonly status: ActionStatus;
  readonly pending: boolean;
  /** Last successful output, or the optimistic value while pending. */
  readonly data: Output | undefined;
  readonly error: ActionFailure<Field> | undefined;
  /** True while `data` holds an optimistic value awaiting the server. */
  readonly optimistic: boolean;
}

/** Computes the value shown while a call is pending; rolled back on failure. */
export type ActionOptimisticUpdate<Output, Input> = (
  current: Output | undefined,
  input: Input,
) => Output;

export interface ActionControllerOptions<M extends AnyActionMethod> {
  readonly initialData?: ActionOutputOf<M>;
  readonly optimistic?: ActionOptimisticUpdate<
    ActionOutputOf<M>,
    Parameters<M>[0]
  >;
  /** Abort a still-running call when a new one starts (default true). */
  readonly abortPrevious?: boolean;
  readonly onSuccess?: (
    data: ActionOutputOf<M>,
    input: Parameters<M>[0],
  ) => void;
  readonly onError?: (
    error: ActionFailure<ActionFieldOf<M>>,
    input: Parameters<M>[0],
  ) => void;
}

export interface ActionController<M extends AnyActionMethod> {
  getSnapshot(): ActionState<ActionOutputOf<M>, ActionFieldOf<M>>;
  /** Svelte store contract: calls `run` immediately and on every change. */
  subscribe(
    run: (state: ActionState<ActionOutputOf<M>, ActionFieldOf<M>>) => void,
  ): () => void;
  /** Change notification without an immediate call (React `useSyncExternalStore`). */
  listen(listener: () => void): () => void;
  /** Calls the action; never rejects for action failures (see `ActionSettled`). */
  run(
    ...args: Parameters<M>
  ): Promise<ActionSettled<ActionOutputOf<M>, ActionFieldOf<M>>>;
  /** Clears data and error (aborting any running call). */
  reset(): void;
  /** Aborts the running call; optimistic data is rolled back. */
  abort(): void;
}

/** What a generated React hook returns: current state plus the commands. */
export type ActionBinding<M extends AnyActionMethod> = ActionState<
  ActionOutputOf<M>,
  ActionFieldOf<M>
> &
  Pick<ActionController<M>, 'run' | 'reset' | 'abort'>;

/** What a generated Vue composable returns; `state` is a (shallow) ref. */
export interface ActionRefBinding<M extends AnyActionMethod> extends Pick<
  ActionController<M>,
  'run' | 'reset' | 'abort'
> {
  readonly state: {
    readonly value: ActionState<ActionOutputOf<M>, ActionFieldOf<M>>;
  };
}

const MAX_LISTENERS = 256;

export function createActionController<M extends AnyActionMethod>(
  method: M,
  options: ActionControllerOptions<M> = {},
): ActionController<M> {
  type Output = ActionOutputOf<M>;
  type Field = ActionFieldOf<M>;
  if (typeof method !== 'function')
    throw new TypeError('createActionController requires an action method');
  let state: ActionState<Output, Field> = Object.freeze({
    status: 'idle',
    pending: false,
    data: options.initialData,
    error: undefined,
    optimistic: false,
  });
  const listeners = new Set<() => void>();
  let generation = 0;
  let running: AbortController | undefined;

  const set = (next: Omit<ActionState<Output, Field>, 'pending'>) => {
    state = Object.freeze({ ...next, pending: next.status === 'pending' });
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A failing subscriber must not break other subscribers.
      }
    }
  };
  const listen = (listener: () => void) => {
    if (listeners.size >= MAX_LISTENERS)
      throw new Error('Too many action state listeners');
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  async function run(
    ...args: Parameters<M>
  ): Promise<ActionSettled<Output, Field>> {
    const [input, callOptions] = args as unknown as [
      Parameters<M>[0],
      ActionCallOptions | undefined,
    ];
    if (options.abortPrevious !== false) running?.abort();
    const controller = new AbortController();
    running = controller;
    const forward = () => controller.abort(callOptions?.signal?.reason);
    if (callOptions?.signal?.aborted) forward();
    else
      callOptions?.signal?.addEventListener('abort', forward, { once: true });
    const token = ++generation;
    const before = state.data;
    const optimistic = options.optimistic;
    set({
      status: 'pending',
      data: optimistic ? optimistic(before, input) : before,
      error: undefined,
      optimistic: optimistic !== undefined,
    });
    const call = Reflect.apply(method, undefined, [
      input,
      { ...callOptions, signal: controller.signal },
    ]) as Promise<Output>;
    const result = await settle<Output, Field>(call);
    callOptions?.signal?.removeEventListener('abort', forward);
    if (running === controller) running = undefined;
    // A newer call owns the state; this result is stale.
    if (token !== generation) return result;
    if (result.ok) {
      set({
        status: 'success',
        data: result.data,
        error: undefined,
        optimistic: false,
      });
      options.onSuccess?.(result.data, input);
    } else if (result.error.reason === 'ABORTED') {
      set({
        status: before === undefined ? 'idle' : 'success',
        data: before,
        error: undefined,
        optimistic: false,
      });
    } else {
      set({
        status: 'error',
        data: before,
        error: result.error,
        optimistic: false,
      });
      options.onError?.(result.error, input);
    }
    return result;
  }

  return Object.freeze({
    getSnapshot: () => state,
    subscribe(
      runSubscriber: (state: ActionState<Output, Field>) => void,
    ): () => void {
      const stop = listen(() => runSubscriber(state));
      runSubscriber(state);
      return stop;
    },
    listen,
    run,
    reset(): void {
      generation++;
      running?.abort();
      running = undefined;
      set({
        status: 'idle',
        data: options.initialData,
        error: undefined,
        optimistic: false,
      });
    },
    abort(): void {
      running?.abort();
    },
  });
}
