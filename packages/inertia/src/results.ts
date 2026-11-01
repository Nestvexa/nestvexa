import type { InertiaErrors } from './validation-types.js';

/** Per-response options for a rendered page. */
export interface InertiaRenderOptions {
  /** Configured app root id (for example `react`). */
  readonly app?: string;
  /** HTTP status for the page response. Default 200. */
  readonly status?: number;
  /** Flash data merged into this response's `flash` (not persisted). */
  readonly flash?: Readonly<Record<string, unknown>>;
  /** Validation errors for this response, merged over session errors. */
  readonly errors?: InertiaErrors;
  /** Overrides the configured history encryption for this response. */
  readonly encryptHistory?: boolean;
  /** Emits `clearHistory: true` for this response. */
  readonly clearHistory?: boolean;
  /** Overrides the configured big-integer marker encoding. */
  readonly preserveBigIntegers?: boolean;
  /** Extra data for the root template only (never sent to the client). */
  readonly viewData?: Readonly<Record<string, unknown>>;
}

export interface InertiaRedirectOptions {
  /** 301, 302, 303, 307 or 308. Defaults to 302, or 303 after PUT/PATCH/DELETE. */
  readonly status?: 301 | 302 | 303 | 307 | 308;
  /** Ask the client to carry the original URL fragment over (page `preserveFragment`). */
  readonly preserveFragment?: boolean;
}

export interface InertiaBackOptions extends InertiaRedirectOptions {
  /** Relative path used when the Referer is absent or unsafe. Defaults to the module fallback. */
  readonly fallback?: string;
}

/** Returned from a handler to render an Inertia page. */
export class InertiaPageResult {
  constructor(
    readonly component: string,
    readonly props: Readonly<Record<string, unknown>>,
    readonly options: InertiaRenderOptions = {},
  ) {
    Object.freeze(this);
  }
}

/** Returned from a handler to issue an internal redirect. */
export class InertiaRedirectResult {
  constructor(
    readonly url: string,
    readonly options: InertiaRedirectOptions = {},
  ) {
    Object.freeze(this);
  }
}

/** Returned from a handler to redirect back to the (validated) Referer. */
export class InertiaBackResult {
  constructor(readonly options: InertiaBackOptions = {}) {
    Object.freeze(this);
  }
}

/** Returned from a handler to force a full `window.location` visit. */
export class InertiaLocationResult {
  constructor(readonly url: string) {
    Object.freeze(this);
  }
}

export type InertiaResult =
  | InertiaPageResult
  | InertiaRedirectResult
  | InertiaBackResult
  | InertiaLocationResult;

export function isInertiaResult(value: unknown): value is InertiaResult {
  return (
    value instanceof InertiaPageResult ||
    value instanceof InertiaRedirectResult ||
    value instanceof InertiaBackResult ||
    value instanceof InertiaLocationResult
  );
}

/** Render `component` with `props` (handled by the Inertia interceptor). */
export function inertia(
  component: string,
  props: Readonly<Record<string, unknown>> = {},
  options?: InertiaRenderOptions,
): InertiaPageResult {
  return new InertiaPageResult(component, props, options);
}

/** Internal redirect; 303 after PUT/PATCH/DELETE, 409 `X-Inertia-Redirect` for fragments. */
export function redirect(
  url: string,
  options?: InertiaRedirectOptions,
): InertiaRedirectResult {
  return new InertiaRedirectResult(url, options);
}

/** Redirect to the same-host Referer, or the fallback when it is missing or unsafe. */
export function back(options?: InertiaBackOptions): InertiaBackResult {
  return new InertiaBackResult(options);
}

/** External/full-page visit: 409 + `X-Inertia-Location` for Inertia requests. */
export function location(url: string): InertiaLocationResult {
  return new InertiaLocationResult(url);
}
