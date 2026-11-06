# @nestvexa/i18n

Optional internationalization for Nestvexa applications: explicit-allowlist locale
negotiation, namespaced JSON catalogs with a fallback chain, an ICU MessageFormat
subset (plural, selectordinal, select) backed by `Intl.PluralRules`, `Intl`
date/number/currency/relative-time formatting under an explicit time-zone policy,
per-locale text direction (`rtl`/`ltr`), Handlebars helpers, a request-scoped view
composer, a Nest module with an opt-in render interceptor, and a deterministic
translation-key extractor. Alpha software.

This package is **not** part of the default `nestvexa` install. Applications that
do not import it pay nothing for it.

## Installation

After owner-authorized publication: `npm install @nestvexa/i18n`,
`pnpm add @nestvexa/i18n` or `yarn add @nestvexa/i18n`. Before publication use the
workspace or packed tarballs.

- Node `^22.13.0 || ^24.0.0` (full ICU is the Node default), ESM only.
- Peers: `@nestjs/common` and `@nestjs/core` `^12`, `reflect-metadata ^0.2.2`,
  `rxjs ^7.8.2`.
- Dependency: `@nestvexa/views` (for `SafeHtml`, `ViewHelper`, `ViewComposer`).

## Minimal usage

```ts
import {
  I18n,
  I18nModule,
  LocaleViewInterceptor,
  loadCatalogs,
} from '@nestvexa/i18n';

const catalogs = await loadCatalogs('locales', { locales: ['en', 'ar'] });

@Module({
  imports: [
    NestvexaModule.forRoot({ views: { root: 'views', layout: 'layout' } }),
    I18nModule.forRoot({
      locales: ['en', { code: 'ar', label: 'العربية' }],
      defaultLocale: 'en',
      timeZone: 'UTC',
      catalogs,
    }),
  ],
  controllers: [ProductsController],
})
class AppModule {}

@Controller('products')
class ProductsController {
  @Get()
  @UseInterceptors(LocaleViewInterceptor)
  @Render('products')
  list() {
    return { count: 3 };
  }
}

const app = await NestFactory.create(AppModule);
// Register helpers before configureNestvexa(), which initializes the engine.
app.get(HbsEngine).registerHelpers(app.get(I18n).helpers());
await configureNestvexa(app);
```

`locales/en/common.json`:

```json
{
  "title": "Products",
  "count": "{count, plural, =0 {No products} one {# product} other {# products}}"
}
```

`views/layout.hbs` and `views/products.hbs`:

```hbs
<html lang='{{lang}}' dir='{{dir}}'><body>{{body}}</body></html>
<h1>{{t 'title'}}</h1><p>{{t 'count' count=count}}</p>
```

## Public API

### `new I18n(options)`

| Option             | Default   | Meaning                                                                                                                                    |
| ------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `locales`          | required  | 1–64 allowlisted tags or `{ code, dir?, label? }`. Canonicalized with `Intl.getCanonicalLocales`; duplicates rejected.                     |
| `defaultLocale`    | required  | Must be allowlisted.                                                                                                                       |
| `catalogs`         | required  | `{ [locale]: { [namespace]: nestedJson } }`. Validated, flattened and copied at construction; later mutation of the input has no effect.   |
| `timeZone`         | required  | IANA zone applied to every date format unless a call passes a validated `timeZone`. There is deliberately no implicit server-zone default. |
| `defaultNamespace` | `common`  | Namespace for keys without `ns:`.                                                                                                          |
| `fallbacks`        | derived   | Explicit chains, e.g. `{ 'ar-EG': ['ar'] }`. Default chain: locale → base language (when allowlisted) → `defaultLocale`.                   |
| `negotiation`      | see right | `{ query: 'lang' \| false, cookie: 'nv-locale' \| false, header: true }`.                                                                  |
| `missing`          | `key`     | `key` returns the key itself; `throw` raises `I18nError('MISSING')`.                                                                       |
| `onMissing`        | none      | `(key, locale) => void` observer (metrics/logging).                                                                                        |

Unknown options, accessors and non-plain objects fail with `I18nError('CONFIG')`.

### Instance members

- `locales`, `defaultLocale`, `timeZone`, `defaultNamespace` — frozen configuration.
- `definitions()` — `{ code, dir, label }[]`. Labels default to the endonym from
  `Intl.DisplayNames` (for example `العربية`).
- `match(candidate)` — exact allowlisted tag, then the base language, then the first
  allowlisted tag of the same language; otherwise `undefined`. It never returns an
  unlisted locale and rejects anything outside a bounded BCP 47 grammar.
- `negotiate(request)` — `{ locale, source }` where source is `query`, `cookie`,
  `header` or `default`. Precedence is query → cookie → `Accept-Language` (q-sorted,
  `q=0`/`*`/malformed entries skipped, at most 32 entries, header ignored above
  4096 characters) → default. Each unlisted candidate is skipped, not trusted. Query
  values come from `request.query` (Express/Fastify) or the raw `request.url`; arrays,
  objects and duplicate parameters are ignored. Cookies come from `request.cookies`
  or the raw `Cookie` header; duplicate cookie names are ignored.
- `forRequest(request)` — negotiates once per request object (WeakMap memo) and
  returns an `I18nContext`.
- `context(locale)` — frozen, cached `I18nContext` with `locale`, `dir`, `view`, `t`,
  `html`, `has`, `formatDate`, `formatNumber`, `formatCurrency`, `formatRelative`.
- `view(locale)` — JSON `{ locale, lang, dir, timeZone }` for view models.
- `dir(locale)` — the explicit definition, else `rtl` for an RTL script subtag (Arab,
  Hebr, Thaa, Syrc, Nkoo, Adlm) or language (ar, he, fa, ur, ps, dv, yi, ckb, sd, ug),
  else `ltr`. A non-RTL script subtag (for example `ku-Latn`) yields `ltr`.
- `t(locale, key, params?)` — **plain text**, not HTML-escaped. Render it through an
  escaping view (`{{ }}` in Handlebars) or as Live state.
- `html(locale, key, params?)` — `SafeHtml`: the catalog message is trusted markup
  and every interpolated value is HTML-escaped.
- `has(locale, key)` — whether any locale in the chain defines the key.
- `formatDate(locale, value, options?)`, `formatNumber(locale, value, options?)`,
  `formatCurrency(locale, value, currency, options?)`,
  `formatRelative(locale, value, { now?, unit?, numeric? }?)` — see Formatting.
- `helpers()` — Handlebars helpers (below).
- `composer()` — `ViewComposer<object>` returning `{ i18n: forRequest(request).view }`
  for `ViewEngineRegistry.render(..., composers)`.
- `localeCookie(locale, { secure?, maxAgeSeconds = 31536000, path = '/' }?)` — a
  `Set-Cookie` value (`SameSite=Lax`) for an allowlisted locale; throws otherwise.

### Messages

Keys are `namespace:path.to.key` or `path.to.key` (default namespace). Segments use
`[A-Za-z0-9_-]`; `__proto__`, `prototype` and `constructor` are rejected.

Supported ICU subset:

- `{name}` — strings verbatim, numbers locale-formatted, `Date` as a medium date in
  the policy zone, `null` as empty text. **A missing simple argument renders the
  literal placeholder `{name}`** so omissions are visible without failing a page.
- `{n, plural, =0 {…} one {# item} other {# items}}` — exact `=n` first, then the
  `Intl.PluralRules` category; `other` is required; `#` is the locale-formatted
  number. Missing/non-number arguments throw `I18nError('MESSAGE')`.
- `{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}`.
- `{g, select, female {…} other {…}}` — missing arguments throw.
- `{n, number}`, `{n, number, integer|percent}`, `{d, date[, short|medium|long|full]}`,
  `{d, time[, …]}`.
- Apostrophe quoting: `''` is one apostrophe; `'{literal}'` is literal text.

Unsupported (rejected with `I18nError('MESSAGE')`): `offset:`, `choice`, `spellout`,
`duration`, skeletons (`::`), currency/custom number styles, rich-text tags as
functions, and nesting deeper than 8 or messages over 8192 characters.
`formatMessage(locale, message, params?, { escape?, timeZone = 'UTC' }?)` formats one
standalone message. Plural rules and number formatting follow the language of the
catalog entry actually used (an English fallback inside an Arabic page uses English
rules).

### Formatting

All formatters accept an allowlist of `Intl` option keys per formatter; unknown keys,
accessors and non-primitive values throw `I18nError('FORMAT')`. Dates accept a `Date`,
epoch milliseconds or an ISO 8601 date/date-time string — other strings are rejected
rather than parsed loosely. Currency codes must match `^[A-Z]{3}$`. `formatRelative`
picks second/minute/hour/day/week/month/year automatically unless `unit` is given;
`numeric` defaults to `auto` ("yesterday"). Formatters and plural rules are cached in
bounded maps.

### Handlebars helpers

Register with `HbsEngine.registerHelpers(i18n.helpers())` before `initialize()` /
`configureNestvexa()`. Helpers read the locale from the root model's `i18n.locale`
(provided by `LocaleViewInterceptor`, `composer()` or a Live `@Computed`), re-validate
it with `match()`, and fall back to `defaultLocale`. Hash arguments become params.

| Helper           | Example                                     | Returns                      |
| ---------------- | ------------------------------------------- | ---------------------------- |
| `t`              | `{{t "products:count" count=n}}`            | text (escaped by Handlebars) |
| `tHtml`          | `{{tHtml "welcome" name=user}}`             | `SafeHtml`, params escaped   |
| `formatDate`     | `{{formatDate createdAt dateStyle="long"}}` | text                         |
| `formatNumber`   | `{{formatNumber ratio style="percent"}}`    | text                         |
| `formatCurrency` | `{{formatCurrency price "EUR"}}`            | text                         |
| `formatRelative` | `{{formatRelative updatedAt}}`              | text                         |
| `dir`, `lang`    | `<html lang="{{lang}}" dir="{{dir}}">`      | `rtl`/`ltr`, locale tag      |

### Nest integration

- `I18nModule.forRoot(options, { global?: false })` and
  `I18nModule.forRootAsync({ imports?, inject?, useFactory, global? })` provide and
  export the `I18n` instance (class token `I18n`) and `LocaleViewInterceptor`.
- `LocaleViewInterceptor` (opt-in with `@UseInterceptors`) acts only on handlers with
  `@Render` metadata: it merges `{ i18n: view }` into plain-object results (a result
  that already has `i18n` is an error, never silently overwritten), sets
  `Content-Language` and appends `Vary: Accept-Language, Cookie`. JSON and other
  handlers are untouched.

### `@nestvexa/i18n/extract`

- `extractKeys(sources, { defaultNamespace?, functions? })` — literal keys from `.hbs`
  (`{{t "k"}}`, `{{tHtml 'k'}}`, `(t "k")`) and `.ts` (`t('k')`, `x.t("k")`,
  `i18n.t(locale, 'k')`, `i18n.html(locale, 'k')`). Non-literal keys are reported as
  `{ file, line, reason: 'dynamic' }`, invalid literals as `reason: 'invalid'`.
- `extractFromDirectory(root, { extensions?, defaultNamespace?, functions? })` —
  sorted walk, skips `node_modules`, `dist`, dot-directories, `.d.ts` and symlinks.
- `missingKeys(extracted, catalogs, locales)` — full keys absent per locale (no
  fallback applied, so every locale is checked independently).
- `serializeKeys(extracted, missing?)` — stable JSON with a trailing newline.
- CLI: `nestvexa-i18n-extract <root> [--out file] [--namespace common]
[--catalogs dir --locales en,ar]` exits `1` when catalogs miss keys and `2` on
  invalid arguments. Output contains no timestamps or absolute paths.

`loadCatalogs(directory, { locales, namespaces?, maxBytes = 1 MiB })` reads
`<directory>/<locale>/<namespace>.json` only for the listed canonical locales.
Locale/namespace names are grammar-checked before any path is built, real paths must
stay inside `directory`, symlinked locale directories are rejected, and every file
is validated with the same rules as `new I18n`.

### Client hydration (`@nestvexa/i18n/client`)

Islands, Inertia pages and other browser renderers get an explicit subset:

```ts
// Server: HBS page or Inertia shared props
const hydration = i18n.hydration(context.locale, {
  namespaces: ['products'],
  keys: ['common:save'],
});
// HBS: {{{i18nScript}}} with i18nScript = i18n.hydrationScript(hydration)
// Inertia: share({ i18n: hydration })
```

```ts
// Browser (bundled with Vite or served as ES modules)
import { createClientI18n, readLocaleHydration } from '@nestvexa/i18n/client';
const hydration = readLocaleHydration(document); // or page.props.i18n
const i18n = hydration ? createClientI18n(hydration) : undefined;
i18n?.t('products:count', { count: 3 }); // same ICU subset as the server
```

- `hydration(locale, { namespaces?, keys? })` publishes nothing by default: at
  least one namespace or key is required, values are resolved through the
  fallback chain (fallback languages recorded in `messageLocales` so plural
  rules follow them), and the subset is capped at 2000 messages / 256 KiB.
- `hydrationScript(payload, id = 'nv-i18n')` writes
  `<script type="application/json">` with `<`, `>`, `&`, U+2028 and U+2029
  escaped, so catalog text cannot close the element (CSP-friendly: data, not
  script).
- `parseLocaleHydration` / `readLocaleHydration` validate untrusted payloads
  (locale tags, direction, time zone, key grammar, no prototype keys).
  `createClientI18n` returns `{ locale, lang, dir, timeZone, t, has,
formatNumber, formatDate }`; `t` returns plain text for framework text
  rendering and falls back to the key. The entry imports only the pure message
  formatter (enforced by `scripts/boundaries.mjs`).

## Live components

Negotiate per request; never store the locale in writable or `@Locked` state and
never pass it to `authorize`:

```ts
@LiveComponent({ name: 'product-form', view: 'product-form' })
export class ProductForm {
  constructor(
    @Inject(I18n) private readonly translations: I18n,
    @Inject(REQUEST) private readonly request: object,
  ) {}
  @State({ writable: true }) name = '';
  @State() error = '';
  @Computed() get i18n() {
    return this.translations.forRequest(this.request).view;
  }
  @Action() save(): void {
    const t = this.translations.forRequest(this.request);
    this.error =
      this.name.length < 2 ? t.t('validation.nameShort', { min: 2 }) : '';
  }
}
```

Computed values are evaluated on every render, so a locale switch takes effect on
the next Live request without invalidating snapshots. Messages stored in state
(like `error`) keep the language they were produced in until the next action.

## Security

- Locales come only from the allowlist; query, cookie and header values are
  grammar-checked and matched, never echoed. CR/LF, `<`, `;`, oversize and
  prototype-named values fall through to the next source.
- Catalogs are validated own-data-property trees copied into internal `Map`s;
  `__proto__` (including own keys produced by `JSON.parse`), `prototype`,
  `constructor`, accessors, symbols, arrays and non-string leaves are rejected.
  Limits: depth 16, 8192 characters per message, 100,000 entries and 8 MiB in total.
- `t` returns text; `html`/`tHtml` escape every interpolated value. Catalog markup is
  trusted application content — never load catalogs from users.
- Escaping does not make values safe in URL, script or style contexts.
- `Intl` options are allowlisted per formatter; dates in an explicit zone avoid
  server-zone-dependent output.
- Direction and locale are presentation only. Do not use them in authorization,
  realtime channel names or snapshot identity.

## Caching

HTML varies by locale: shared caches must key on the negotiated locale (the
interceptor sets `Vary: Accept-Language, Cookie` and `Content-Language`). Live
snapshots are locale-free when the locale is a `@Computed`. Fragment caches must
include `locale` (and `timeZone` if it can vary) in their keys.

## Testing

```sh
pnpm --filter @nestvexa/views build
pnpm --filter @nestvexa/engine-hbs build
pnpm --filter @nestvexa/i18n build
pnpm exec vitest run tests/i18n-
```

Suites: [negotiation](../../tests/i18n-negotiation.test.ts),
[messages and formatting](../../tests/i18n-messages.test.ts),
[HBS and Nest](../../tests/i18n-hbs.test.ts),
[security](../../tests/i18n-security.test.ts),
[extraction](../../tests/i18n-extract.test.ts),
[client hydration](../../tests/i18n-hydration.test.ts).

## Production caveats and compatibility

- Browser hydration is explicit (`hydration()` + `@nestvexa/i18n/client`); no
  catalog is published automatically. The client entry is not a separate
  single-file bundle: serve it through your bundler (it has relative imports).
- No email/notification template bridge is shipped yet; render mail bodies with
  your view engine and send them with your Nest mail integration.
- ICU subset only (see above). Output depends on the Node ICU/CLDR data version;
  pin Node in production and snapshot-test critical strings.
- Catalogs load at startup; reload requires a new `I18n` instance (restart).
- Extraction is regex-based over trusted sources; keys in comments are extracted
  and computed keys must be listed manually.

Node 22/24, NestJS 12, Express and Fastify request shapes. Guide:
[docs/guides/i18n.md](../../docs/guides/i18n.md). Example:
[examples/admin-i18n](../../examples/admin-i18n). Changes:
[CHANGELOG](../../CHANGELOG.md).
