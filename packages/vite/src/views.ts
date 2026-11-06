import { SafeHtml } from '@nestvexa/views';
import type { ViewHelper } from '@nestvexa/views';
import type { ViteAssets } from './assets.js';
import { ViteConfigurationError } from './errors.js';

export interface ViteViewHelperOptions {
  /** Helper name. Default `viteTags`. */
  readonly name?: string;
  /** Vite app used when a template names none. Default: the only configured app. */
  readonly app?: string;
}

const namePattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

interface Call {
  readonly app: string | undefined;
  readonly nonce: string | undefined;
}

/**
 * Reads `(app?, options?)`. Handlebars appends its options object, whose
 * `hash` holds `nonce=...`; EJS, Pug and Nunjucks pass a plain
 * `{ nonce }` object instead.
 */
function parse(name: string, args: readonly unknown[]): Call {
  let rest = [...args];
  let app: string | undefined;
  if (typeof rest[0] === 'string') {
    app = rest[0];
    rest = rest.slice(1);
  }
  if (rest.length > 1)
    throw new ViteConfigurationError(`${name} accepts an app name and a nonce`);
  const last = rest[0];
  if (last === undefined) return { app, nonce: undefined };
  if (typeof last !== 'object' || last === null || Array.isArray(last))
    throw new ViteConfigurationError(`${name} accepts an app name and a nonce`);
  const hash: unknown = 'hash' in last ? Reflect.get(last, 'hash') : last;
  if (typeof hash !== 'object' || hash === null)
    throw new ViteConfigurationError(`${name} accepts an app name and a nonce`);
  for (const key of Object.keys(hash))
    if (key !== 'nonce')
      throw new ViteConfigurationError(`${name} does not accept "${key}"`);
  const nonce: unknown = Reflect.get(hash, 'nonce');
  // A template that names a missing variable passes undefined/null; anything
  // else must be a string (validated by the tag renderer).
  if (nonce !== undefined && nonce !== null && typeof nonce !== 'string')
    throw new ViteConfigurationError(`${name} nonce must be a string`);
  return { app, nonce: typeof nonce === 'string' ? nonce : undefined };
}

/**
 * Trusted view helpers for server-rendered pages (HBS, Live layouts and the
 * other engines) that print the Vite manifest tags of an app: the CSP nonce
 * meta, stylesheets, module preloads and entry scripts, each carrying the
 * request's nonce. Register them on the engine before it initializes:
 *
 * ```ts
 * engine.registerHelpers(viteViewHelpers(assets));
 * // layout.hbs: {{viteTags "admin" nonce=cspNonce}}
 * ```
 *
 * Tags come from the manifest resolved at startup, never from template data,
 * and every attribute is escaped; only the nonce is per request.
 */
export function viteViewHelpers(
  assets: ViteAssets,
  options: ViteViewHelperOptions = {},
): Readonly<Record<string, ViewHelper>> {
  const name = options.name ?? 'viteTags';
  if (!namePattern.test(name))
    throw new ViteConfigurationError(`Invalid helper name ${name}`);
  const fallback =
    options.app ?? (assets.apps.length === 1 ? assets.apps[0] : undefined);
  if (fallback !== undefined) assets.entry(fallback);
  const helper: ViewHelper = (...args: unknown[]) => {
    const call = parse(name, args);
    const app = call.app ?? fallback;
    if (app === undefined)
      throw new ViteConfigurationError(
        `${name} needs an app name when several Vite apps are configured`,
      );
    return SafeHtml.trusted(assets.tags(app, { nonce: call.nonce }));
  };
  return Object.freeze({ [name]: helper });
}
