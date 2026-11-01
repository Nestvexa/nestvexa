import { FORBIDDEN_KEYS } from './constants.js';
import { InertiaConfigurationError } from './errors.js';
import { hasControlCharacter } from './text.js';

/** A value or a zero-argument (possibly async) factory evaluated on demand. */
export type Lazy<T> = T | (() => T | PromiseLike<T>);

/** Expiry for once props: an absolute `Date` or a number of seconds from resolution. */
export type OnceExpiry = Date | number;

export interface OnceOptions {
  /** Custom cross-page key (`onceProps` key). Defaults to the prop path. */
  readonly as?: string;
  /** Expiry; emitted as `expiresAt` in milliseconds. */
  readonly until?: OnceExpiry;
  /** Resolve and send even when the client reports the prop as loaded. */
  readonly fresh?: boolean;
}

/** Cursor metadata emitted under `scrollProps[path]` (reset is added by the adapter). */
export interface ScrollMetadata {
  readonly pageName: string;
  readonly previousPage: number | string | null;
  readonly nextPage: number | string | null;
  readonly currentPage: number | string | null;
}

export interface ScrollOptions<T> {
  /** Name of the merged inner array. Defaults to `data`. */
  readonly wrapper?: string;
  /** Static metadata or a function of the resolved value. */
  readonly metadata: ScrollMetadata | ((value: T) => ScrollMetadata);
}

type PropKind = 'always' | 'optional' | 'defer' | 'merge' | 'once' | 'scroll';

interface PropState {
  readonly source: unknown;
  readonly deferred: boolean;
  readonly group: string | undefined;
  readonly rescue: boolean;
  readonly merge: boolean;
  readonly deepMerge: boolean;
  readonly append: boolean;
  readonly appendPaths: readonly string[];
  readonly prependPaths: readonly string[];
  readonly matchOn: readonly string[];
  readonly once: boolean;
  readonly onceKey: string | undefined;
  readonly fresh: boolean;
  readonly expiry: OnceExpiry | undefined;
  readonly wrapper: string;
  readonly scrollMetadata: unknown;
}

const initial: PropState = Object.freeze({
  source: undefined,
  deferred: false,
  group: undefined,
  rescue: false,
  merge: false,
  deepMerge: false,
  append: true,
  appendPaths: Object.freeze([]),
  prependPaths: Object.freeze([]),
  matchOn: Object.freeze([]),
  once: false,
  onceKey: undefined,
  fresh: false,
  expiry: undefined,
  wrapper: 'data',
  scrollMetadata: undefined,
});

/** Validates a dot path used in merge targets and match keys. */
export function assertPropPath(path: unknown, label: string): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 256)
    throw new InertiaConfigurationError(`${label} must be a non-empty path`);
  if (hasControlCharacter(path))
    throw new InertiaConfigurationError(`${label} contains control characters`);
  for (const segment of path.split('.')) {
    if (!segment || FORBIDDEN_KEYS.has(segment))
      throw new InertiaConfigurationError(`${label} has an invalid segment`);
  }
  return path;
}

function assertName(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    hasControlCharacter(value) ||
    value.includes(',') ||
    FORBIDDEN_KEYS.has(value)
  )
    throw new InertiaConfigurationError(`${label} must be a short name`);
  return value;
}

function assertExpiry(value: unknown): OnceExpiry {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime()))
      throw new InertiaConfigurationError('Once expiry date is invalid');
    return new Date(value.getTime());
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
    return value;
  throw new InertiaConfigurationError(
    'Once expiry must be a Date or a non-negative number of seconds',
  );
}

function assertFunction(value: unknown, label: string): void {
  if (typeof value !== 'function')
    throw new InertiaConfigurationError(`${label} requires a function`);
}

/**
 * Base for every prop type. Instances are immutable: each modifier returns a
 * new instance, so a prop defined once at module scope can be reused safely
 * across concurrent requests. Per-request state (resolved values, merge intent,
 * reset flags) lives exclusively in the request resolver.
 */
export abstract class InertiaProp {
  readonly #state: PropState;
  abstract readonly kind: PropKind;

  protected constructor(state: PropState) {
    this.#state = Object.freeze({ ...state });
  }

  /** @internal Resolver access to the immutable configuration. */
  static state(prop: InertiaProp): PropState {
    return prop.#state;
  }

  protected derive<T extends InertiaProp>(
    this: T,
    patch: Partial<PropState>,
  ): T {
    const Ctor = this.constructor as new (state: PropState) => T;
    return new Ctor({ ...InertiaProp.state(this), ...patch });
  }

  protected withOnce(
    options: OnceOptions = {},
    enable = true,
  ): Partial<PropState> {
    if (typeof options !== 'object' || options === null)
      throw new InertiaConfigurationError('Once options must be an object');
    return {
      ...(enable ? { once: true } : {}),
      ...(options.as === undefined
        ? {}
        : { onceKey: assertName(options.as, 'Once key') }),
      ...(options.until === undefined
        ? {}
        : { expiry: assertExpiry(options.until) }),
      ...(options.fresh === undefined ? {} : { fresh: options.fresh === true }),
    };
  }

  protected withAppend(
    path:
      boolean | string | readonly string[] | Readonly<Record<string, string>>,
    matchOn: string | undefined,
    prepend: boolean,
  ): Partial<PropState> {
    const state = InertiaProp.state(this);
    if (typeof path === 'boolean')
      return { merge: true, append: prepend ? !path : path };
    const appendPaths = [...state.appendPaths];
    const prependPaths = [...state.prependPaths];
    const match = [...state.matchOn];
    const target = prepend ? prependPaths : appendPaths;
    const add = (entry: unknown, key?: string): void => {
      const checked = assertPropPath(entry, 'Merge path');
      target.push(checked);
      if (key !== undefined)
        match.push(`${checked}.${assertName(key, 'Match key')}`);
    };
    if (typeof path === 'string') add(path, matchOn);
    else if (Array.isArray(path)) for (const entry of path) add(entry);
    else if (typeof path === 'object' && path !== null)
      for (const [entry, key] of Object.entries(path)) add(entry, key);
    else throw new InertiaConfigurationError('Invalid merge path');
    return {
      merge: true,
      appendPaths: Object.freeze(appendPaths),
      prependPaths: Object.freeze(prependPaths),
      matchOn: Object.freeze(match),
    };
  }

  protected withMatchOn(
    matchOn: string | readonly string[],
  ): Partial<PropState> {
    const list = typeof matchOn === 'string' ? [matchOn] : [...matchOn];
    return {
      matchOn: Object.freeze(list.map((m) => assertPropPath(m, 'Match path'))),
    };
  }
}

function base(source: unknown, patch: Partial<PropState> = {}): PropState {
  return { ...initial, source, ...patch };
}

/** Resolved on every response, immune to partial `only`/`except` filters. */
export class AlwaysProp extends InertiaProp {
  readonly kind = 'always' as const;
}

/** Skipped on full visits; resolved only when a partial reload selects it. */
export class OptionalProp extends InertiaProp {
  readonly kind = 'optional' as const;
  once(options?: OnceOptions): this {
    return this.derive(this.withOnce(options));
  }
  as(key: string): this {
    return this.derive(this.withOnce({ as: key }, false));
  }
  until(expiry: OnceExpiry): this {
    return this.derive(this.withOnce({ until: expiry }, false));
  }
  fresh(value = true): this {
    return this.derive({ fresh: value });
  }
}

/** Never evaluated on full visits; announced in `deferredProps[group]`. */
export class DeferProp extends InertiaProp {
  readonly kind = 'defer' as const;
  once(options?: OnceOptions): this {
    return this.derive(this.withOnce(options));
  }
  as(key: string): this {
    return this.derive(this.withOnce({ as: key }, false));
  }
  until(expiry: OnceExpiry): this {
    return this.derive(this.withOnce({ until: expiry }, false));
  }
  fresh(value = true): this {
    return this.derive({ fresh: value });
  }
  /** Failures are omitted from `props` and listed in `rescuedProps`. */
  rescue(value = true): this {
    return this.derive({ rescue: value });
  }
  merge(): this {
    return this.derive({ merge: true });
  }
  deepMerge(): this {
    return this.derive({ merge: true, deepMerge: true });
  }
  append(
    path:
      | boolean
      | string
      | readonly string[]
      | Readonly<Record<string, string>> = true,
    matchOn?: string,
  ): this {
    return this.derive(this.withAppend(path, matchOn, false));
  }
  prepend(
    path:
      | boolean
      | string
      | readonly string[]
      | Readonly<Record<string, string>> = true,
    matchOn?: string,
  ): this {
    return this.derive(this.withAppend(path, matchOn, true));
  }
  matchOn(matchOn: string | readonly string[]): this {
    return this.derive(this.withMatchOn(matchOn));
  }
}

/** Merged (appended, prepended or deep merged) by the client on partial reloads. */
export class MergeProp extends InertiaProp {
  readonly kind = 'merge' as const;
  once(options?: OnceOptions): this {
    return this.derive(this.withOnce(options));
  }
  as(key: string): this {
    return this.derive(this.withOnce({ as: key }, false));
  }
  until(expiry: OnceExpiry): this {
    return this.derive(this.withOnce({ until: expiry }, false));
  }
  fresh(value = true): this {
    return this.derive({ fresh: value });
  }
  deepMerge(): this {
    return this.derive({ merge: true, deepMerge: true });
  }
  append(
    path:
      | boolean
      | string
      | readonly string[]
      | Readonly<Record<string, string>> = true,
    matchOn?: string,
  ): this {
    return this.derive(this.withAppend(path, matchOn, false));
  }
  prepend(
    path:
      | boolean
      | string
      | readonly string[]
      | Readonly<Record<string, string>> = true,
    matchOn?: string,
  ): this {
    return this.derive(this.withAppend(path, matchOn, true));
  }
  matchOn(matchOn: string | readonly string[]): this {
    return this.derive(this.withMatchOn(matchOn));
  }
}

/** Resolved once and remembered by the client across pages that include it. */
export class OnceProp extends InertiaProp {
  readonly kind = 'once' as const;
  as(key: string): this {
    return this.derive(this.withOnce({ as: key }, false));
  }
  until(expiry: OnceExpiry): this {
    return this.derive(this.withOnce({ until: expiry }, false));
  }
  fresh(value = true): this {
    return this.derive({ fresh: value });
  }
}

/** Infinite-scroll prop: merges `<path>.<wrapper>` and emits `scrollProps[path]`. */
export class ScrollProp extends InertiaProp {
  readonly kind = 'scroll' as const;
  /** Defer the initial load into a follow-up partial reload group. */
  defer(group?: string): this {
    return this.derive({
      deferred: true,
      group: group === undefined ? undefined : assertName(group, 'Defer group'),
    });
  }
  matchOn(matchOn: string | readonly string[]): this {
    return this.derive(this.withMatchOn(matchOn));
  }
}

/** Resolve on every response, including partial reloads that exclude it. */
export function always<T>(value: Lazy<T>): AlwaysProp {
  return Reflect.construct(AlwaysProp, [base(value)]) as AlwaysProp;
}

/** Only resolved when a partial reload explicitly selects it. */
export function optional<T>(callback: () => T | PromiseLike<T>): OptionalProp {
  assertFunction(callback, 'optional()');
  return Reflect.construct(OptionalProp, [base(callback)]) as OptionalProp;
}

/** Defer evaluation until the client's follow-up request for `group`. */
export function defer<T>(
  callback: () => T | PromiseLike<T>,
  group?: string,
): DeferProp {
  assertFunction(callback, 'defer()');
  return Reflect.construct(DeferProp, [
    base(callback, {
      deferred: true,
      group: group === undefined ? undefined : assertName(group, 'Defer group'),
    }),
  ]) as DeferProp;
}

/** Shallow merge (append at root by default). */
export function merge<T>(value: Lazy<T>): MergeProp {
  return Reflect.construct(MergeProp, [
    base(value, { merge: true }),
  ]) as MergeProp;
}

/** Deep merge the entire structure on partial reloads. */
export function deepMerge<T>(value: Lazy<T>): MergeProp {
  return Reflect.construct(MergeProp, [
    base(value, { merge: true, deepMerge: true }),
  ]) as MergeProp;
}

/** Resolve once and let the client reuse the value on later pages. */
export function once<T>(
  callback: () => T | PromiseLike<T>,
  options?: OnceOptions,
): OnceProp {
  assertFunction(callback, 'once()');
  const prop = Reflect.construct(OnceProp, [
    base(callback, { once: true }),
  ]) as OnceProp;
  if (options === undefined) return prop;
  let result = prop;
  if (options.as !== undefined) result = result.as(options.as);
  if (options.until !== undefined) result = result.until(options.until);
  if (options.fresh !== undefined) result = result.fresh(options.fresh);
  return result;
}

/** Infinite-scroll prop with explicit cursor metadata. */
export function scroll<T>(
  value: Lazy<T>,
  options: ScrollOptions<T>,
): ScrollProp {
  if (typeof options !== 'object' || options === null)
    throw new InertiaConfigurationError('scroll() requires metadata options');
  const wrapper =
    options.wrapper === undefined
      ? 'data'
      : assertPropPath(options.wrapper, 'Scroll wrapper');
  if (
    typeof options.metadata !== 'function' &&
    (typeof options.metadata !== 'object' || options.metadata === null)
  )
    throw new InertiaConfigurationError('scroll() requires metadata');
  return Reflect.construct(ScrollProp, [
    base(value, { merge: true, wrapper, scrollMetadata: options.metadata }),
  ]) as ScrollProp;
}

/** @internal */
export function propState(prop: InertiaProp): PropState {
  return InertiaProp.state(prop);
}

export type { PropState };
