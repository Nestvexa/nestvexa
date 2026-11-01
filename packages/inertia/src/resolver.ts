import { FORBIDDEN_KEYS } from './constants.js';
import {
  InertiaConfigurationError,
  InertiaSerializationError,
} from './errors.js';
import { InertiaProp, propState } from './props.js';
import type { PropState, ScrollMetadata } from './props.js';

export interface OncePropMetadata {
  readonly prop: string;
  readonly expiresAt: number | null;
}

export interface ScrollPropMetadata extends ScrollMetadata {
  readonly reset: boolean;
}

/** Conditional page-object metadata, emitted only when non-empty. */
export interface PropMetadata {
  sharedProps?: string[];
  mergeProps?: string[];
  prependProps?: string[];
  deepMergeProps?: string[];
  matchPropsOn?: string[];
  deferredProps?: Record<string, string[]>;
  rescuedProps?: string[];
  scrollProps?: Record<string, ScrollPropMetadata>;
  onceProps?: Record<string, OncePropMetadata>;
}

export interface ResolverContext {
  /** Partial reload targeting this component on an Inertia request. */
  readonly partial: boolean;
  readonly inertia: boolean;
  readonly only: readonly string[] | undefined;
  readonly except: readonly string[] | undefined;
  readonly reset: readonly string[];
  readonly exceptOnce: readonly string[];
  readonly mergeIntent: 'append' | 'prepend';
  readonly exposeSharedPropKeys: boolean;
  /** Maximum nesting depth walked while resolving nested plain objects. */
  readonly maxDepth: number;
  readonly now: () => number;
  readonly onRescue: (error: unknown, path: string) => void;
}

type Props = Record<string, unknown>;

export function isPlainObject(value: unknown): value is Props {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function assertKey(key: string, path: string): void {
  if (key === '' || FORBIDDEN_KEYS.has(key))
    throw new InertiaConfigurationError(
      `Invalid prop key at ${path || '<root>'}`,
    );
}

function behaviours(prop: InertiaProp, state: PropState) {
  const kind = prop.kind;
  return {
    always: kind === 'always',
    ignoreFirstLoad: kind === 'optional' || kind === 'defer',
    deferrable: (kind === 'defer' || kind === 'scroll') && state.deferred,
    mergeable:
      (kind === 'defer' || kind === 'merge' || kind === 'scroll') &&
      state.merge,
    onceable:
      (kind === 'optional' ||
        kind === 'defer' ||
        kind === 'merge' ||
        kind === 'once') &&
      state.once,
    rescuable: kind === 'defer' && state.rescue,
    scroll: kind === 'scroll',
  };
}

/**
 * Per-request prop resolution. This is a TypeScript port of the evaluation
 * model in the v3 protocol ("Prop Evaluation Model") and of `PropsResolver`
 * in `inertia-laravel` v3.6.0, including nested dot-path filtering, the
 * unwrap-once rule for factories returning prop types and metadata collection.
 * A fresh instance must be created for every request; it caches resolved scroll
 * values for that request only.
 */
export class PropsResolver {
  readonly #context: ResolverContext;
  readonly #deferred: Record<string, string[]> = {};
  readonly #rescued: string[] = [];
  readonly #merge: string[] = [];
  readonly #prepend: string[] = [];
  readonly #deepMerge: string[] = [];
  readonly #matchOn: string[] = [];
  readonly #scroll: Record<string, ScrollPropMetadata> = {};
  readonly #once: Record<string, OncePropMetadata> = {};
  readonly #shared: string[] = [];
  readonly #resolved = new Map<InertiaProp, unknown>();
  readonly #ancestors: object[] = [];

  constructor(context: ResolverContext) {
    this.#context = context;
  }

  async resolve(
    shared: Props,
    props: Props,
  ): Promise<{ props: Props; metadata: PropMetadata }> {
    if (this.#context.exposeSharedPropKeys) {
      for (const key of Object.keys(shared)) {
        const top = key.includes('.') ? key.slice(0, key.indexOf('.')) : key;
        if (!this.#shared.includes(top)) this.#shared.push(top);
      }
    }
    const merged = unpackDotProps({ ...shared, ...props });
    const resolved = await this.#resolveProps(merged, '', false);
    return { props: resolved, metadata: this.#metadata() };
  }

  #metadata(): PropMetadata {
    const metadata: PropMetadata = {};
    if (this.#shared.length) metadata.sharedProps = this.#shared;
    if (this.#merge.length) metadata.mergeProps = this.#merge;
    if (this.#prepend.length) metadata.prependProps = this.#prepend;
    if (this.#deepMerge.length) metadata.deepMergeProps = this.#deepMerge;
    if (this.#matchOn.length) metadata.matchPropsOn = this.#matchOn;
    if (Object.keys(this.#deferred).length)
      metadata.deferredProps = this.#deferred;
    if (this.#rescued.length) metadata.rescuedProps = this.#rescued;
    if (Object.keys(this.#scroll).length) metadata.scrollProps = this.#scroll;
    if (Object.keys(this.#once).length) metadata.onceProps = this.#once;
    return metadata;
  }

  async #resolveProps(
    props: Props,
    prefix: string,
    parentWasResolved: boolean,
  ): Promise<Props> {
    if (this.#ancestors.includes(props))
      throw new InertiaSerializationError(prefix, 'circular reference');
    if (this.#ancestors.length >= this.#context.maxDepth)
      throw new InertiaSerializationError(prefix, 'maximum depth exceeded');
    this.#ancestors.push(props);
    try {
      return await this.#resolveEntries(props, prefix, parentWasResolved);
    } finally {
      this.#ancestors.pop();
    }
  }

  async #resolveEntries(
    props: Props,
    prefix: string,
    parentWasResolved: boolean,
  ): Promise<Props> {
    const result: Props = {};
    for (const key of Object.keys(props)) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      assertKey(key, path);
      let prop: unknown = props[key];
      if (!this.#includeInPartial(prop, path, parentWasResolved)) continue;
      if (!this.#context.partial && this.#excludeFromInitial(prop, path))
        continue;
      let value = await this.#resolveValue(prop, path);
      if (this.#rescued.includes(path)) continue;
      if (value !== prop && value instanceof InertiaProp) {
        prop = value;
        if (!this.#context.partial && this.#excludeFromInitial(prop, path))
          continue;
        value = await this.#resolveValue(prop, path);
        if (this.#rescued.includes(path)) continue;
      }
      if (prop instanceof InertiaProp) this.#collect(prop, path, value);
      result[key] = isPlainObject(value)
        ? await this.#resolveProps(
            value,
            path,
            parentWasResolved || !isPlainObject(prop),
          )
        : value;
    }
    return result;
  }

  #includeInPartial(
    prop: unknown,
    path: string,
    parentWasResolved: boolean,
  ): boolean {
    if (
      !this.#context.partial ||
      parentWasResolved ||
      (prop instanceof InertiaProp && prop.kind === 'always')
    )
      return true;
    const { only, except } = this.#context;
    if (only !== undefined && !matches(only, path) && !leadsTo(only, path))
      return false;
    if (except !== undefined && matches(except, path)) return false;
    return true;
  }

  #includedInPartialMetadata(path: string): boolean {
    const { only, except } = this.#context;
    if (only !== undefined && !matches(only, path)) return false;
    if (except !== undefined && matches(except, path)) return false;
    return true;
  }

  #excludeFromInitial(prop: unknown, path: string): boolean {
    if (!(prop instanceof InertiaProp)) return false;
    const state = propState(prop);
    const is = behaviours(prop, state);
    if (is.ignoreFirstLoad) {
      if (is.deferrable && !this.#alreadyLoaded(prop, state, path))
        this.#collectDeferred(state, path);
      if (is.mergeable) this.#collectMerge(state, path);
      if (is.onceable) this.#collectOnce(state, path);
      return true;
    }
    if (is.deferrable) {
      this.#collectDeferred(state, path);
      if (is.mergeable) this.#collectMerge(state, path);
      return true;
    }
    if (this.#context.inertia && this.#alreadyLoaded(prop, state, path)) {
      this.#collectOnce(state, path);
      return true;
    }
    return false;
  }

  #alreadyLoaded(prop: InertiaProp, state: PropState, path: string): boolean {
    return (
      behaviours(prop, state).onceable &&
      !state.fresh &&
      this.#context.exceptOnce.includes(state.onceKey ?? path)
    );
  }

  async #resolveValue(prop: unknown, path: string): Promise<unknown> {
    if (!(prop instanceof InertiaProp)) return evaluate(prop);
    const state = propState(prop);
    if (this.#resolved.has(prop)) return this.#resolved.get(prop);
    try {
      const value = await evaluate(state.source);
      if (prop.kind === 'scroll') this.#resolved.set(prop, value);
      return value;
    } catch (error) {
      if (!behaviours(prop, state).rescuable) throw error;
      this.#context.onRescue(error, path);
      this.#rescued.push(path);
      return undefined;
    }
  }

  #collect(prop: InertiaProp, path: string, value: unknown): void {
    const state = propState(prop);
    const is = behaviours(prop, state);
    if (is.mergeable) this.#collectMerge(state, path);
    if (is.scroll) this.#collectScroll(state, path, value);
    if (is.onceable) this.#collectOnce(state, path);
  }

  #collectDeferred(state: PropState, path: string): void {
    const group = state.group ?? 'default';
    (this.#deferred[group] ??= []).push(path);
  }

  #collectMerge(state: PropState, path: string): void {
    if (this.#context.reset.includes(path)) return;
    if (this.#context.partial && !this.#includedInPartialMetadata(path)) return;
    let appendPaths = state.appendPaths;
    let prependPaths = state.prependPaths;
    let append = state.append;
    if (state.scrollMetadata !== undefined) {
      // ScrollProp::configureMergeIntent applied per request, never stored.
      appendPaths =
        this.#context.mergeIntent === 'prepend' ? [] : [state.wrapper];
      prependPaths =
        this.#context.mergeIntent === 'prepend' ? [state.wrapper] : [];
      append = true;
    }
    const atRoot = appendPaths.length === 0 && prependPaths.length === 0;
    if (state.deepMerge) this.#deepMerge.push(path);
    else if (atRoot && append) this.#merge.push(path);
    else if (atRoot) this.#prepend.push(path);
    else {
      for (const target of appendPaths) this.#merge.push(`${path}.${target}`);
      for (const target of prependPaths)
        this.#prepend.push(`${path}.${target}`);
    }
    for (const strategy of state.matchOn)
      this.#matchOn.push(`${path}.${strategy}`);
  }

  #collectScroll(state: PropState, path: string, value: unknown): void {
    const source = state.scrollMetadata;
    const metadata: unknown =
      typeof source === 'function'
        ? (source as (input: unknown) => unknown)(value)
        : source;
    this.#scroll[path] = {
      ...scrollMetadata(metadata, path),
      reset: this.#context.reset.includes(path),
    };
  }

  #collectOnce(state: PropState, path: string): void {
    if (this.#context.partial && !this.#includedInPartialMetadata(path)) return;
    let expiresAt: number | null = null;
    if (state.expiry instanceof Date) expiresAt = state.expiry.getTime();
    else if (typeof state.expiry === 'number')
      expiresAt = this.#context.now() + Math.round(state.expiry * 1000);
    this.#once[state.onceKey ?? path] = { prop: path, expiresAt };
  }
}

function matches(list: readonly string[], path: string): boolean {
  return list.some((entry) => path === entry || path.startsWith(`${entry}.`));
}

function leadsTo(list: readonly string[], path: string): boolean {
  return list.some((entry) => entry.startsWith(`${path}.`));
}

async function evaluate(value: unknown): Promise<unknown> {
  const produced: unknown =
    typeof value === 'function' ? (value as () => unknown)() : value;
  return isThenable(produced) ? await produced : produced;
}

function scrollMetadata(value: unknown, path: string): ScrollMetadata {
  const cursor = (input: unknown): input is number | string | null =>
    input === null ||
    typeof input === 'string' ||
    (typeof input === 'number' && Number.isFinite(input));
  if (!isPlainObject(value))
    throw new InertiaConfigurationError(
      `Scroll metadata for ${path} must be an object`,
    );
  const { pageName, previousPage, nextPage, currentPage } = value;
  if (
    typeof pageName !== 'string' ||
    pageName === '' ||
    !cursor(previousPage) ||
    !cursor(nextPage) ||
    !cursor(currentPage)
  )
    throw new InertiaConfigurationError(`Invalid scroll metadata for ${path}`);
  return { pageName, previousPage, nextPage, currentPage };
}

/**
 * Expands top-level dotted keys (`'auth.user': value`) into nested plain
 * objects, as upstream `unpackDotProps` does, but without evaluating any lazy
 * value: an intermediate that is not a plain object is a configuration error.
 */
export function unpackDotProps(props: Props): Props {
  const result: Props = {};
  const dotted: [string, unknown][] = [];
  for (const key of Object.keys(props)) {
    if (key.includes('.')) dotted.push([key, props[key]]);
    else {
      assertKey(key, key);
      result[key] = props[key];
    }
  }
  for (const [key, value] of dotted) {
    const segments = key.split('.');
    for (const segment of segments) assertKey(segment, key);
    const last = segments.pop() ?? '';
    let cursor = result;
    for (const segment of segments) {
      const existing = cursor[segment];
      if (existing === undefined) {
        const created: Props = {};
        cursor[segment] = created;
        cursor = created;
      } else if (isPlainObject(existing)) {
        const copy: Props = { ...existing };
        cursor[segment] = copy;
        cursor = copy;
      } else
        throw new InertiaConfigurationError(
          `Dotted prop ${key} conflicts with a non-object value`,
        );
    }
    cursor[last] = value;
  }
  return result;
}
