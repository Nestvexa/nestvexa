/**
 * Test helpers for Nest e2e tests of Inertia routes (Node only, test-runner
 * neutral): build the request headers the official client sends, extract the
 * page object from an Inertia JSON reply or an initial HTML document, and
 * assert component, props, errors, flash data and deferred props with
 * readable failures. Inspired by `inertia-laravel`'s `AssertableInertia`.
 *
 * ```ts
 * const response = await request(app.getHttpServer()).get('/users');
 * assertInertia(response)
 *   .component('Users/Index')
 *   .has('users', 2)
 *   .where('users.0.name', 'Ada');
 * ```
 */
import { isDeepStrictEqual } from 'node:util';
import { InertiaHeader } from './constants.js';
import type { InertiaPageObject } from './page.js';

/** Failed Inertia assertion (`name` is stable for test-runner output). */
export class InertiaAssertionError extends Error {
  override readonly name = 'InertiaAssertionError';
}

type HeaderBag =
  | { get(name: string): string | null }
  | Readonly<Record<string, string | readonly string[] | number | undefined>>;

/**
 * Structural response: supertest/light-my-request responses (`text`/`body`/
 * `payload` and lowercase `headers`), a raw `{ status, headers, body }`
 * record, or a fetch `Response` after `await response.text()` was stored in
 * `text`.
 */
export interface InertiaResponseLike {
  readonly status?: number;
  readonly statusCode?: number;
  readonly headers?: HeaderBag;
  readonly text?: string;
  readonly payload?: string;
  readonly body?: unknown;
}

export interface ReadInertiaPageOptions {
  /** Root element id (`data-page`), default `app`. */
  readonly id?: string;
}

/** How the page object reached the test. */
export type InertiaResponseKind = 'json' | 'document';

export interface InertiaTestHeaderOptions {
  /** Current asset version (`X-Inertia-Version`). */
  readonly version?: string | number;
  /** Partial reload of `component` with `only`/`except` prop lists. */
  readonly partial?: {
    readonly component: string;
    readonly only?: readonly string[];
    readonly except?: readonly string[];
  };
  /** `X-Inertia-Reset` prop list. */
  readonly reset?: readonly string[];
  /** `X-Inertia-Error-Bag`. */
  readonly errorBag?: string;
  /** `X-Inertia-Except-Once-Props`. */
  readonly exceptOnceProps?: readonly string[];
  /** Adds `Purpose: prefetch` like the client's prefetch requests. */
  readonly prefetch?: boolean;
}

function fail(message: string): never {
  throw new InertiaAssertionError(message);
}

/** Request headers of an official-client Inertia visit. */
export function inertiaHeaders(
  options: InertiaTestHeaderOptions = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    [InertiaHeader.inertia]: 'true',
    'X-Requested-With': 'XMLHttpRequest',
    Accept: 'text/html, application/xhtml+xml',
  };
  if (options.version !== undefined)
    headers[InertiaHeader.version] = String(options.version);
  if (options.partial) {
    headers[InertiaHeader.partialComponent] = options.partial.component;
    if (options.partial.only)
      headers[InertiaHeader.partialData] = options.partial.only.join(',');
    if (options.partial.except)
      headers[InertiaHeader.partialExcept] = options.partial.except.join(',');
  }
  if (options.reset) headers[InertiaHeader.reset] = options.reset.join(',');
  if (options.errorBag) headers[InertiaHeader.errorBag] = options.errorBag;
  if (options.exceptOnceProps)
    headers[InertiaHeader.exceptOnceProps] = options.exceptOnceProps.join(',');
  if (options.prefetch) headers[InertiaHeader.purpose] = 'prefetch';
  return headers;
}

function headerOf(
  response: InertiaResponseLike,
  name: string,
): string | undefined {
  const headers = response.headers;
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get(name: string): string | null }).get(name);
    return value ?? undefined;
  }
  const record = headers as Readonly<Record<string, unknown>>;
  const key = Object.keys(record).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  const value = key === undefined ? undefined : record[key];
  if (Array.isArray(value)) return value.join(', ');
  return value === undefined ? undefined : String(value);
}

function textOf(response: InertiaResponseLike): string | undefined {
  if (typeof response.text === 'string') return response.text;
  if (typeof response.payload === 'string') return response.payload;
  if (typeof response.body === 'string') return response.body;
  if (response.body instanceof Uint8Array)
    return new TextDecoder().decode(response.body);
  return undefined;
}

const entities: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};
function decodeAttribute(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi,
    (match, decimal: string, hex: string, name: string) => {
      if (decimal) return String.fromCodePoint(Number(decimal));
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      return entities[name.toLowerCase()] ?? match;
    },
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parsePage(text: string, origin: string): InertiaPageObject {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail(`The ${origin} is not valid JSON`);
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>)['component'] !== 'string' ||
    typeof (value as Record<string, unknown>)['props'] !== 'object'
  )
    fail(`The ${origin} is not an Inertia page object`);
  return value as InertiaPageObject;
}

/**
 * Extracts the page object: the JSON body of an `X-Inertia` reply, or the
 * `<script data-page="id" type="application/json">` element (v3, also printed
 * by the official SSR server) or legacy `data-page` attribute of an HTML
 * document. Throws `InertiaAssertionError` for anything else.
 */
export function readInertiaPage(
  response: InertiaResponseLike | string,
  options: ReadInertiaPageOptions = {},
): { readonly page: InertiaPageObject; readonly kind: InertiaResponseKind } {
  const id = options.id ?? 'app';
  const source: InertiaResponseLike =
    typeof response === 'string' ? { text: response } : response;
  const isJson =
    headerOf(source, InertiaHeader.inertia) === 'true' ||
    /^application\/json\b/i.test(headerOf(source, 'content-type') ?? '');
  if (isJson) {
    const body = source.body;
    if (
      typeof body === 'object' &&
      body !== null &&
      !(body instanceof Uint8Array) &&
      !Array.isArray(body) &&
      'component' in body
    )
      return {
        page: parsePage(JSON.stringify(body), 'Inertia JSON reply'),
        kind: 'json',
      };
    const text = textOf(source);
    if (text === undefined) fail('The response has no body');
    return { page: parsePage(text, 'Inertia JSON reply'), kind: 'json' };
  }
  const html = textOf(source);
  if (html === undefined) fail('The response has no body');
  const quoted = escapeRegExp(id);
  const script = new RegExp(
    `<script\\b(?=[^>]*\\bdata-page=["']${quoted}["'])(?=[^>]*\\btype=["']application/json["'])[^>]*>([\\s\\S]*?)</script>`,
    'i',
  ).exec(html);
  if (script?.[1] !== undefined)
    return { page: parsePage(script[1], 'page script'), kind: 'document' };
  const attribute = new RegExp(
    `<[a-z]+\\b(?=[^>]*\\bid=["']${quoted}["'])[^>]*\\bdata-page="([^"]*)"`,
    'i',
  ).exec(html);
  if (attribute?.[1] !== undefined)
    return {
      page: parsePage(decodeAttribute(attribute[1]), 'data-page attribute'),
      kind: 'document',
    };
  return fail(
    `No Inertia page found: the response is neither an X-Inertia JSON reply nor a document with a "${id}" page element`,
  );
}

const missing = Symbol('missing');

function lookup(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) return missing;
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(segment)) return missing;
      const index = Number(segment);
      if (index >= current.length) return missing;
      current = current[index];
    } else {
      if (!Object.hasOwn(current, segment)) return missing;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

function show(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return String(value);
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return String(value);
  }
}

function sizeOf(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'object' && value !== null)
    return Object.keys(value).length;
  return undefined;
}

/** Fluent assertions over one Inertia page object. */
export class AssertableInertiaPage {
  constructor(
    readonly page: InertiaPageObject,
    readonly kind: InertiaResponseKind,
  ) {}

  /** The page component name equals `name`. */
  component(name: string): this {
    if (this.page.component !== name)
      fail(
        `Expected Inertia component "${name}", got "${this.page.component}"`,
      );
    return this;
  }

  /** The page `url` equals `url`. */
  url(url: string): this {
    if (this.page.url !== url)
      fail(`Expected Inertia page url "${url}", got "${this.page.url}"`);
    return this;
  }

  /** The page asset `version` equals `version`. */
  version(version: string | number): this {
    if (this.page.version !== version)
      fail(
        `Expected Inertia version ${show(version)}, got ${show(this.page.version)}`,
      );
    return this;
  }

  /** The prop at the dotted `path` (`users.0.name`); throws when absent. */
  prop<T = unknown>(path: string): T {
    const value = lookup(this.page.props, path);
    if (value === missing) fail(`Expected Inertia prop "${path}" to exist`);
    return value as T;
  }

  /** The prop exists; with `length`, the array/object has that many entries. */
  has(path: string, length?: number): this {
    const value = this.prop(path);
    if (length !== undefined && sizeOf(value) !== length)
      fail(
        `Expected Inertia prop "${path}" to have ${length} entries, got ${sizeOf(value) ?? 'a non-collection value'}`,
      );
    return this;
  }

  /** The prop is absent (for example excluded by a partial reload). */
  missing(path: string): this {
    if (lookup(this.page.props, path) !== missing)
      fail(`Expected Inertia prop "${path}" to be missing`);
    return this;
  }

  /** The prop deep-equals `expected`, or satisfies the predicate. */
  where(path: string, expected: unknown): this {
    const value = this.prop(path);
    if (typeof expected === 'function') {
      if ((expected as (value: unknown) => unknown)(value) !== true)
        fail(
          `Inertia prop "${path}" does not satisfy the predicate (value ${show(value)})`,
        );
    } else if (!isDeepStrictEqual(value, expected))
      fail(
        `Expected Inertia prop "${path}" to equal ${show(expected)}, got ${show(value)}`,
      );
    return this;
  }

  /** Validation errors are present for every field (default bag shape). */
  hasErrors(...fields: string[]): this {
    const errors = this.prop<Record<string, unknown>>('errors');
    if (fields.length === 0 && sizeOf(errors) === 0)
      fail('Expected Inertia validation errors, got none');
    for (const field of fields)
      if (!Object.hasOwn(errors, field))
        fail(
          `Expected an Inertia validation error for "${field}", got ${show(Object.keys(errors))}`,
        );
    return this;
  }

  /** The `errors` prop is empty. */
  hasNoErrors(): this {
    const errors = this.prop('errors');
    if (sizeOf(errors) !== 0)
      fail(`Expected no Inertia validation errors, got ${show(errors)}`);
    return this;
  }

  /** Flash data `key` exists (and deep-equals `expected` when given). */
  flash(key: string, ...expected: [unknown?]): this {
    const flash = this.page.flash ?? {};
    if (!Object.hasOwn(flash, key))
      fail(`Expected Inertia flash "${key}", got ${show(Object.keys(flash))}`);
    if (expected.length && !isDeepStrictEqual(flash[key], expected[0]))
      fail(
        `Expected Inertia flash "${key}" to equal ${show(expected[0])}, got ${show(flash[key])}`,
      );
    return this;
  }

  /** `prop` is deferred (in `group` when given) and not yet in `props`. */
  deferred(prop: string, group?: string): this {
    const groups = this.page.deferredProps ?? {};
    const found = Object.entries(groups).some(
      ([name, props]) =>
        (group === undefined || name === group) && props.includes(prop),
    );
    if (!found)
      fail(
        `Expected Inertia prop "${prop}" to be deferred${group === undefined ? '' : ` in group "${group}"`}, got ${show(groups)}`,
      );
    return this.missing(prop);
  }
}

/**
 * Reads the page object from `response` (see {@link readInertiaPage}) and
 * returns fluent assertions; `component` is checked right away when given.
 */
export function assertInertia(
  response: InertiaResponseLike | string,
  component?: string,
  options: ReadInertiaPageOptions = {},
): AssertableInertiaPage {
  const { page, kind } = readInertiaPage(response, options);
  const assertable = new AssertableInertiaPage(page, kind);
  return component === undefined ? assertable : assertable.component(component);
}
