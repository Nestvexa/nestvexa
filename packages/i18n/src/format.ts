import { BoundedCache, I18nError, forbiddenKeys } from './errors.js';

type Primitive = string | number | boolean;
const dateKeys: ReadonlySet<string> = new Set([
  'dateStyle',
  'timeStyle',
  'weekday',
  'era',
  'year',
  'month',
  'day',
  'dayPeriod',
  'hour',
  'minute',
  'second',
  'fractionalSecondDigits',
  'timeZoneName',
  'hour12',
  'hourCycle',
  'calendar',
  'numberingSystem',
  'timeZone',
]);
const numberKeys: ReadonlySet<string> = new Set([
  'style',
  'currency',
  'currencyDisplay',
  'currencySign',
  'unit',
  'unitDisplay',
  'minimumIntegerDigits',
  'minimumFractionDigits',
  'maximumFractionDigits',
  'minimumSignificantDigits',
  'maximumSignificantDigits',
  'notation',
  'compactDisplay',
  'signDisplay',
  'useGrouping',
  'numberingSystem',
  'roundingMode',
]);
const currencyKeys: ReadonlySet<string> = new Set([
  'currencyDisplay',
  'currencySign',
  'minimumFractionDigits',
  'maximumFractionDigits',
  'signDisplay',
  'useGrouping',
  'notation',
  'compactDisplay',
  'numberingSystem',
]);
const relativeUnits: ReadonlySet<string> = new Set([
  'second',
  'minute',
  'hour',
  'day',
  'week',
  'month',
  'quarter',
  'year',
]);
const unitSeconds: Readonly<Record<string, number>> = Object.freeze({
  second: 1,
  minute: 60,
  hour: 3600,
  day: 86_400,
  week: 604_800,
  month: 2_629_800,
  quarter: 7_889_400,
  year: 31_557_600,
});
const isoDate =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
const currencyCode = /^[A-Z]{3}$/;

const dateFormats = new BoundedCache<Intl.DateTimeFormat>(256);
const numberFormats = new BoundedCache<Intl.NumberFormat>(256);
const relativeFormats = new BoundedCache<Intl.RelativeTimeFormat>(64);
const pluralRules = new BoundedCache<Intl.PluralRules>(128);
const validZones = new BoundedCache<boolean>(256);

/**
 * Copies allowlisted own primitive data properties. Unknown keys fail closed so
 * templates cannot smuggle arbitrary Intl options or prototype values.
 */
export function pickOptions(
  input: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): Record<string, Primitive> {
  const result: Record<string, Primitive> = Object.create(null) as Record<
    string,
    Primitive
  >;
  if (input === undefined || input === null) return result;
  if (typeof input !== 'object' || Array.isArray(input))
    throw new I18nError('FORMAT', `Invalid ${label} options`);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || forbiddenKeys.has(key) || !allowed.has(key))
      throw new I18nError('FORMAT', `Unsupported ${label} option`);
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor))
      throw new I18nError('FORMAT', `Invalid ${label} option`);
    const value: unknown = descriptor.value;
    if (value === undefined) continue;
    if (
      typeof value !== 'string' &&
      typeof value !== 'boolean' &&
      !(typeof value === 'number' && Number.isFinite(value))
    )
      throw new I18nError('FORMAT', `Invalid ${label} option value`);
    result[key] = value;
  }
  return result;
}

function cacheKey(locale: string, options: Record<string, Primitive>): string {
  return (
    locale +
    '\u0000' +
    Object.keys(options)
      .sort()
      .map((key) => `${key}=${String(options[key])}`)
      .join('\u0001')
  );
}

export function assertTimeZone(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64)
    throw new I18nError('FORMAT', 'Invalid time zone');
  if (validZones.get(value)) return value;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
  } catch {
    throw new I18nError('FORMAT', 'Unsupported time zone');
  }
  validZones.set(value, true);
  return value;
}

export function assertCurrency(value: unknown): string {
  if (typeof value !== 'string' || !currencyCode.test(value))
    throw new I18nError('FORMAT', 'Currency must be an ISO 4217 code');
  return value;
}

/** Accepts Date, epoch milliseconds or an ISO 8601 date/date-time string. */
export function toDate(value: unknown): Date {
  let date: Date | undefined;
  if (value instanceof Date) date = new Date(value.getTime());
  else if (typeof value === 'number' && Number.isFinite(value))
    date = new Date(value);
  else if (typeof value === 'string' && isoDate.test(value))
    date = new Date(value);
  if (!date || Number.isNaN(date.getTime()))
    throw new I18nError('FORMAT', 'Invalid date value');
  return date;
}

function wrap<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof I18nError) throw error;
    throw new I18nError('FORMAT', 'Intl rejected the format options', {
      cause: error,
    });
  }
}

export function formatDateValue(
  locale: string,
  value: unknown,
  options: unknown,
  policyTimeZone: string,
): string {
  const picked = pickOptions(options, dateKeys, 'date');
  picked['timeZone'] =
    picked['timeZone'] === undefined
      ? policyTimeZone
      : assertTimeZone(picked['timeZone']);
  const date = toDate(value);
  const key = cacheKey(locale, picked);
  const formatter =
    dateFormats.get(key) ??
    dateFormats.set(
      key,
      wrap(() => new Intl.DateTimeFormat(locale, picked)),
    );
  return formatter.format(date);
}

function numberFormatter(
  locale: string,
  picked: Record<string, Primitive>,
): Intl.NumberFormat {
  if (picked['currency'] !== undefined) assertCurrency(picked['currency']);
  const key = cacheKey(locale, picked);
  return (
    numberFormats.get(key) ??
    numberFormats.set(
      key,
      wrap(() => new Intl.NumberFormat(locale, picked)),
    )
  );
}

function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new I18nError('FORMAT', 'Number value must be finite');
  return value;
}

export function formatNumberValue(
  locale: string,
  value: unknown,
  options: unknown,
): string {
  const number = finite(value);
  return numberFormatter(
    locale,
    pickOptions(options, numberKeys, 'number'),
  ).format(number);
}

export function formatCurrencyValue(
  locale: string,
  value: unknown,
  currency: unknown,
  options: unknown,
): string {
  const number = finite(value);
  const picked = pickOptions(options, currencyKeys, 'currency');
  picked['style'] = 'currency';
  picked['currency'] = assertCurrency(currency);
  return numberFormatter(locale, picked).format(number);
}

export interface RelativeOptions {
  readonly now?: Date | number | string;
  readonly unit?: Intl.RelativeTimeFormatUnit;
  readonly numeric?: 'always' | 'auto';
}

export function formatRelativeValue(
  locale: string,
  value: unknown,
  options: unknown,
): string {
  const picked = pickOptions(
    options,
    new Set(['now', 'unit', 'numeric']),
    'relative time',
  );
  const now =
    picked['now'] === undefined ? Date.now() : toDate(picked['now']).getTime();
  const numeric = picked['numeric'] ?? 'auto';
  if (numeric !== 'auto' && numeric !== 'always')
    throw new I18nError('FORMAT', 'numeric must be auto or always');
  const seconds = (toDate(value).getTime() - now) / 1000;
  let unit: string;
  if (picked['unit'] !== undefined) {
    const requested = String(picked['unit']).replace(/s$/, '');
    if (!relativeUnits.has(requested))
      throw new I18nError('FORMAT', 'Unsupported relative time unit');
    unit = requested;
  } else {
    const absolute = Math.abs(seconds);
    unit =
      absolute < 60
        ? 'second'
        : absolute < 3600
          ? 'minute'
          : absolute < 86_400
            ? 'hour'
            : absolute < 604_800
              ? 'day'
              : absolute < 2_629_800
                ? 'week'
                : absolute < 31_557_600
                  ? 'month'
                  : 'year';
  }
  const amount = Math.round(seconds / (unitSeconds[unit] ?? 1));
  const key = `${locale}\u0000${numeric}`;
  const formatter =
    relativeFormats.get(key) ??
    relativeFormats.set(
      key,
      wrap(() => new Intl.RelativeTimeFormat(locale, { numeric })),
    );
  // Normalizes -0 so "0 seconds ago" and "now" stay consistent.
  return formatter.format(
    amount === 0 ? 0 : amount,
    unit as Intl.RelativeTimeFormatUnit,
  );
}

export function pluralCategory(
  locale: string,
  value: number,
  type: Intl.PluralRuleType,
): string {
  const key = `${locale}\u0000${type}`;
  const rules =
    pluralRules.get(key) ??
    pluralRules.set(
      key,
      wrap(() => new Intl.PluralRules(locale, { type })),
    );
  return rules.select(value);
}

export function plainNumber(locale: string, value: number): string {
  return numberFormatter(
    locale,
    Object.create(null) as Record<string, Primitive>,
  ).format(value);
}
