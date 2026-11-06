import { Inject, Injectable } from '@nestjs/common';
import { NestvexaConfigError } from './errors.js';
import type { NestvexaConfigIssue } from './errors.js';

export const NESTVEXA_OPTIONS = Symbol('NESTVEXA_OPTIONS');

/** Browser startup owner: the bundled Alpine CSP build, or host-owned manual startup. */
export type NestvexaLiveClient = 'alpine' | 'manual';

/** Explicit application configuration; environment and files are host-owned. */
export interface NestvexaOptions {
  readonly views?: {
    readonly engine?: string;
    readonly root?: string;
    readonly cache?: boolean;
    readonly layout?: string | false;
  };
  readonly live?: {
    readonly enabled?: boolean;
    readonly client?: NestvexaLiveClient;
  };
  readonly security?: {
    readonly csrf?: boolean;
    readonly requireAuthorizedActions?: boolean;
  };
}

export interface NormalizedNestvexaOptions {
  readonly views: {
    readonly engine: string;
    readonly root: string;
    readonly cache: boolean;
    readonly layout: string | false;
  };
  readonly live: {
    readonly enabled: boolean;
    /** Present only when configured; integrations then verify their browser mode matches. */
    readonly client?: NestvexaLiveClient;
  };
  readonly security: {
    readonly csrf: boolean;
    readonly requireAuthorizedActions: boolean;
  };
}

/** Accepted keys per section; the single source for validation, merging and docs. */
const schema = Object.freeze({
  views: Object.freeze(['engine', 'root', 'cache', 'layout']),
  live: Object.freeze(['enabled', 'client']),
  security: Object.freeze(['csrf', 'requireAuthorizedActions']),
});
type Section = keyof typeof schema;
const sections = Object.keys(schema) as Section[];

/** Collects every issue so one startup failure reports all invalid paths. */
class Issues {
  readonly list: NestvexaConfigIssue[] = [];
  add(path: string, expected: string): undefined {
    this.list.push(Object.freeze({ path, expected }));
    return undefined;
  }
  throwIfAny(): void {
    if (this.list.length) throw new NestvexaConfigError(this.list);
  }
}

/** Own enumerable data properties of a plain object, or undefined after recording an issue. */
function record(
  value: unknown,
  keys: readonly string[],
  path: string,
  childPrefix: string,
  issues: Issues,
): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return issues.add(path, 'a plain object');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    return issues.add(path, 'a plain object');
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) {
      // Unknown key names are application-chosen and safe to echo; values never are.
      issues.add(
        typeof key === 'string' ? `${childPrefix}${key}` : path,
        `one of the known keys: ${keys.join(', ')}`,
      );
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      issues.add(
        `${childPrefix}${key}`,
        'a data property (accessors are not read)',
      );
      continue;
    }
    result[key] = descriptor.value;
  }
  // The copy has only known own data properties; no getters were evaluated.
  // Invalid keys are already recorded, so callers keep validating the rest.
  return result;
}

function bool(
  value: unknown,
  fallback: boolean,
  path: string,
  issues: Issues,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    issues.add(path, 'a boolean');
    return fallback;
  }
  return value;
}

function string(
  value: unknown,
  fallback: string,
  path: string,
  issues: Issues,
): string {
  if (value === undefined) return fallback;
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.includes('\0')
  ) {
    issues.add(path, 'a non-empty string without NUL characters');
    return fallback;
  }
  return value;
}

/** Validates one partial layer (unknown keys, accessors and types) without applying defaults. */
function layer(
  input: unknown,
  prefix: string,
  issues: Issues,
): Partial<Record<Section, Record<string, unknown>>> {
  const root = prefix ? prefix.slice(0, -1) : 'options';
  const options = record(input, sections, root, prefix, issues);
  const result: Partial<Record<Section, Record<string, unknown>>> = {};
  if (!options) return result;
  for (const name of sections) {
    const value = options[name];
    if (value === undefined) continue;
    const path = `${prefix}${name}`;
    const section = record(value, schema[name], path, `${path}.`, issues);
    if (section) result[name] = section;
  }
  return result;
}

/** Validates unknown input, clones known properties, and deeply freezes the result. */
export function normalizeOptions(
  input: unknown = {},
): NormalizedNestvexaOptions {
  const issues = new Issues();
  const options = layer(input, '', issues);
  const views = options.views ?? {};
  const live = options.live ?? {};
  const security = options.security ?? {};
  const engine = string(views['engine'], 'hbs', 'views.engine', issues);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(engine))
    issues.add('views.engine', 'a lowercase engine name such as "hbs"');
  const layout =
    views['layout'] === undefined || views['layout'] === false
      ? false
      : string(views['layout'], '', 'views.layout', issues);
  const client = live['client'];
  if (client !== undefined && client !== 'alpine' && client !== 'manual')
    issues.add('live.client', '"alpine" or "manual"');
  const normalized: NormalizedNestvexaOptions = {
    views: Object.freeze({
      engine,
      root: string(views['root'], 'src/views', 'views.root', issues),
      cache: bool(views['cache'], false, 'views.cache', issues),
      layout,
    }),
    live: Object.freeze({
      enabled: bool(live['enabled'], false, 'live.enabled', issues),
      ...(client === 'alpine' || client === 'manual' ? { client } : {}),
    }),
    security: Object.freeze({
      csrf: bool(security['csrf'], true, 'security.csrf', issues),
      requireAuthorizedActions: bool(
        security['requireAuthorizedActions'],
        true,
        'security.requireAuthorizedActions',
        issues,
      ),
    }),
  };
  issues.throwIfAny();
  return Object.freeze(normalized);
}

/**
 * Merge configuration layers in increasing precedence (later layers win per key).
 * Recommended order: file values, then {@link nestvexaOptionsFromEnvironment},
 * then explicit module overrides; built-in defaults apply last through
 * `normalizeOptions`. Every layer is validated; `undefined` layers are skipped.
 */
export function mergeNestvexaOptions(
  ...layers: readonly (NestvexaOptions | undefined)[]
): NestvexaOptions {
  const issues = new Issues();
  const merged: Partial<Record<Section, Record<string, unknown>>> = {};
  layers.forEach((input, index) => {
    if (input === undefined) return;
    const validated = layer(input, `layers[${index}].`, issues);
    for (const name of sections) {
      const section = validated[name];
      if (!section) continue;
      const target = (merged[name] ??= {});
      for (const [key, value] of Object.entries(section))
        if (value !== undefined) target[key] = value;
    }
  });
  issues.throwIfAny();
  // Validate the combined result now so invalid values fail at the merge site.
  normalizeOptions(merged);
  return merged as NestvexaOptions;
}

/** Explicit `NESTVEXA_*` variable names; the host decides which environment to pass. */
export const NESTVEXA_ENVIRONMENT_VARIABLES = Object.freeze({
  NESTVEXA_VIEWS_ENGINE: 'views.engine',
  NESTVEXA_VIEWS_ROOT: 'views.root',
  NESTVEXA_VIEWS_CACHE: 'views.cache',
  NESTVEXA_VIEWS_LAYOUT: 'views.layout',
  NESTVEXA_LIVE_ENABLED: 'live.enabled',
  NESTVEXA_LIVE_CLIENT: 'live.client',
  NESTVEXA_SECURITY_CSRF: 'security.csrf',
  NESTVEXA_SECURITY_REQUIRE_AUTHORIZED_ACTIONS:
    'security.requireAuthorizedActions',
} as const);
const booleanPaths = new Set([
  'views.cache',
  'live.enabled',
  'security.csrf',
  'security.requireAuthorizedActions',
]);

/**
 * Read the documented `NESTVEXA_*` variables from an explicitly supplied
 * environment record (for example `process.env` or values from a host
 * `ConfigService`). Nestvexa never reads `process.env` on its own. Booleans
 * accept `true`/`false`/`1`/`0`; `NESTVEXA_VIEWS_LAYOUT=false` disables layouts.
 * Unknown `NESTVEXA_VIEWS_*`, `NESTVEXA_LIVE_*` and `NESTVEXA_SECURITY_*`
 * names are rejected as probable typos. Diagnostics never include values.
 */
export function nestvexaOptionsFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): NestvexaOptions {
  const issues = new Issues();
  if (
    typeof environment !== 'object' ||
    environment === null ||
    Array.isArray(environment)
  ) {
    issues.add('environment', 'an object of string variables');
    issues.throwIfAny();
  }
  const known: Readonly<Record<string, string>> =
    NESTVEXA_ENVIRONMENT_VARIABLES;
  const result: Partial<Record<Section, Record<string, unknown>>> = {};
  for (const name of Object.keys(environment)) {
    if (!/^NESTVEXA_(?:VIEWS|LIVE|SECURITY)_/.test(name)) continue;
    const path = Object.hasOwn(known, name) ? known[name] : undefined;
    if (path === undefined) {
      issues.add(name, 'a documented NESTVEXA_* variable');
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(environment, name);
    const raw: unknown = descriptor?.value;
    if (raw === undefined) continue;
    if (typeof raw !== 'string') {
      issues.add(name, 'a string value');
      continue;
    }
    const [section, key] = path.split('.') as [Section, string];
    let value: unknown = raw;
    if (booleanPaths.has(path)) {
      const normalized = raw.trim().toLowerCase();
      if (normalized === 'true' || normalized === '1') value = true;
      else if (normalized === 'false' || normalized === '0') value = false;
      else {
        issues.add(name, 'true, false, 1 or 0');
        continue;
      }
    } else if (path === 'views.layout' && raw.trim().toLowerCase() === 'false')
      value = false;
    (result[section] ??= {})[key] = value;
  }
  issues.throwIfAny();
  // Type/format problems are reported against variable-derived option paths.
  normalizeOptions(result);
  return result as NestvexaOptions;
}

/** Inject this service to read normalized application options. */
@Injectable()
export class NestvexaConfigService {
  readonly value: NormalizedNestvexaOptions;

  constructor(@Inject(NESTVEXA_OPTIONS) options: NestvexaOptions) {
    this.value = normalizeOptions(options);
  }
}
