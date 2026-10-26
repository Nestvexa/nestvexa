import { Inject, Injectable } from '@nestjs/common';
import { NestvexaError } from './errors.js';

export const NESTVEXA_OPTIONS = Symbol('NESTVEXA_OPTIONS');

/** Explicit application configuration; environment and files are host-owned. */
export interface NestvexaOptions {
  readonly views?: {
    readonly engine?: string;
    readonly root?: string;
    readonly cache?: boolean;
    readonly layout?: string | false;
  };
  readonly live?: { readonly enabled?: boolean };
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
  readonly live: { readonly enabled: boolean };
  readonly security: {
    readonly csrf: boolean;
    readonly requireAuthorizedActions: boolean;
  };
}

function invalid(path: string): never {
  throw new NestvexaError(
    'INVALID_CONFIGURATION',
    `Invalid Nestvexa configuration at ${path}`,
  );
}

function record(
  value: unknown,
  keys: readonly string[],
  path: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return invalid(path);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    return invalid(path);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) return invalid(path);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor))
      return invalid(`${path}.${key}`);
  }
  // The validated object has only own data properties; no getters are evaluated.
  return value as Record<string, unknown>;
}

function section(
  value: unknown,
  keys: readonly string[],
  path: string,
): Record<string, unknown> {
  return value === undefined ? {} : record(value, keys, path);
}

function bool(value: unknown, fallback: boolean, path: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') return invalid(path);
  return value;
}

function string(value: unknown, fallback: string, path: string): string {
  if (value === undefined) return fallback;
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.includes('\0')
  )
    return invalid(path);
  return value;
}

/** Validates unknown input, clones known properties, and deeply freezes the result. */
export function normalizeOptions(
  input: unknown = {},
): NormalizedNestvexaOptions {
  const options = record(input, ['views', 'live', 'security'], 'options');
  const views = section(
    options['views'],
    ['engine', 'root', 'cache', 'layout'],
    'views',
  );
  const live = section(options['live'], ['enabled'], 'live');
  const security = section(
    options['security'],
    ['csrf', 'requireAuthorizedActions'],
    'security',
  );
  const engine = string(views['engine'], 'hbs', 'views.engine');
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(engine)) return invalid('views.engine');
  return Object.freeze({
    views: Object.freeze({
      engine,
      root: string(views['root'], 'src/views', 'views.root'),
      cache: bool(views['cache'], false, 'views.cache'),
      layout:
        views['layout'] === undefined || views['layout'] === false
          ? false
          : string(views['layout'], '', 'views.layout'),
    }),
    live: Object.freeze({
      enabled: bool(live['enabled'], false, 'live.enabled'),
    }),
    security: Object.freeze({
      csrf: bool(security['csrf'], true, 'security.csrf'),
      requireAuthorizedActions: bool(
        security['requireAuthorizedActions'],
        true,
        'security.requireAuthorizedActions',
      ),
    }),
  });
}

/** Inject this service to read normalized application options. */
@Injectable()
export class NestvexaConfigService {
  readonly value: NormalizedNestvexaOptions;

  constructor(@Inject(NESTVEXA_OPTIONS) options: NestvexaOptions) {
    this.value = normalizeOptions(options);
  }
}
