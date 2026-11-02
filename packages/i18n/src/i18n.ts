import { SafeHtml } from '@nestvexa/views';
import type { ViewComposer, ViewHelper } from '@nestvexa/views';
import { flattenNamespace, namespacePattern, validSegment } from './catalog.js';
import type { CatalogBudget, CatalogInput } from './catalog.js';
import { I18nError, forbiddenKeys, isPlainObject, own } from './errors.js';
import {
  assertTimeZone,
  formatCurrencyValue,
  formatDateValue,
  formatNumberValue,
  formatRelativeValue,
} from './format.js';
import type { RelativeOptions } from './format.js';
import {
  baseLanguage,
  canonicalLocale,
  endonym,
  inferDirection,
} from './locale.js';
import type { TextDirection } from './locale.js';
import { renderMessage } from './message.js';
import type { MessageParams } from './message.js';
import { acceptLanguages, cookieValue, queryValue } from './negotiation.js';

export interface LocaleDefinition {
  readonly code: string;
  readonly dir?: TextDirection;
  readonly label?: string;
}
export interface NegotiationOptions {
  /** Query parameter name; default `lang`; false disables. */
  readonly query?: string | false;
  /** Cookie name; default `nv-locale`; false disables. */
  readonly cookie?: string | false;
  /** Use Accept-Language; default true. */
  readonly header?: boolean;
}
export interface I18nOptions {
  readonly locales: readonly (string | LocaleDefinition)[];
  readonly defaultLocale: string;
  readonly catalogs: CatalogInput;
  readonly defaultNamespace?: string;
  readonly fallbacks?: Readonly<Record<string, readonly string[]>>;
  /** Required explicit time-zone policy for every date format (for example `UTC`). */
  readonly timeZone: string;
  readonly negotiation?: NegotiationOptions;
  readonly missing?: 'key' | 'throw';
  readonly onMissing?: (key: string, locale: string) => void;
}
/** JSON view data; safe to place in view models and `<html lang dir>`. */
export interface I18nView {
  readonly locale: string;
  readonly lang: string;
  readonly dir: TextDirection;
  readonly timeZone: string;
}
export type LocaleSource = 'query' | 'cookie' | 'header' | 'default';
export interface NegotiatedLocale {
  readonly locale: string;
  readonly source: LocaleSource;
}
export interface LocaleCookieOptions {
  readonly secure?: boolean;
  readonly maxAgeSeconds?: number;
  readonly path?: string;
}
/** Locale-bound facade for request and component code. */
export interface I18nContext {
  readonly locale: string;
  readonly dir: TextDirection;
  readonly view: I18nView;
  t(key: string, params?: MessageParams): string;
  html(key: string, params?: MessageParams): SafeHtml;
  has(key: string): boolean;
  formatDate(
    value: Date | number | string,
    options?: Intl.DateTimeFormatOptions,
  ): string;
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string;
  formatCurrency(
    value: number,
    currency: string,
    options?: Intl.NumberFormatOptions,
  ): string;
  formatRelative(
    value: Date | number | string,
    options?: RelativeOptions,
  ): string;
}

const optionKeys = [
  'locales',
  'defaultLocale',
  'catalogs',
  'defaultNamespace',
  'fallbacks',
  'timeZone',
  'negotiation',
  'missing',
  'onMissing',
];
const queryName = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const cookieName = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const cookiePath = /^\/[A-Za-z0-9._~!$&'()*+=:@/-]{0,255}$/;
const maxKeyLength = 256;

function config(message: string): never {
  throw new I18nError('CONFIG', message);
}

/** Validates own data properties of a plain options object without invoking getters. */
function readOptions(input: unknown): Record<string, unknown> {
  if (!isPlainObject(input))
    return config('I18n options must be a plain object');
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      typeof key !== 'string' ||
      !optionKeys.includes(key) ||
      !descriptor ||
      !('value' in descriptor)
    )
      config('Unknown or accessor I18n option');
    result[key] = descriptor.value;
  }
  return result;
}

/** Last own data property of a hash/options argument passed by Handlebars. */
function helperOptions(args: readonly unknown[]): {
  readonly positional: readonly unknown[];
  readonly hash: Record<string, unknown>;
  readonly root: unknown;
} {
  const last = args[args.length - 1];
  const hasOptions =
    last !== null &&
    typeof last === 'object' &&
    own(last, 'hash') !== undefined;
  const hashSource = hasOptions ? own(last, 'hash') : undefined;
  const hash: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  if (hashSource && typeof hashSource === 'object')
    for (const key of Object.keys(hashSource)) {
      if (forbiddenKeys.has(key)) continue;
      const value = own(hashSource, key);
      if (value !== undefined) hash[key] = value;
    }
  const data = hasOptions ? own(last, 'data') : undefined;
  return {
    positional: hasOptions ? args.slice(0, -1) : args,
    hash,
    root: own(data, 'root'),
  };
}

function helperParams(hash: Record<string, unknown>): MessageParams {
  const params: Record<string, string | number | boolean | null> =
    Object.create(null) as Record<string, string | number | boolean | null>;
  for (const [key, value] of Object.entries(hash)) {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      params[key] = value;
    else throw new I18nError('MESSAGE', `Unsupported helper argument ${key}`);
  }
  return params;
}

/**
 * Explicit-allowlist localization service. It holds no per-request state except a
 * WeakMap memo keyed by the host request object.
 */
export class I18n {
  readonly locales: readonly string[];
  readonly defaultLocale: string;
  readonly timeZone: string;
  readonly defaultNamespace: string;
  readonly #definitions = new Map<
    string,
    {
      readonly code: string;
      readonly dir: TextDirection;
      readonly label: string;
    }
  >();
  readonly #catalogs = new Map<string, ReadonlyMap<string, string>>();
  readonly #chains = new Map<string, readonly string[]>();
  readonly #contexts = new Map<string, I18nContext>();
  readonly #requests = new WeakMap<object, I18nContext>();
  readonly #query: string | false;
  readonly #cookie: string | false;
  readonly #header: boolean;
  readonly #missing: 'key' | 'throw';
  readonly #onMissing: ((key: string, locale: string) => void) | undefined;

  constructor(input: I18nOptions) {
    const options = readOptions(input);
    const locales = options['locales'];
    if (!Array.isArray(locales) || locales.length < 1 || locales.length > 64)
      config('locales must list 1-64 allowlisted locales');
    for (const entry of locales as unknown[]) {
      const definition: unknown =
        typeof entry === 'string' ? { code: entry } : entry;
      if (!isPlainObject(definition)) config('Invalid locale definition');
      for (const key of Reflect.ownKeys(definition))
        if (typeof key !== 'string' || !['code', 'dir', 'label'].includes(key))
          config('Unknown locale definition property');
      const code = canonicalLocale(own(definition, 'code'));
      if (!code) config('Invalid locale code');
      if (this.#definitions.has(code)) config(`Duplicate locale ${code}`);
      const dir = own(definition, 'dir');
      if (dir !== undefined && dir !== 'ltr' && dir !== 'rtl')
        config('dir must be ltr or rtl');
      const label = own(definition, 'label');
      if (
        label !== undefined &&
        (typeof label !== 'string' || label.length > 64)
      )
        config('label must be a short string');
      this.#definitions.set(
        code,
        Object.freeze({
          code,
          dir: dir ?? inferDirection(code),
          label: label ?? endonym(code),
        }),
      );
    }
    this.locales = Object.freeze([...this.#definitions.keys()]);
    const defaultLocale = canonicalLocale(options['defaultLocale']);
    if (!defaultLocale || !this.#definitions.has(defaultLocale))
      config('defaultLocale must be one of the allowlisted locales');
    this.defaultLocale = defaultLocale;
    if (options['timeZone'] === undefined)
      config('timeZone is required; choose an explicit policy such as UTC');
    try {
      this.timeZone = assertTimeZone(options['timeZone']);
    } catch {
      config('timeZone is not a supported IANA time zone');
    }
    const namespace = options['defaultNamespace'] ?? 'common';
    if (
      typeof namespace !== 'string' ||
      !namespacePattern.test(namespace) ||
      forbiddenKeys.has(namespace)
    )
      config('Invalid defaultNamespace');
    this.defaultNamespace = namespace;
    const negotiation = options['negotiation'] ?? {};
    if (!isPlainObject(negotiation))
      config('negotiation must be a plain object');
    for (const key of Reflect.ownKeys(negotiation))
      if (
        typeof key !== 'string' ||
        !['query', 'cookie', 'header'].includes(key)
      )
        config('Unknown negotiation option');
    const query = own(negotiation, 'query') ?? 'lang';
    const cookie = own(negotiation, 'cookie') ?? 'nv-locale';
    const header = own(negotiation, 'header') ?? true;
    if (
      query !== false &&
      (typeof query !== 'string' || !queryName.test(query))
    )
      config('Invalid negotiation.query');
    if (
      cookie !== false &&
      (typeof cookie !== 'string' || !cookieName.test(cookie))
    )
      config('Invalid negotiation.cookie');
    if (typeof header !== 'boolean')
      config('negotiation.header must be boolean');
    this.#query = query;
    this.#cookie = cookie;
    this.#header = header;
    const missing = options['missing'] ?? 'key';
    if (missing !== 'key' && missing !== 'throw')
      config('missing must be key or throw');
    this.#missing = missing;
    const onMissing = options['onMissing'];
    if (onMissing !== undefined && typeof onMissing !== 'function')
      config('onMissing must be a function');
    this.#onMissing = onMissing as
      ((key: string, locale: string) => void) | undefined;
    this.#loadCatalogs(options['catalogs']);
    this.#buildChains(options['fallbacks']);
    Object.freeze(this);
  }

  #loadCatalogs(catalogs: unknown): void {
    if (!isPlainObject(catalogs)) config('catalogs must be a plain object');
    const budget: CatalogBudget = { entries: 0, bytes: 0 };
    for (const key of Reflect.ownKeys(catalogs)) {
      const descriptor = Object.getOwnPropertyDescriptor(catalogs, key);
      if (typeof key !== 'string' || !descriptor || !('value' in descriptor))
        throw new I18nError(
          'CATALOG',
          'Catalog locales must be data properties',
        );
      const locale = canonicalLocale(key);
      if (!locale || !this.#definitions.has(locale))
        throw new I18nError('CATALOG', 'Catalog locale is not allowlisted');
      if (this.#catalogs.has(locale))
        throw new I18nError('CATALOG', 'Duplicate catalog locale');
      const namespaces: unknown = descriptor.value;
      if (!isPlainObject(namespaces))
        throw new I18nError('CATALOG', 'Locale catalog must be a plain object');
      const flat = new Map<string, string>();
      for (const namespace of Reflect.ownKeys(namespaces)) {
        const entry = Object.getOwnPropertyDescriptor(namespaces, namespace);
        if (typeof namespace !== 'string' || !entry || !('value' in entry))
          throw new I18nError('CATALOG', 'Invalid catalog namespace');
        flattenNamespace(namespace, entry.value, flat, budget);
      }
      this.#catalogs.set(locale, flat);
    }
  }

  #buildChains(fallbacks: unknown): void {
    const explicit = new Map<string, string[]>();
    if (fallbacks !== undefined) {
      if (!isPlainObject(fallbacks)) config('fallbacks must be a plain object');
      for (const key of Reflect.ownKeys(fallbacks)) {
        const value = typeof key === 'string' ? own(fallbacks, key) : undefined;
        const locale = canonicalLocale(key);
        if (!locale || !this.#definitions.has(locale) || !Array.isArray(value))
          config('fallbacks must map allowlisted locales to arrays');
        const chain: string[] = [];
        for (const item of value as unknown[]) {
          const target = canonicalLocale(item);
          if (!target || !this.#definitions.has(target))
            config('fallback targets must be allowlisted');
          chain.push(target);
        }
        explicit.set(locale, chain);
      }
    }
    for (const locale of this.locales) {
      const base = baseLanguage(locale);
      const chain = [
        locale,
        ...(explicit.get(locale) ??
          (base !== locale && this.#definitions.has(base) ? [base] : [])),
        this.defaultLocale,
      ];
      this.#chains.set(locale, Object.freeze([...new Set(chain)]));
    }
  }

  definitions(): readonly {
    readonly code: string;
    readonly dir: TextDirection;
    readonly label: string;
  }[] {
    return Object.freeze([...this.#definitions.values()]);
  }

  /** Exact allowlisted tag, then its base language, then the first same-language entry. */
  match(candidate: unknown): string | undefined {
    const locale = canonicalLocale(candidate);
    if (!locale) return undefined;
    if (this.#definitions.has(locale)) return locale;
    const base = baseLanguage(locale);
    if (this.#definitions.has(base)) return base;
    return this.locales.find((entry) => baseLanguage(entry) === base);
  }

  #require(locale: string): string {
    const matched = this.match(locale);
    if (!matched) throw new I18nError('LOCALE', 'Locale is not allowlisted');
    return matched;
  }

  /** Query, then cookie, then Accept-Language, then the default. Unlisted values are skipped. */
  negotiate(request: object): NegotiatedLocale {
    if (this.#query !== false) {
      const locale = this.match(queryValue(request, this.#query));
      if (locale) return Object.freeze({ locale, source: 'query' });
    }
    if (this.#cookie !== false) {
      const locale = this.match(cookieValue(request, this.#cookie));
      if (locale) return Object.freeze({ locale, source: 'cookie' });
    }
    if (this.#header)
      for (const range of acceptLanguages(request)) {
        const locale = this.match(range);
        if (locale) return Object.freeze({ locale, source: 'header' });
      }
    return Object.freeze({ locale: this.defaultLocale, source: 'default' });
  }

  /** Negotiates once per request object and memoizes the context. */
  forRequest(request: object): I18nContext {
    if (request === null || typeof request !== 'object')
      throw new I18nError('LOCALE', 'A request object is required');
    const existing = this.#requests.get(request);
    if (existing) return existing;
    const context = this.context(this.negotiate(request).locale);
    this.#requests.set(request, context);
    return context;
  }

  context(locale: string): I18nContext {
    const resolved = this.#require(locale);
    const cached = this.#contexts.get(resolved);
    if (cached) return cached;
    const context: I18nContext = Object.freeze({
      locale: resolved,
      dir: this.dir(resolved),
      view: this.view(resolved),
      t: (key: string, params?: MessageParams) => this.t(resolved, key, params),
      html: (key: string, params?: MessageParams) =>
        this.html(resolved, key, params),
      has: (key: string) => this.has(resolved, key),
      formatDate: (
        value: Date | number | string,
        options?: Intl.DateTimeFormatOptions,
      ) => this.formatDate(resolved, value, options),
      formatNumber: (value: number, options?: Intl.NumberFormatOptions) =>
        this.formatNumber(resolved, value, options),
      formatCurrency: (
        value: number,
        currency: string,
        options?: Intl.NumberFormatOptions,
      ) => this.formatCurrency(resolved, value, currency, options),
      formatRelative: (
        value: Date | number | string,
        options?: RelativeOptions,
      ) => this.formatRelative(resolved, value, options),
    });
    this.#contexts.set(resolved, context);
    return context;
  }

  view(locale: string): I18nView {
    const resolved = this.#require(locale);
    return Object.freeze({
      locale: resolved,
      lang: resolved,
      dir: this.dir(resolved),
      timeZone: this.timeZone,
    });
  }

  dir(locale: string): TextDirection {
    const definition = this.#definitions.get(this.#require(locale));
    return definition ? definition.dir : 'ltr';
  }

  #key(key: string): string {
    if (
      typeof key !== 'string' ||
      key.length === 0 ||
      key.length > maxKeyLength
    )
      throw new I18nError('MESSAGE', 'Invalid message key');
    const separator = key.indexOf(':');
    const namespace =
      separator < 0 ? this.defaultNamespace : key.slice(0, separator);
    const path = separator < 0 ? key : key.slice(separator + 1);
    if (
      !namespacePattern.test(namespace) ||
      forbiddenKeys.has(namespace) ||
      !path.split('.').every(validSegment)
    )
      throw new I18nError('MESSAGE', 'Invalid message key');
    return `${namespace}:${path}`;
  }

  #lookup(
    locale: string,
    key: string,
  ): { readonly message: string; readonly locale: string } | undefined {
    const full = this.#key(key);
    for (const candidate of this.#chains.get(locale) ?? [locale]) {
      const message = this.#catalogs.get(candidate)?.get(full);
      if (message !== undefined) return { message, locale: candidate };
    }
    return undefined;
  }

  #resolve(
    locale: string,
    key: string,
    params: MessageParams | undefined,
    escape: boolean,
  ): string {
    const resolved = this.#require(locale);
    const found = this.#lookup(resolved, key);
    if (!found) {
      this.#onMissing?.(key, resolved);
      if (this.#missing === 'throw')
        throw new I18nError('MISSING', 'Missing translation');
      return key;
    }
    // Plural rules and number formatting follow the language of the chosen message.
    return renderMessage(
      found.message,
      found.locale,
      params,
      escape,
      this.timeZone,
    );
  }

  /** Plain text; render it through an escaping view (HBS `{{ }}`), never as raw HTML. */
  t(locale: string, key: string, params?: MessageParams): string {
    return this.#resolve(locale, key, params, false);
  }

  /** Trusted catalog markup with every interpolated value HTML-escaped. */
  html(locale: string, key: string, params?: MessageParams): SafeHtml {
    return SafeHtml.trusted(this.#resolve(locale, key, params, true));
  }

  has(locale: string, key: string): boolean {
    return this.#lookup(this.#require(locale), key) !== undefined;
  }

  formatDate(
    locale: string,
    value: Date | number | string,
    options?: Intl.DateTimeFormatOptions,
  ): string {
    return formatDateValue(
      this.#require(locale),
      value,
      options,
      this.timeZone,
    );
  }

  formatNumber(
    locale: string,
    value: number,
    options?: Intl.NumberFormatOptions,
  ): string {
    return formatNumberValue(this.#require(locale), value, options);
  }

  formatCurrency(
    locale: string,
    value: number,
    currency: string,
    options?: Intl.NumberFormatOptions,
  ): string {
    return formatCurrencyValue(this.#require(locale), value, currency, options);
  }

  formatRelative(
    locale: string,
    value: Date | number | string,
    options?: RelativeOptions,
  ): string {
    return formatRelativeValue(this.#require(locale), value, options);
  }

  /** Locale of a Handlebars render: `i18n.locale` from the root model, re-validated. */
  #helperLocale(root: unknown): string {
    return this.match(own(own(root, 'i18n'), 'locale')) ?? this.defaultLocale;
  }

  /** Synchronous HBS helpers; register with `HbsEngine.registerHelpers`. */
  helpers(): Readonly<Record<string, ViewHelper>> {
    const call = (
      args: unknown[],
      run: (
        locale: string,
        positional: readonly unknown[],
        hash: Record<string, unknown>,
      ) => unknown,
    ): unknown => {
      const { positional, hash, root } = helperOptions(args);
      return run(this.#helperLocale(root), positional, hash);
    };
    const key = (value: unknown): string => {
      if (typeof value !== 'string')
        throw new I18nError(
          'MESSAGE',
          'Translation key must be a string literal',
        );
      return value;
    };
    const number = (value: unknown): number => {
      if (typeof value !== 'number')
        throw new I18nError('FORMAT', 'Number value must be finite');
      return value;
    };
    const date = (value: unknown): Date | number | string => {
      if (
        typeof value !== 'string' &&
        typeof value !== 'number' &&
        !(value instanceof Date)
      )
        throw new I18nError('FORMAT', 'Invalid date value');
      return value;
    };
    return Object.freeze({
      t: (...args: unknown[]) =>
        call(args, (locale, [value], hash) =>
          this.t(locale, key(value), helperParams(hash)),
        ),
      tHtml: (...args: unknown[]) =>
        call(args, (locale, [value], hash) =>
          this.html(locale, key(value), helperParams(hash)),
        ),
      formatDate: (...args: unknown[]) =>
        call(args, (locale, [value], hash) =>
          formatDateValue(locale, date(value), hash, this.timeZone),
        ),
      formatNumber: (...args: unknown[]) =>
        call(args, (locale, [value], hash) =>
          formatNumberValue(locale, number(value), hash),
        ),
      formatCurrency: (...args: unknown[]) =>
        call(args, (locale, [value, currency], hash) =>
          formatCurrencyValue(locale, number(value), currency, hash),
        ),
      formatRelative: (...args: unknown[]) =>
        call(args, (locale, [value], hash) =>
          formatRelativeValue(locale, date(value), hash),
        ),
      dir: (...args: unknown[]) => call(args, (locale) => this.dir(locale)),
      lang: (...args: unknown[]) => call(args, (locale) => locale),
    });
  }

  /** Request-scoped view composer: contributes `{ i18n: I18nView }`. */
  composer(): ViewComposer<object> {
    return (_view: string, request: object) =>
      Object.freeze({ i18n: this.forRequest(request).view });
  }

  /** `Set-Cookie` value persisting an allowlisted choice; SameSite=Lax. */
  localeCookie(locale: string, options: LocaleCookieOptions = {}): string {
    if (this.#cookie === false)
      config('Cookie negotiation is disabled for this I18n instance');
    const resolved = this.match(locale);
    if (!resolved) throw new I18nError('LOCALE', 'Locale is not allowlisted');
    const maxAge = options.maxAgeSeconds ?? 31_536_000;
    if (!Number.isSafeInteger(maxAge) || maxAge < 0 || maxAge > 34_560_000)
      config('maxAgeSeconds must be an integer from 0 through 34560000');
    const path = options.path ?? '/';
    if (typeof path !== 'string' || !cookiePath.test(path))
      config('Invalid cookie path');
    return (
      `${this.#cookie}=${encodeURIComponent(resolved)}; Path=${path}; Max-Age=${maxAge}; SameSite=Lax` +
      (options.secure === true ? '; Secure' : '')
    );
  }
}
