export type TextDirection = 'ltr' | 'rtl';

const tagPattern = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,7}$/;
const rtlLanguages: ReadonlySet<string> = new Set([
  'ar',
  'he',
  'iw',
  'fa',
  'ur',
  'ps',
  'dv',
  'yi',
  'ji',
  'ckb',
  'sd',
  'ug',
]);
const rtlScripts: ReadonlySet<string> = new Set([
  'Arab',
  'Hebr',
  'Thaa',
  'Syrc',
  'Nkoo',
  'Adlm',
]);

/**
 * Canonical BCP 47 tag for a bounded, grammar-checked string, or undefined.
 * Control characters, separators other than `-`, and oversized input are rejected
 * before Intl sees them.
 */
export function canonicalLocale(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 35 || !tagPattern.test(value))
    return undefined;
  try {
    const [canonical] = Intl.getCanonicalLocales(value);
    return canonical;
  } catch {
    return undefined;
  }
}

/** Primary language subtag of a canonical tag. */
export function baseLanguage(locale: string): string {
  return new Intl.Locale(locale).language;
}

/** Direction from the script subtag when present, else from the language. */
export function inferDirection(locale: string): TextDirection {
  const parsed = new Intl.Locale(locale);
  if (parsed.script) return rtlScripts.has(parsed.script) ? 'rtl' : 'ltr';
  return rtlLanguages.has(parsed.language) ? 'rtl' : 'ltr';
}

/** Endonym such as "العربية" for ar; falls back to the tag itself. */
export function endonym(locale: string): string {
  try {
    return (
      new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale
    );
  } catch {
    return locale;
  }
}
