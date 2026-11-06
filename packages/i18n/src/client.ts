/**
 * Browser-safe locale hydration for islands, Inertia pages and other client
 * renderers. It imports only the pure message formatter (no Node, Nest or
 * catalog loading) and renders the same ICU subset as the server.
 */
import { I18nError } from './errors.js';
import { assertTimeZone } from './format.js';
import { canonicalLocale } from './locale.js';
import type { TextDirection } from './locale.js';
import { maxMessageLength, renderMessage } from './message.js';
import type { MessageParams } from './message.js';

/** Same shape as the server's `I18n.hydration()` result. */
export interface LocaleHydration {
  readonly locale: string;
  readonly lang: string;
  readonly dir: TextDirection;
  readonly timeZone: string;
  readonly defaultNamespace: string;
  readonly messages: Readonly<Record<string, string>>;
  readonly messageLocales: Readonly<Record<string, string>>;
}
export interface ClientI18n {
  readonly locale: string;
  readonly lang: string;
  readonly dir: TextDirection;
  readonly timeZone: string;
  /** Plain text. Render it as text (JSX `{}`, Vue `{{ }}`), never as HTML. */
  t(key: string, params?: MessageParams): string;
  has(key: string): boolean;
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string;
  formatDate(
    value: Date | number,
    options?: Intl.DateTimeFormatOptions,
  ): string;
}

const maxMessages = 2000;
const keyPattern =
  /^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}(?:\.[A-Za-z0-9_-]{1,64})*$/;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

function invalid(): never {
  throw new I18nError('CONFIG', 'Invalid locale hydration payload');
}
function field(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function stringMap(
  value: unknown,
  check: (key: string, entry: string) => boolean,
): Readonly<Record<string, string>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid();
  const output: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  const keys = Object.keys(value);
  if (keys.length > maxMessages) invalid();
  for (const key of keys) {
    const entry = field(value, key);
    if (
      typeof entry !== 'string' ||
      !keyPattern.test(key) ||
      key.split(/[:.]/).some((part) => forbidden.has(part)) ||
      !check(key, entry)
    )
      invalid();
    output[key] = entry;
  }
  return Object.freeze(output);
}

/** Validate untrusted JSON (for example from the page) as a hydration payload. */
export function parseLocaleHydration(value: unknown): LocaleHydration {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid();
  const locale = canonicalLocale(field(value, 'locale'));
  const lang = canonicalLocale(field(value, 'lang'));
  const dir = field(value, 'dir');
  const zone = field(value, 'timeZone');
  const namespace = field(value, 'defaultNamespace');
  if (!locale || !lang || (dir !== 'ltr' && dir !== 'rtl')) invalid();
  if (typeof namespace !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(namespace))
    invalid();
  let timeZone: string;
  try {
    timeZone = assertTimeZone(zone);
  } catch {
    invalid();
  }
  const messages = stringMap(
    field(value, 'messages'),
    (_key, message) => message.length <= maxMessageLength,
  );
  const messageLocales = stringMap(
    field(value, 'messageLocales') ?? {},
    (key, tag) => key in messages && canonicalLocale(tag) === tag,
  );
  return Object.freeze({
    locale,
    lang,
    dir,
    timeZone,
    defaultNamespace: namespace,
    messages,
    messageLocales,
  });
}

/** Structural document subset, so this module needs no DOM typings. */
export interface HydrationDocument {
  getElementById(id: string): { readonly textContent: string | null } | null;
}
/** Read the `<script type="application/json">` written by `hydrationScript()`. */
export function readLocaleHydration(
  doc: HydrationDocument,
  id = 'nv-i18n',
): LocaleHydration | undefined {
  const text = doc.getElementById(id)?.textContent;
  if (!text || text.length > 512 * 1024) return undefined;
  try {
    return parseLocaleHydration(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** Translator over a hydrated subset. Missing keys render as the key itself. */
export function createClientI18n(input: LocaleHydration): ClientI18n {
  const hydration = parseLocaleHydration(input);
  const full = (key: string): string =>
    key.includes(':') ? key : `${hydration.defaultNamespace}:${key}`;
  const lookup = (key: string): string | undefined =>
    Object.prototype.hasOwnProperty.call(hydration.messages, full(key))
      ? hydration.messages[full(key)]
      : undefined;
  return Object.freeze({
    locale: hydration.locale,
    lang: hydration.lang,
    dir: hydration.dir,
    timeZone: hydration.timeZone,
    t(key: string, params?: MessageParams): string {
      const message = lookup(key);
      if (message === undefined) return key;
      const locale = hydration.messageLocales[full(key)] ?? hydration.locale;
      return renderMessage(message, locale, params, false, hydration.timeZone);
    },
    has: (key: string) => lookup(key) !== undefined,
    formatNumber: (value: number, options?: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat(hydration.locale, options).format(value),
    formatDate: (value: Date | number, options?: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(hydration.locale, {
        timeZone: hydration.timeZone,
        ...options,
      }).format(value),
  });
}
