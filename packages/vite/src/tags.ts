import { assertNonce, attribute } from './html.js';
import type { ViteEntryAssets } from './manifest.js';

export interface ViteTagOptions {
  /** Per-request CSP nonce added to scripts, preloads and the nonce meta. */
  readonly nonce?: string | undefined;
  /** `crossorigin` value for module scripts/preloads (needed for CDN bases). */
  readonly crossOrigin?: 'anonymous' | 'use-credentials' | undefined;
}

/**
 * Renders `<head>` tags for resolved entry assets: an optional
 * `<meta property="csp-nonce">` (read by Vite's preload helper for chunks and
 * CSS it injects later), stylesheets, module preloads and entry scripts. Every
 * attribute is escaped. Assets with integrity metadata get `integrity` and a
 * `crossorigin` attribute (`anonymous` unless configured), which browsers
 * need to check the hash of cross-origin (CDN) responses.
 */
export function renderAssetTags(
  assets: ViteEntryAssets,
  options: ViteTagOptions = {},
): string {
  const nonce =
    options.nonce === undefined
      ? ''
      : ` nonce=${attribute(assertNonce(options.nonce))}`;
  const integrity = assets.integrity ?? {};
  const extra = (url: string): string => {
    const hash = Object.hasOwn(integrity, url) ? integrity[url] : undefined;
    const cross = options.crossOrigin ?? (hash ? 'anonymous' : undefined);
    return `${cross === undefined ? '' : ` crossorigin=${attribute(cross)}`}${
      hash === undefined ? '' : ` integrity=${attribute(hash)}`
    }`;
  };
  const tags: string[] = [];
  if (nonce) tags.push(`<meta property="csp-nonce"${nonce}>`);
  for (const href of assets.styles)
    tags.push(`<link rel="stylesheet" href=${attribute(href)}${extra(href)}>`);
  for (const href of assets.preloads)
    tags.push(
      `<link rel="modulepreload" href=${attribute(href)}${extra(href)}${nonce}>`,
    );
  for (const src of assets.scripts)
    tags.push(
      `<script type="module" src=${attribute(src)}${extra(src)}${nonce}></script>`,
    );
  return tags.join('');
}

/**
 * One `103 Early Hints` link, structurally identical to `EarlyHint` from
 * `@nestvexa/core` (pass the list to its `sendEarlyHints`).
 */
export interface ViteEarlyHint {
  readonly href: string;
  readonly rel: 'modulepreload' | 'preload';
  readonly as?: 'style';
  readonly crossOrigin?: 'anonymous' | 'use-credentials';
}

/** Root-relative (not protocol-relative) path or `https:` URL. */
const hintable = (url: string): boolean =>
  (url.startsWith('/') && !url.startsWith('//')) || url.startsWith('https://');

/**
 * Early Hints for resolved entry assets: stylesheets as `preload` (`as=style`)
 * and entry scripts plus their static imports as `modulepreload`, with the
 * same `crossorigin` the tags carry. URLs that are neither root-relative nor
 * `https:` (a relative Vite `base`) are left out.
 */
export function assetEarlyHints(
  assets: ViteEntryAssets,
  options: Pick<ViteTagOptions, 'crossOrigin'> = {},
): readonly ViteEarlyHint[] {
  const integrity = assets.integrity ?? {};
  const cross = (url: string): Pick<ViteEarlyHint, 'crossOrigin'> => {
    const value =
      options.crossOrigin ??
      (Object.hasOwn(integrity, url) ? 'anonymous' : undefined);
    return value === undefined ? {} : { crossOrigin: value };
  };
  const hints: ViteEarlyHint[] = [];
  for (const href of assets.styles)
    if (hintable(href))
      hints.push({ href, rel: 'preload', as: 'style', ...cross(href) });
  for (const href of [...assets.scripts, ...assets.preloads])
    if (hintable(href))
      hints.push({ href, rel: 'modulepreload', ...cross(href) });
  return Object.freeze(hints);
}
