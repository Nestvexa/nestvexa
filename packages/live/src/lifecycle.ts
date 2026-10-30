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
] as const satisfies readonly (keyof LiveLifecycleHooks)[];
