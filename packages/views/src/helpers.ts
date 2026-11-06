import { SafeHtml, ViewError, type ViewHelper } from './index.js';

/**
 * Engine-neutral view helpers. Every helper here is synchronous trusted server
 * code that returns either a plain string (escaped by the engine like any other
 * value) or `SafeHtml` whose markup this module built from escaped parts.
 */
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);

/** Escapes text for HTML element content and quoted attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('`', '&#96;');
}

/** Positional and named arguments of one helper call, whatever the engine. */
export interface HelperArguments {
  readonly positional: readonly unknown[];
  readonly named: Readonly<Record<string, unknown>>;
}
function namedCopy(source: unknown, skip?: string): Record<string, unknown> {
  const named = Object.create(null) as Record<string, unknown>;
  if (source === null || typeof source !== 'object') return named;
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(source),
  )) {
    if (key === skip || forbiddenKeys.has(key) || !('value' in descriptor))
      continue;
    if (descriptor.enumerable) named[key] = descriptor.value;
  }
  return named;
}
/**
 * Normalizes helper arguments. Handlebars appends an options object (named
 * arguments live in `hash`); Nunjucks appends `{ __keywords: true, ... }` for
 * keyword arguments; EJS and Pug pass exactly what the template wrote. View
 * models never contain functions, so the Handlebars object is unambiguous.
 */
export function helperArguments(args: readonly unknown[]): HelperArguments {
  const last = args.at(-1);
  if (last !== null && typeof last === 'object') {
    if (
      typeof Reflect.get(last, 'lookupProperty') === 'function' &&
      'hash' in last
    )
      return {
        positional: args.slice(0, -1),
        named: namedCopy(Reflect.get(last, 'hash')),
      };
    if (Reflect.get(last, '__keywords') === true)
      return {
        positional: args.slice(0, -1),
        named: namedCopy(last, '__keywords'),
      };
  }
  return { positional: [...args], named: namedCopy(undefined) };
}

// ---------------------------------------------------------------------------
// Route links

type RoutePart =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'param'; readonly name: string }
  | { readonly kind: 'splat'; readonly name: string }
  | { readonly kind: 'group'; readonly parts: readonly RoutePart[] };
type RouteValue = string | number | boolean;
/** Values for path parameters; anything not consumed by the path becomes the query string. */
export type RouteParams = Readonly<
  Record<string, RouteValue | readonly RouteValue[] | null | undefined>
>;
export interface RouteTableOptions {
  /** Path prefix for every route, for example `/app` (no trailing slash). */
  readonly base?: string;
  /** Absolute links: an `http(s)` origin such as `https://app.example.com`. */
  readonly origin?: string;
}

const routeName = /^[A-Za-z][\w.:-]{0,127}$/;
const paramName = /^[A-Za-z_$][\w$]{0,63}/;

/**
 * Parses the Nest/Express 5 (path-to-regexp 8) subset that can be reversed:
 * literal text, `:name`, `*name` and non-nested optional `{...}` groups.
 */
function parsePattern(pattern: string): readonly RoutePart[] {
  if (
    typeof pattern !== 'string' ||
    !pattern.startsWith('/') ||
    pattern.length > 512 ||
    /[?#()\\\s]/.test(pattern)
  )
    throw new ViewError('INVALID_VIEW', `Unsupported route pattern ${pattern}`);
  const parse = (source: string, nested: boolean): RoutePart[] => {
    const parts: RoutePart[] = [];
    let text = '';
    const flush = (): void => {
      if (text) parts.push({ kind: 'text', value: text });
      text = '';
    };
    for (let index = 0; index < source.length; index++) {
      const char = source.charAt(index);
      if (char === ':' || char === '*') {
        const match = paramName.exec(source.slice(index + 1));
        if (!match)
          throw new ViewError(
            'INVALID_VIEW',
            `Unnamed route parameter in ${pattern}`,
          );
        flush();
        parts.push({
          kind: char === ':' ? 'param' : 'splat',
          name: match[0],
        });
        index += match[0].length;
      } else if (char === '{') {
        const end = source.indexOf('}', index);
        if (nested || end === -1)
          throw new ViewError(
            'INVALID_VIEW',
            `Unsupported route group in ${pattern}`,
          );
        flush();
        parts.push({
          kind: 'group',
          parts: parse(source.slice(index + 1, end), true),
        });
        index = end;
      } else if (char === '}')
        throw new ViewError(
          'INVALID_VIEW',
          `Unbalanced route group in ${pattern}`,
        );
      else text += char;
    }
    flush();
    return parts;
  };
  return parse(pattern, false);
}
function segment(route: string, name: string, value: unknown): string {
  const text =
    typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : typeof value === 'string'
        ? value
        : undefined;
  // `.`/`..` would be normalized by browsers into another route.
  if (text === undefined || text === '' || text === '.' || text === '..')
    throw new ViewError(
      'RENDER_FAILED',
      `Route ${route} needs a string or number for parameter ${name}`,
    );
  return encodeURIComponent(text);
}
function queryValue(route: string, key: string, value: unknown): string {
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return String(value);
  throw new ViewError(
    'RENDER_FAILED',
    `Route ${route} query parameter ${key} must be a string, number or boolean`,
  );
}

/**
 * Named application routes for link helpers. Unknown names and missing or
 * malformed parameters throw instead of producing a guessed URL; parameters
 * are percent-encoded per segment, so view data cannot add path segments,
 * queries, fragments or another origin.
 */
export class RouteTable {
  readonly #routes = new Map<string, readonly RoutePart[]>();
  readonly #prefix: string;
  constructor(
    routes: Readonly<Record<string, string>>,
    options: RouteTableOptions = {},
  ) {
    if (typeof routes !== 'object' || routes === null || Array.isArray(routes))
      throw new ViewError('INVALID_VIEW', 'Routes must be a name -> path map');
    for (const [name, pattern] of Object.entries(routes)) {
      if (!routeName.test(name) || forbiddenKeys.has(name))
        throw new ViewError('INVALID_VIEW', `Invalid route name ${name}`);
      this.#routes.set(name, parsePattern(pattern));
    }
    const base = options.base ?? '';
    if (
      typeof base !== 'string' ||
      (base !== '' &&
        (!/^(?:\/[A-Za-z0-9._~!$&'*+,;=:@%-]+)+$/.test(base) ||
          base.includes('//')))
    )
      throw new ViewError('INVALID_VIEW', 'Route base must look like /app');
    let origin = '';
    if (options.origin !== undefined) {
      let url: URL;
      try {
        url = new URL(options.origin);
      } catch (cause) {
        throw new ViewError('INVALID_VIEW', 'Route origin must be http(s)', {
          cause,
        });
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:')
        throw new ViewError('INVALID_VIEW', 'Route origin must be http(s)');
      origin = url.origin;
    }
    this.#prefix = origin + base;
  }
  /** Registered route names. */
  get names(): readonly string[] {
    return Object.freeze([...this.#routes.keys()]);
  }
  has(name: string): boolean {
    return this.#routes.has(name);
  }
  /** Builds the URL of `name`. Parameters the path does not use become the query. */
  url(name: string, params: RouteParams = {}): string {
    const parts = typeof name === 'string' ? this.#routes.get(name) : undefined;
    if (!parts) throw new ViewError('INVALID_VIEW', `Unknown route: ${name}`);
    if (params === null || typeof params !== 'object' || Array.isArray(params))
      throw new ViewError(
        'RENDER_FAILED',
        `Route ${name} params must be an object`,
      );
    const used = new Set<string>();
    const value = (key: string): unknown =>
      Object.hasOwn(params, key) ? params[key] : undefined;
    const build = (list: readonly RoutePart[]): string => {
      let result = '';
      for (const part of list) {
        if (part.kind === 'text') result += part.value;
        else if (part.kind === 'param') {
          used.add(part.name);
          result += segment(name, part.name, value(part.name));
        } else if (part.kind === 'splat') {
          used.add(part.name);
          const raw = value(part.name);
          const items: unknown[] = Array.isArray(raw)
            ? [...(raw as readonly unknown[])]
            : typeof raw === 'string'
              ? raw.split('/')
              : [raw];
          if (!items.length)
            throw new ViewError(
              'RENDER_FAILED',
              `Route ${name} needs parameter ${part.name}`,
            );
          result += items
            .map((item) => segment(name, part.name, item))
            .join('/');
        } else {
          const names = part.parts.flatMap((child) =>
            child.kind === 'param' || child.kind === 'splat'
              ? [child.name]
              : [],
          );
          const present = names.filter((key) => {
            const item = value(key);
            return item !== undefined && item !== null && item !== '';
          });
          if (present.length === names.length) result += build(part.parts);
          else for (const key of names) used.add(key);
        }
      }
      return result;
    };
    const pathname = build(parts);
    const query = new URLSearchParams();
    for (const key of Object.keys(params).sort()) {
      if (used.has(key) || forbiddenKeys.has(key)) continue;
      const item = params[key];
      if (item === undefined || item === null) continue;
      if (Array.isArray(item))
        for (const entry of item as readonly unknown[])
          query.append(key, queryValue(name, key, entry));
      else query.append(key, queryValue(name, key, item));
    }
    const search = query.toString();
    return `${this.#prefix}${pathname}${search ? `?${search}` : ''}`;
  }
}

export interface ControllerRouteOptions {
  /** Global prefix set with `app.setGlobalPrefix`, for example `api`. */
  readonly prefix?: string;
  /** Route name for one handler. Default `ControllerClass.method`. */
  readonly name?: (controller: string, method: string) => string;
}
type MetadataReader = (key: string, target: object) => unknown;
function joinPath(...parts: readonly string[]): string {
  const joined = parts
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return `/${joined}`;
}
function firstPath(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}
/**
 * Builds a route map from Nest controller classes by reading the `path`
 * metadata that `@Controller` and the route decorators store (reflect-metadata
 * is always loaded in a Nest application). Only the first path of a handler
 * with several paths is used; host and version constraints are not encoded.
 */
export function routesFromControllers(
  controllers: readonly (abstract new (...args: never[]) => unknown)[],
  options: ControllerRouteOptions = {},
): Record<string, string> {
  const reader: unknown = Reflect.get(Reflect, 'getMetadata');
  if (typeof reader !== 'function')
    throw new ViewError(
      'INVALID_VIEW',
      'routesFromControllers needs reflect-metadata (loaded by every Nest app)',
    );
  const read: MetadataReader = (key, target) =>
    Reflect.apply(reader, Reflect, [key, target]);
  const routes = Object.create(null) as Record<string, string>;
  for (const controller of controllers) {
    const base = firstPath(read('path', controller));
    if (base === undefined)
      throw new ViewError(
        'INVALID_VIEW',
        `${controller.name} is not a Nest controller`,
      );
    const prototype: unknown = controller.prototype;
    if (prototype === null || typeof prototype !== 'object') continue;
    for (const method of Object.getOwnPropertyNames(prototype)) {
      if (method === 'constructor') continue;
      const handler: unknown = Object.getOwnPropertyDescriptor(
        prototype,
        method,
      )?.value;
      if (typeof handler !== 'function') continue;
      const handlerPath = firstPath(read('path', handler));
      if (handlerPath === undefined || read('method', handler) === undefined)
        continue;
      const name = options.name
        ? options.name(controller.name, method)
        : `${controller.name}.${method}`;
      if (Object.hasOwn(routes, name))
        throw new ViewError('INVALID_VIEW', `Duplicate route name ${name}`);
      routes[name] = joinPath(options.prefix ?? '', base, handlerPath);
    }
  }
  return routes;
}

/**
 * `route(name, params?)` link helper. Handlebars: `{{route "users.show" id=user.id}}`;
 * EJS/Pug: `route('users.show', { id: user.id })`; Nunjucks also accepts keyword
 * arguments. Returns a plain string, so the engine escapes it in attributes.
 */
export function routeHelpers(table: RouteTable): {
  readonly route: ViewHelper;
} {
  return Object.freeze({
    route: (...args: unknown[]): string => {
      const { positional, named } = helperArguments(args);
      const [name, params] = positional;
      if (typeof name !== 'string')
        throw new ViewError('RENDER_FAILED', 'route needs a route name');
      const merged: Record<string, unknown> = Object.assign(
        Object.create(null) as Record<string, unknown>,
        namedCopy(params),
        named,
      );
      return table.url(name, merged as RouteParams);
    },
  });
}

// ---------------------------------------------------------------------------
// Page metadata

/** Public page metadata. Every value is plain text; helpers escape it. */
export interface PageMeta {
  readonly title?: string;
  readonly description?: string;
  /** Absolute `http(s)` URL or application-relative path. */
  readonly canonical?: string;
  readonly robots?: string;
  /** `og:*` properties, for example `{ type: 'article', image: 'https://…' }`. */
  readonly openGraph?: Readonly<Record<string, string>>;
  /** Additional `<meta name>` entries. */
  readonly meta?: Readonly<Record<string, string>>;
}
export interface PageMetaOptions {
  /** Used when a page has no title. */
  readonly defaultTitle?: string;
  /** `%s` is replaced by the page title, for example `%s · Example`. */
  readonly titleTemplate?: string;
}
const metaName = /^[a-z][a-z0-9:._-]{0,63}$/i;
function text(value: unknown, label: string, max = 1000): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > max)
    throw new ViewError('RENDER_FAILED', `Page ${label} must be text`);
  return value;
}
function safeUrl(value: string): boolean {
  if (/^\/(?![/\\])/.test(value)) return !/[\s\\]/.test(value);
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}
function entries(
  value: unknown,
  label: string,
): readonly (readonly [string, string])[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== 'object' || Array.isArray(value))
    throw new ViewError('RENDER_FAILED', `Page ${label} must be an object`);
  return Object.entries(namedCopy(value)).map(([key, item]) => {
    if (!metaName.test(key))
      throw new ViewError('RENDER_FAILED', `Invalid page ${label} name ${key}`);
    return [key, text(item, label) ?? ''] as const;
  });
}

/**
 * `pageTitle(meta)` returns the full title text; `metaTags(meta)` returns
 * escaped `<title>`, description, canonical, robots, Open Graph and extra
 * `<meta>` tags. Canonical URLs must be `http(s)` or application-relative.
 */
export function pageMetaHelpers(options: PageMetaOptions = {}): {
  readonly pageTitle: ViewHelper;
  readonly metaTags: ViewHelper;
} {
  const template = options.titleTemplate ?? '%s';
  if (typeof template !== 'string' || !template.includes('%s'))
    throw new ViewError('INVALID_VIEW', 'titleTemplate must contain %s');
  const fallback = text(options.defaultTitle, 'default title') ?? '';
  const readMeta = (args: unknown[]): Record<string, unknown> => {
    const { positional, named } = helperArguments(args);
    return Object.assign(
      Object.create(null) as Record<string, unknown>,
      namedCopy(positional[0]),
      named,
    );
  };
  const title = (meta: Record<string, unknown>): string => {
    const own = text(meta['title'], 'title');
    return own ? template.replaceAll('%s', own) : fallback;
  };
  return Object.freeze({
    pageTitle: (...args: unknown[]): string => title(readMeta(args)),
    metaTags: (...args: unknown[]): SafeHtml => {
      const meta = readMeta(args);
      const tags: string[] = [];
      const full = title(meta);
      if (full) tags.push(`<title>${escapeHtml(full)}</title>`);
      const description = text(meta['description'], 'description');
      if (description)
        tags.push(
          `<meta name="description" content="${escapeHtml(description)}">`,
        );
      const canonical = text(meta['canonical'], 'canonical', 2048);
      if (canonical) {
        if (!safeUrl(canonical))
          throw new ViewError(
            'RENDER_FAILED',
            'Canonical URL must be http(s) or application-relative',
          );
        tags.push(`<link rel="canonical" href="${escapeHtml(canonical)}">`);
      }
      const robots = text(meta['robots'], 'robots');
      if (robots)
        tags.push(`<meta name="robots" content="${escapeHtml(robots)}">`);
      for (const [key, value] of entries(meta['openGraph'], 'openGraph'))
        tags.push(
          `<meta property="og:${escapeHtml(key)}" content="${escapeHtml(value)}">`,
        );
      for (const [key, value] of entries(meta['meta'], 'meta'))
        tags.push(
          `<meta name="${escapeHtml(key)}" content="${escapeHtml(value)}">`,
        );
      return SafeHtml.trusted(tags.join(''));
    },
  });
}

// ---------------------------------------------------------------------------
// Permissions

/**
 * Host authorization decision for the current request, already bound to the
 * user (a closure over the request's principal). `subject` is view data.
 */
export type ViewPermissionCheck = (
  ability: string,
  subject?: unknown,
) => boolean;
const abilityName = /^[A-Za-z][\w.:-]{0,127}$/;
/** Fail-closed evaluation: only a literal `true` grants; throws and bad names deny. */
function allowed(
  check: ViewPermissionCheck,
  ability: unknown,
  subject: unknown,
): boolean {
  if (typeof ability !== 'string' || !abilityName.test(ability)) return false;
  try {
    return check(ability, subject) === true;
  } catch {
    return false;
  }
}
/**
 * `can(ability, subject?)` and `cannot(...)` helpers for one render, delegating
 * to the host policy. Pass them per request (`RenderOptions.helpers` or the
 * registry's options). Hiding a control is presentation only; the route or
 * action must still authorize.
 */
export function permissionHelpers(check: ViewPermissionCheck): {
  readonly can: ViewHelper;
  readonly cannot: ViewHelper;
} {
  if (typeof check !== 'function')
    throw new ViewError('INVALID_VIEW', 'permissionHelpers needs a check');
  const decide = (args: unknown[]): boolean => {
    const { positional } = helperArguments(args);
    return allowed(check, positional[0], positional[1]);
  };
  return Object.freeze({
    can: (...args: unknown[]): boolean => decide(args),
    cannot: (...args: unknown[]): boolean => !decide(args),
  });
}
/**
 * Precomputes decisions as view data for renders that cannot receive
 * per-request helpers (Nest `@Render`): `{ 'posts.edit': true, ... }`. Every
 * requested ability is present; anything not literally granted is `false`.
 */
export function grantPermissions(
  check: ViewPermissionCheck,
  abilities:
    readonly string[] | Readonly<Record<string, readonly [string, unknown?]>>,
): Readonly<Record<string, boolean>> {
  const result = Object.create(null) as Record<string, boolean>;
  if (Array.isArray(abilities))
    for (const ability of abilities as readonly string[]) {
      if (typeof ability !== 'string' || forbiddenKeys.has(ability)) continue;
      result[ability] = allowed(check, ability, undefined);
    }
  else
    for (const [key, entry] of Object.entries(
      abilities as Readonly<Record<string, readonly [string, unknown?]>>,
    )) {
      if (forbiddenKeys.has(key) || !Array.isArray(entry)) continue;
      result[key] = allowed(check, entry[0], entry[1]);
    }
  return Object.freeze(result);
}

// ---------------------------------------------------------------------------
// Asset manifest hook

/**
 * Supplies already-escaped `<link>`/`<script>` tags for a named asset group
 * (for example a Vite app key). `ViteAssets` from `@nestvexa/vite` matches this
 * interface structurally. Providers are trusted server code; their output is
 * emitted as trusted HTML.
 */
export interface ViewAssetProvider {
  tags(name: string, options?: { readonly nonce?: string }): string;
}
const assetName = /^[A-Za-z][\w.-]{0,63}$/;
const nonceValue = /^[A-Za-z0-9+/_-]{16,128}={0,2}$/;
/**
 * `assetTags(name, nonce?)` helper. Handlebars: `{{assetTags "app" nonce=cspNonce}}`.
 * The name must match a provider entry; the optional CSP nonce must look like
 * a base64 nonce.
 */
export function assetHelpers(provider: ViewAssetProvider): {
  readonly assetTags: ViewHelper;
} {
  if (!provider || typeof provider.tags !== 'function')
    throw new ViewError('INVALID_VIEW', 'assetHelpers needs a provider');
  return Object.freeze({
    assetTags: (...args: unknown[]): SafeHtml => {
      const { positional, named } = helperArguments(args);
      const name = positional[0];
      const nonce = named['nonce'] ?? positional[1];
      if (typeof name !== 'string' || !assetName.test(name))
        throw new ViewError('RENDER_FAILED', 'assetTags needs an asset name');
      if (
        nonce !== undefined &&
        nonce !== null &&
        nonce !== '' &&
        (typeof nonce !== 'string' || !nonceValue.test(nonce))
      )
        throw new ViewError('RENDER_FAILED', 'Invalid CSP nonce');
      const markup = provider.tags(
        name,
        typeof nonce === 'string' && nonce ? { nonce } : {},
      );
      if (typeof markup !== 'string')
        throw new ViewError('RENDER_FAILED', 'Asset provider returned no tags');
      return SafeHtml.trusted(markup);
    },
  });
}
