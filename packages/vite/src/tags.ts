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
