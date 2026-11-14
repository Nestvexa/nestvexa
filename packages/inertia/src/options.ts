import {
  DEFAULT_APP_KEY,
  DEFAULT_ROOT_ID,
  FORBIDDEN_KEYS,
} from './constants.js';
import { defaultRootView } from './document.js';
import type { InertiaRootView } from './document.js';
import { InertiaConfigurationError } from './errors.js';
import { isInstrumentation } from './instrumentation.js';
import type { InertiaInstrumentation } from './instrumentation.js';
import { normalizeOrigin } from './redirect.js';
import { defaultHeaderLimits } from './request.js';
import type { InertiaHeaderLimits } from './request.js';
import type { InertiaSessionAdapter } from './session.js';
import { requestSessionAdapter } from './session.js';
import type { InertiaSsrOptions } from './ssr.js';
import type { InertiaPageObject } from './page.js';
import { OnceProp, once } from './props.js';
import { hasControlCharacter, validComponent } from './text.js';
import { isFeatureRegistry, isKernelIdentitySource } from './kernel.js';
import type {
  InertiaFeatureRegistry,
  InertiaKernelIdentitySource,
} from './kernel.js';
import {
  inertiaSecurityPolicies,
  isInertiaPolicyRegistry,
} from './security.js';
import type {
  InertiaPolicyRegistry,
  InertiaSecurityOptions,
  InertiaSecurityPolicies,
} from './security.js';

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

/**
 * Once-shared props resolver (the reference adapter's middleware
 * `shareOnce()`): each value is a zero-argument callback, wrapped in `once()`,
 * or an existing `once()` prop used as is. Merged after `share`.
 */
export type InertiaShareOnceResolver = (
  request: object,
) =>
  | Readonly<Record<string, (() => unknown) | OnceProp>>
  | PromiseLike<Readonly<Record<string, (() => unknown) | OnceProp>>>;

/** What `errorPage.props` receives for each rendered error page. */
export interface InertiaErrorPageContext {
  readonly status: number;
  readonly exception: unknown;
  readonly request: object;
  /** Whether the debug details (`exception` prop) are included. */
  readonly debug: boolean;
}

/**
 * Renders an Inertia component for error responses instead of the framework's
 * JSON error body (the reference adapter's documented `ErrorPage` pattern).
 */
export interface InertiaErrorPageOptions {
  /** Page component rendered with `{ status, message }`, for example `ErrorPage`. */
  readonly component: string;
  /** Statuses rendered as the page (4xx/5xx). Default 403, 404, 500 and 503. */
  readonly statuses?: readonly number[];
  /**
   * Include the exception's own message and an `exception: { name, message,
   * stack }` prop. Default: only when `NODE_ENV` is `development`. Never
   * enable in production: stacks reveal source paths and internals.
   */
  readonly debug?: boolean;
  /** Configured app whose root renders the page (otherwise path selection). */
  readonly app?: string;
  /** Extra props merged over `{ status, message }` (and `exception` when debugging). */
  readonly props?: (
    context: InertiaErrorPageContext,
  ) =>
    | Readonly<Record<string, unknown>>
    | PromiseLike<Readonly<Record<string, unknown>>>;
}

export interface ResolvedErrorPage {
  readonly component: string;
  readonly statuses: ReadonlySet<number>;
  readonly debug: boolean;
  readonly app: string | undefined;
  readonly props: InertiaErrorPageOptions['props'];
}

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
  /**
   * Once props shared with every page (see `InertiaShareOnceResolver`); for
   * request-scoped ones call `InertiaService.shareOnce()`.
   */
  readonly shareOnce?: InertiaShareOnceResolver;
  /**
   * Render this component for selected error statuses through
   * `InertiaErrorPageFilter` (registered by `forRoot` when set).
   */
  readonly errorPage?: InertiaErrorPageOptions;
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
  /**
   * Optional structural tracing hook (for example from
   * @nestvexa/observability). Emits `nestvexa.inertia.render` per page
   * response with the component name, app, response kind and page size, and
   * `nestvexa.ssr.render` around each SSR render (head/body sizes, or the
   * closed SSR error type and whether the client-rendered fallback was used).
   */
  readonly instrumentation?: InertiaInstrumentation;
  /**
   * What an Inertia request whose handler returned nothing gets. `back`
   * (default, as `inertia-laravel` does) redirects to the previous URL, so a
   * `@Post()` handler that only mutates state needs no explicit `back()`.
   * `passthrough` leaves the empty response alone. Handlers that inject
   * `@Res()`/`@Next()` or declare `@HttpCode`, `@Redirect`, `@Render` or
   * `@Sse` are never touched.
   */
  readonly emptyResponse?: 'back' | 'passthrough';
  /**
   * Store the URL of every successful, non-prefetch GET page response in the
   * host session and use it for `back()` when the `Referer` is missing or
   * unusable. Default true (no effect without a session).
   */
  readonly previousUrl?: boolean;
  /**
   * Opt-in origin, CSRF and page-authorization policies (see
   * `InertiaSecurityOptions`). Without it they stay host-owned.
   */
  readonly security?: InertiaSecurityOptions;
  /**
   * Kernel security policy registry (structural; for example
   * `SecurityPolicyRegistry` from @nestvexa/core). With `security`, Inertia
   * registers its policies under `policyOwner` and asks the registry for
   * every origin, CSRF and authorization decision.
   */
  readonly policies?: InertiaPolicyRegistry;
  /** Owner name for `policies` (default `inertia`); a duplicate owner fails startup. */
  readonly policyOwner?: string;
  /**
   * Opt-in kernel identity (structural; for example `RequestContextFactory`
   * from @nestvexa/core). Every page then shares `nvIdentity`
   * (`{ authenticated, tenant? }`, never the principal id or roles) from
   * the kernel, and `security.authorize` receives the kernel identity.
   */
  readonly kernelIdentity?: InertiaKernelIdentitySource;
  /**
   * Kernel feature registry (structural; for example `NestvexaRegistry`
   * from @nestvexa/core): Inertia registers its apps and capabilities under
   * `policyOwner` (default `inertia`).
   */
  readonly featureRegistry?: InertiaFeatureRegistry;
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
  readonly shareOnce: InertiaShareOnceResolver | undefined;
  readonly errorPage: ResolvedErrorPage | undefined;
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
  readonly instrumentation: InertiaInstrumentation | undefined;
  readonly emptyResponse: 'back' | 'passthrough';
  readonly previousUrl: boolean;
  readonly security: InertiaSecurityPolicies | undefined;
  readonly policies: InertiaPolicyRegistry | undefined;
  readonly policyOwner: string;
  readonly kernelIdentity: InertiaKernelIdentitySource | undefined;
  readonly featureRegistry: InertiaFeatureRegistry | undefined;
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
  const {
    apps: named,
    defaultApp,
    security,
    policies,
    policyOwner,
    kernelIdentity,
    featureRegistry,
    ...base
  } = options;
  if (policies !== undefined && !isInertiaPolicyRegistry(policies))
    throw new InertiaConfigurationError(
      'policies must implement register, originAllowed, verifyCsrf and authorize',
    );
  if (
    policyOwner !== undefined &&
    (policies === undefined || !/^[a-z][a-z0-9._-]{0,63}$/.test(policyOwner))
  )
    throw new InertiaConfigurationError(
      'policyOwner must be a lowercase name (a-z0-9._-) used with policies',
    );
  if (kernelIdentity !== undefined && !isKernelIdentitySource(kernelIdentity))
    throw new InertiaConfigurationError(
      'kernelIdentity must implement identity(request)',
    );
  if (featureRegistry !== undefined && !isFeatureRegistry(featureRegistry))
    throw new InertiaConfigurationError(
      'featureRegistry must implement registerFeature(feature)',
    );
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
  const emptyResponse = options.emptyResponse ?? 'back';
  if (emptyResponse !== 'back' && emptyResponse !== 'passthrough')
    throw new InertiaConfigurationError(
      "emptyResponse must be 'back' or 'passthrough'",
    );
  if (
    options.previousUrl !== undefined &&
    typeof options.previousUrl !== 'boolean'
  )
    throw new InertiaConfigurationError('previousUrl must be a boolean');
  return Object.freeze({
    apps,
    defaultApp: fallbackApp,
    namespaceVersions: apps.size > 1,
    share: options.share,
    shareOnce: fn(options.shareOnce, 'shareOnce'),
    errorPage: errorPage(options.errorPage, apps),
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
    instrumentation: instrumentation(options.instrumentation),
    emptyResponse,
    previousUrl: options.previousUrl !== false,
    security:
      security === undefined ? undefined : inertiaSecurityPolicies(security),
    policies,
    policyOwner: policyOwner ?? 'inertia',
    kernelIdentity,
    featureRegistry,
  });
}

function fn<T>(value: T | undefined, label: string): T | undefined {
  if (value !== undefined && typeof value !== 'function')
    throw new InertiaConfigurationError(`${label} must be a function`);
  return value;
}

/** Default error-page statuses, as in the reference adapter's guide. */
export const DEFAULT_ERROR_PAGE_STATUSES: readonly number[] = Object.freeze([
  403, 404, 500, 503,
]);

function errorPage(
  value: InertiaErrorPageOptions | undefined,
  apps: ReadonlyMap<string, ResolvedApp>,
): ResolvedErrorPage | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null)
    throw new InertiaConfigurationError('errorPage must be an object');
  if (typeof value.component !== 'string' || !validComponent(value.component))
    throw new InertiaConfigurationError(
      'errorPage.component must be a component name',
    );
  const statuses = value.statuses ?? DEFAULT_ERROR_PAGE_STATUSES;
  if (!Array.isArray(statuses) || statuses.length === 0)
    throw new InertiaConfigurationError(
      'errorPage.statuses must be a non-empty list',
    );
  for (const status of statuses)
    if (!Number.isInteger(status) || status < 400 || status > 599)
      throw new InertiaConfigurationError(
        'errorPage.statuses must be 4xx or 5xx codes',
      );
  if (value.debug !== undefined && typeof value.debug !== 'boolean')
    throw new InertiaConfigurationError('errorPage.debug must be a boolean');
  if (value.app !== undefined && !apps.has(value.app))
    throw new InertiaConfigurationError(
      'errorPage.app must name a configured app',
    );
  return Object.freeze({
    component: value.component,
    statuses: new Set(statuses),
    debug: value.debug ?? process.env['NODE_ENV'] === 'development',
    app: value.app,
    props: fn(value.props, 'errorPage.props'),
  });
}

/** Wraps once-shared values; anything but a callback or `once()` prop is rejected. */
export function onceShared(value: unknown): Record<string, OnceProp> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new InertiaConfigurationError('Once-shared props must be an object');
  // Null prototype: a hostile `__proto__` key cannot reach Object.prototype.
  const result = Object.create(null) as Record<string, OnceProp>;
  for (const [key, entry] of Object.entries(value)) {
    if (entry instanceof OnceProp) result[key] = entry;
    else if (typeof entry === 'function')
      result[key] = once(entry as () => unknown);
    else
      throw new InertiaConfigurationError(
        `Once-shared prop "${key}" must be a callback or a once() prop`,
      );
  }
  return result;
}

function instrumentation(value: unknown): InertiaInstrumentation | undefined {
  if (value === undefined) return undefined;
  if (!isInstrumentation(value))
    throw new InertiaConfigurationError(
      'instrumentation must implement start()',
    );
  return value;
}
