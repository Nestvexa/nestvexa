/** Immutable JSON projection supplied to trusted lifecycle code. */
export type ReadonlyLiveValue =
  | null
  | boolean
  | number
  | string
  | readonly ReadonlyLiveValue[]
  | { readonly [key: string]: ReadonlyLiveValue };

/** Detached, recursively frozen values; previous is the last committed public value. */
export interface LiveUpdateContext {
  readonly field: string;
  readonly previous: ReadonlyLiveValue;
  readonly value: ReadonlyLiveValue;
}

/** A server-only observation of the HTML already rendered; it cannot replace rendered output. */
export interface LiveRenderContext {
  readonly html: string;
}

/** Implemented request lifecycle. Hooks are application code, never remotely callable actions. */
export interface LiveLifecycleHooks {
  /** Every authorized instance: before mount initially, after state restoration before hydrate subsequently. */
  boot?(): void | Promise<void>;
  mount?(): void | Promise<void>;
  hydrate?(): void | Promise<void>;
  /** Once for each accepted client field, after all input validation, before assignment. */
  beforeUpdate?(update: LiveUpdateContext): void | Promise<void>;
  /** After assignment of that field; also runs on authorized model synchronization. */
  afterUpdate?(update: LiveUpdateContext): void | Promise<void>;
  beforeAction?(): void | Promise<void>;
  afterAction?(): void | Promise<void>;
  dehydrate?(): void | Promise<void>;
  /** After dehydrate, before reading the view model or invoking the renderer. */
  beforeRender?(): void | Promise<void>;
  /** Observation only; output, public state and URL effects have already been captured. */
  afterRender?(render: LiveRenderContext): void | Promise<void>;
  /** Server-only diagnostic; throwing here never replaces the primary failure. */
  onError?(error: unknown): void | Promise<void>;
  /** Once per resolved request operation, including errors; this is not browser unmount. */
  dispose?(): void | Promise<void>;
}

export const lifecycleHookNames = [
  'boot',
  'mount',
  'hydrate',
  'beforeUpdate',
  'afterUpdate',
  'beforeAction',
  'afterAction',
  'dehydrate',
  'beforeRender',
  'afterRender',
  'onError',
  'dispose',
] as const satisfies readonly (keyof LiveLifecycleHooks)[];
