import { I18n, loadCatalogs } from '@nestvexa/i18n';
import type { I18nContext } from '@nestvexa/i18n';
import { join } from 'node:path';
import { exampleRoot, origin } from './config.js';

/*
 * English and Arabic (right to left). The locale comes from the allowlist
 * only: `?lang=`, then the `nv-locale` cookie set by the switch form, then
 * Accept-Language, then English. It is presentation only: never part of an
 * identity binding, a realtime channel or a Live snapshot.
 */
const catalogs = await loadCatalogs(join(exampleRoot, 'locales'), {
  locales: ['en', 'ar'],
  namespaces: ['common', 'islands', 'insights'],
});

export const i18n = new I18n({
  locales: ['en', { code: 'ar', dir: 'rtl', label: 'العربية' }],
  defaultLocale: 'en',
  timeZone: 'UTC',
  catalogs,
});

/** The negotiated context of one request (memoized per request object). */
export function translator(request: object): I18nContext {
  return i18n.forRequest(request);
}

/** The switch form's buttons, the current locale marked. */
export function localeChoices(request: object) {
  const current = translator(request).locale;
  return i18n.definitions().map((definition) => ({
    code: definition.code,
    label: definition.label,
    dir: definition.dir,
    pressed: definition.code === current ? 'true' : 'false',
  }));
}

/** The cookie the switch form sets; Secure on HTTPS origins. */
export function localeCookie(locale: string): string {
  return i18n.localeCookie(locale, { secure: origin.startsWith('https:') });
}

/** Pages the switch may return to (no open redirect). */
export function safeReturn(value: unknown): string {
  return typeof value === 'string' &&
    /^\/(?:(?:app(?:\/(?:tasks|profile|outbox))?|insights(?:\/goals)?|login))?$/.test(
      value,
    )
    ? value
    : '/';
}
