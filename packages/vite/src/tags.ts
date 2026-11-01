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
 * attribute is escaped.
 */
export function renderAssetTags(
  assets: ViteEntryAssets,
  options: ViteTagOptions = {},
): string {
  const nonce =
    options.nonce === undefined
      ? ''
      : ` nonce=${attribute(assertNonce(options.nonce))}`;
  const cross =
    options.crossOrigin === undefined
      ? ''
      : ` crossorigin=${attribute(options.crossOrigin)}`;
  const tags: string[] = [];
  if (nonce) tags.push(`<meta property="csp-nonce"${nonce}>`);
  for (const href of assets.styles)
    tags.push(`<link rel="stylesheet" href=${attribute(href)}${cross}>`);
  for (const href of assets.preloads)
    tags.push(
      `<link rel="modulepreload" href=${attribute(href)}${cross}${nonce}>`,
    );
  for (const src of assets.scripts)
    tags.push(
      `<script type="module" src=${attribute(src)}${cross}${nonce}></script>`,
    );
  return tags.join('');
}
