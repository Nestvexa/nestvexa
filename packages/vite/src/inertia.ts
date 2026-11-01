import type { ViteAssets } from './assets.js';
import { escapeHtml } from './html.js';

/**
 * The fields of `@nestvexa/inertia`'s `InertiaRootContext` this root view
 * reads. Declared structurally so this package does not depend on the Inertia
 * adapter.
 */
export interface InertiaRootContextLike {
  /** Inertia app key (for example `react`). */
  readonly app: string;
  readonly title: string;
  /** Trusted SSR head markup. */
  readonly head: string;
  /** Trusted page script plus root element (or SSR body). */
  readonly body: string;
  readonly nonce: string | undefined;
}

export interface ViteRootViewOptions {
  /** Document language. Default `en`. */
  readonly lang?: string;
  /** Vite app to use. Default: the Inertia app key of the request. */
  readonly app?: string | ((inertiaApp: string) => string);
  /** Trusted static markup appended to `<head>` (icons, meta). */
  readonly head?: string;
}

const langPattern = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

/**
 * Root view for `@nestvexa/inertia` that prints the Vite entry tags of the
 * matching app (with the request's CSP nonce) and the SSR head/body. When the
 * SSR head already contains a `<title>` (the framework `<Head>` component), the
 * configured title is not duplicated.
 */
export function viteInertiaRootView(
  assets: ViteAssets,
  options: ViteRootViewOptions = {},
): (context: InertiaRootContextLike) => string {
  const lang = options.lang ?? 'en';
  if (!langPattern.test(lang)) throw new TypeError('Invalid document language');
  const extra = options.head ?? '';
  const pick = options.app;
  return (context) => {
    const app =
      typeof pick === 'function' ? pick(context.app) : (pick ?? context.app);
    const title = /<title[\s>]/i.test(context.head)
      ? ''
      : `<title>${escapeHtml(context.title)}</title>`;
    return (
      `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">` +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      `${title}${assets.tags(app, { nonce: context.nonce })}${extra}${context.head}</head>` +
      `<body>${context.body}</body></html>`
    );
  };
}
