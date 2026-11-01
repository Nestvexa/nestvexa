import {
  DEFAULT_APP_KEY,
  DEFAULT_ROOT_ID,
  FORBIDDEN_KEYS,
} from './constants.js';
import { defaultRootView } from './document.js';
import type { InertiaRootView } from './document.js';
import { InertiaConfigurationError } from './errors.js';
import { normalizeOrigin } from './redirect.js';
import { defaultHeaderLimits } from './request.js';
import type { InertiaHeaderLimits } from './request.js';
import type { InertiaSessionAdapter } from './session.js';
import { requestSessionAdapter } from './session.js';
import type { InertiaSsrOptions } from './ssr.js';
import type { InertiaPageObject } from './page.js';
import { hasControlCharacter } from './text.js';

/** Asset version: a value or a per-request (possibly async) resolver. */
export type InertiaVersion =
  | string
  | number
  | ((request: object) => string | number | PromiseLike<string | number>);

/**
 * Shared props resolver, invoked once per page response with that request.
 * Its result is never cached or reused for another request.
 */
export type InertiaShareResolver = (
  request: object,
) => Record<string, unknown> | PromiseLike<Record<string, unknown>>;

/** One Inertia root: its own template, assets, version and optional SSR. */
export interface InertiaAppOptions {
  /** DOM id for `data-page` and the mount element. Default `app`. */
  readonly id?: string;
  readonly version?: InertiaVersion;
  readonly rootView?: InertiaRootView;
  readonly title?: string | ((page: InertiaPageObject) => string);
  readonly entry?: {
    readonly scripts?: readonly string[];
    readonly styles?: readonly string[];
  };
  /** Path prefixes (segment boundary) served by this root. */
  readonly paths?: readonly string[];
  readonly ssr?: InertiaSsrOptions;
  /** CSP nonce for entry scripts, per request. */
  readonly nonce?: (request: object) => string | undefined;
}

export interface InertiaModuleOptions extends InertiaAppOptions {
  /** Additional named roots, for example `{ react: {...}, vue: {...} }`. */
  readonly apps?: Readonly<Record<string, InertiaAppOptions>>;
  /** Root used when neither the decorator nor a path selects one. */
  readonly defaultApp?: string;
  readonly share?: InertiaShareResolver;
  /** Host session access; `false` disables session-backed features. */
  readonly session?: InertiaSessionAdapter | false;
  readonly redirects?: {
    /** Exact absolute origins `location()`/`redirect()`/`back()` may target. */
    readonly allowedOrigins?: readonly string[];
    /** Relative fallback for `back()`. Default `/`. */
    readonly fallback?: string;
  };
  /** Global history encryption default (`encryptHistory: true`). */
  readonly encryptHistory?: boolean;
  /** Encode `bigint` with the upstream `$bigint` marker. Default false (reject). */
  readonly preserveBigIntegers?: boolean;
  /** Send every message per field instead of the first. Default false. */
  readonly allErrors?: boolean;
  /** Emit `sharedProps` (used by instant visits). Default true. */
  readonly exposeSharedPropKeys?: boolean;
  readonly limits?: Partial<InertiaHeaderLimits> & { readonly depth?: number };
  /** Page `url` resolver. Default: the raw request path and query. */
  readonly url?: (request: object) => string;
  /** Clock for once-prop expiry. Default `Date.now`. */
  readonly now?: () => number;
  /** Called for each rescued deferred prop failure. Default: Nest logger. */
  readonly onRescue?: (error: unknown, path: string, request: object) => void;
}

export interface ResolvedApp {
  readonly key: string;
  readonly id: string;
  readonly version: InertiaVersion;
  readonly rootView: InertiaRootView;
  readonly title: string | ((page: InertiaPageObject) => string);
  readonly scripts: readonly string[];
  readonly styles: readonly string[];
  readonly paths: readonly string[];
  readonly ssr: InertiaSsrOptions | undefined;
  readonly nonce: ((request: object) => string | undefined) | undefined;
}

export interface ResolvedOptions {
  readonly apps: ReadonlyMap<string, ResolvedApp>;
  readonly defaultApp: string;
  /** Distinct apps get namespaced versions so cross-root XHR forces a reload. */
  readonly namespaceVersions: boolean;
  readonly share: InertiaShareResolver | undefined;
  readonly session: InertiaSessionAdapter | undefined;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly fallback: string;
  readonly encryptHistory: boolean;
  readonly preserveBigIntegers: boolean;
  readonly allErrors: boolean;
  readonly exposeSharedPropKeys: boolean;
  readonly limits: InertiaHeaderLimits;
  readonly depth: number;
  readonly url: ((request: object) => string) | undefined;
  readonly now: () => number;
  readonly onRescue:
    ((error: unknown, path: string, request: object) => void) | undefined;
}

const idPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function normalizePath(path: string): string {
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.startsWith('//')
  )
    throw new InertiaConfigurationError('App paths must be absolute paths');
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

function positive(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1)
    throw new InertiaConfigurationError(`${label} must be a positive integer`);
  return value;
}

function resolveApp(
  key: string,
  base: InertiaAppOptions,
  own: InertiaAppOptions,
): ResolvedApp {
  const merged: InertiaAppOptions = { ...base, ...own };
  const id = merged.id ?? DEFAULT_ROOT_ID;
  if (!idPattern.test(id))
    throw new InertiaConfigurationError(`Invalid DOM id for app ${key}`);
  const version = merged.version ?? '';
  if (
    typeof version !== 'string' &&
    typeof version !== 'number' &&
    typeof version !== 'function'
  )
    throw new InertiaConfigurationError(`Invalid version for app ${key}`);
  for (const asset of [
    ...(merged.entry?.scripts ?? []),
    ...(merged.entry?.styles ?? []),
  ])
    if (
      typeof asset !== 'string' ||
      asset === '' ||
      /^\s*(?:javascript|data|vbscript):/i.test(asset)
    )
      throw new InertiaConfigurationError(`Invalid entry asset for app ${key}`);
  return Object.freeze({
    key,
    id,
    version,
    rootView: merged.rootView ?? defaultRootView,
    title: merged.title ?? '',
    scripts: Object.freeze([...(merged.entry?.scripts ?? [])]),
    styles: Object.freeze([...(merged.entry?.styles ?? [])]),
    paths: Object.freeze((own.paths ?? []).map(normalizePath)),
    ssr: merged.ssr,
    nonce: merged.nonce,
  });
}

export function resolveOptions(
  options: InertiaModuleOptions = {},
): ResolvedOptions {
  if (typeof options !== 'object' || options === null)
    throw new InertiaConfigurationError('Inertia options must be an object');
  const { apps: named, defaultApp, ...base } = options;
  const apps = new Map<string, ResolvedApp>();
  if (named && Object.keys(named).length) {
    for (const [key, app] of Object.entries(named)) {
      if (!idPattern.test(key) || FORBIDDEN_KEYS.has(key))
        throw new InertiaConfigurationError(`Invalid app key ${key}`);
      apps.set(key, resolveApp(key, base, app));
    }
  } else {
    apps.set(DEFAULT_APP_KEY, resolveApp(DEFAULT_APP_KEY, {}, base));
  }
  const fallbackApp =
    defaultApp ?? (apps.size === 1 ? [...apps.keys()][0] : undefined);
  if (fallbackApp === undefined || !apps.has(fallbackApp))
    throw new InertiaConfigurationError(
      'defaultApp must name a configured app',
    );
  const fallback = options.redirects?.fallback ?? '/';
  if (
    !fallback.startsWith('/') ||
    fallback.startsWith('//') ||
    hasControlCharacter(fallback) ||
    fallback.includes('\\')
  )
    throw new InertiaConfigurationError(
      'Redirect fallback must be a relative path',
    );
  const depth = positive(options.limits?.depth, 64, 'limits.depth');
  return Object.freeze({
    apps,
    defaultApp: fallbackApp,
    namespaceVersions: apps.size > 1,
    share: options.share,
    session:
      options.session === false
        ? undefined
        : (options.session ?? requestSessionAdapter),
    allowedOrigins: new Set(
      (options.redirects?.allowedOrigins ?? []).map(normalizeOrigin),
    ),
    fallback,
    encryptHistory: options.encryptHistory === true,
    preserveBigIntegers: options.preserveBigIntegers === true,
    allErrors: options.allErrors === true,
    exposeSharedPropKeys: options.exposeSharedPropKeys !== false,
    limits: Object.freeze({
      headerLength: positive(
        options.limits?.headerLength,
        defaultHeaderLimits.headerLength,
        'limits.headerLength',
      ),
      listEntries: positive(
        options.limits?.listEntries,
        defaultHeaderLimits.listEntries,
        'limits.listEntries',
      ),
      entryLength: positive(
        options.limits?.entryLength,
        defaultHeaderLimits.entryLength,
        'limits.entryLength',
      ),
    }),
    depth,
    url: options.url,
    now: options.now ?? Date.now,
    onRescue: options.onRescue,
  });
}
