/**
 * Wire names from the Inertia v3 protocol specification
 * (https://inertiajs.com/docs/v3/core-concepts/the-protocol) cross-checked
 * against `inertia-laravel` v3.6.0 `src/Support/Header.php` and the request
 * code in `@inertiajs/core` 3.10.0.
 */
export const InertiaHeader = Object.freeze({
  inertia: 'X-Inertia',
  version: 'X-Inertia-Version',
  location: 'X-Inertia-Location',
  redirect: 'X-Inertia-Redirect',
  partialComponent: 'X-Inertia-Partial-Component',
  partialData: 'X-Inertia-Partial-Data',
  partialExcept: 'X-Inertia-Partial-Except',
  reset: 'X-Inertia-Reset',
  errorBag: 'X-Inertia-Error-Bag',
  infiniteScrollMergeIntent: 'X-Inertia-Infinite-Scroll-Merge-Intent',
  exceptOnceProps: 'X-Inertia-Except-Once-Props',
  purpose: 'Purpose',
  secPurpose: 'Sec-Purpose',
} as const);

/**
 * `Vary` for Inertia JSON page responses: every request header that selects
 * their content. A shared cache keyed on the URL and `X-Inertia` alone could
 * otherwise store one visitor's partial reload (only the requested props) and
 * replay it to every later Inertia visit of that URL (cache poisoning).
 * Document responses ignore these headers and vary on `X-Inertia` only.
 */
export const INERTIA_JSON_VARY = [
  InertiaHeader.inertia,
  InertiaHeader.version,
  InertiaHeader.partialComponent,
  InertiaHeader.partialData,
  InertiaHeader.partialExcept,
  InertiaHeader.reset,
  InertiaHeader.errorBag,
  InertiaHeader.infiniteScrollMergeIntent,
  InertiaHeader.exceptOnceProps,
].join(', ');

/** Session keys owned by this adapter. The host owns the session itself. */
export const InertiaSessionKey = Object.freeze({
  errors: 'nestvexa.inertia.errors',
  flash: 'nestvexa.inertia.flash',
  clearHistory: 'nestvexa.inertia.clearHistory',
  preserveFragment: 'nestvexa.inertia.preserveFragment',
  previousUrl: 'nestvexa.inertia.previousUrl',
} as const);

/** Top-level props whose values are produced by the adapter itself. */
export const RESERVED_PROP_KEYS: ReadonlySet<string> = new Set(['errors']);

/** Keys that are never accepted as prop, path or error-bag names. */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);

export const INERTIA_OPTIONS = Symbol.for('nestvexa.inertia.options');
export const INERTIA_PAGE_METADATA = 'nestvexa:inertia:page';
export const PRECOGNITION_METADATA = 'nestvexa:inertia:precognition';
export const DEFAULT_APP_KEY = 'default';
export const DEFAULT_ROOT_ID = 'app';
