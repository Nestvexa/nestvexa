import type { JsonValue } from './serialize.js';
import type { OncePropMetadata, ScrollPropMetadata } from './resolver.js';

/**
 * The v3 page object. Only `component`, `props`, `url` and `version` are always
 * present; every other field is emitted only when it applies, exactly as listed
 * in https://inertiajs.com/docs/v3/core-concepts/the-protocol#the-page-object
 * (plus `preserveBigIntegers`, read by `@inertiajs/core` 3.10.0 `parsePage`).
 */
export interface InertiaPageObject {
  readonly component: string;
  readonly props: { readonly errors: JsonValue } & Readonly<
    Record<string, JsonValue>
  >;
  readonly url: string;
  readonly version: string | number;
  readonly sharedProps?: readonly string[];
  readonly mergeProps?: readonly string[];
  readonly prependProps?: readonly string[];
  readonly deepMergeProps?: readonly string[];
  readonly matchPropsOn?: readonly string[];
  readonly deferredProps?: Readonly<Record<string, readonly string[]>>;
  readonly rescuedProps?: readonly string[];
  readonly scrollProps?: Readonly<Record<string, ScrollPropMetadata>>;
  readonly onceProps?: Readonly<Record<string, OncePropMetadata>>;
  readonly preserveBigIntegers?: true;
  readonly clearHistory?: true;
  readonly encryptHistory?: true;
  readonly flash?: Readonly<Record<string, JsonValue>>;
  readonly preserveFragment?: true;
}
