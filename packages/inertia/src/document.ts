import { SafeHtml } from '@nestvexa/views';
import type { ViewEngineAdapter, ViewModel } from '@nestvexa/views';
import type { InertiaPageObject } from './page.js';
import { escapeHtml } from './serialize.js';

/** Everything a root template needs to produce the initial HTML document. */
export interface InertiaRootContext {
  readonly page: InertiaPageObject;
  /** Configured app key (for example `react`). */
  readonly app: string;
  /** DOM id used by `data-page` and the mount element. */
  readonly id: string;
  /** Escaped `<head>` markup: SSR head elements (if any). */
  readonly head: string;
  /** Page script + mount element (or SSR body). Already safe to print raw. */
  readonly body: string;
  /** Document title (escaped by renderers). */
  readonly title: string;
  readonly scripts: readonly string[];
  readonly styles: readonly string[];
  readonly nonce: string | undefined;
  readonly request: object;
  /** Host-supplied render data (never sent to the client). */
  readonly viewData: Readonly<Record<string, unknown>>;
}

export type InertiaRootView = (
  context: InertiaRootContext,
) => string | Promise<string>;

function attribute(value: string): string {
  return `"${escapeHtml(value)}"`;
}

/** Builds `<script>`/`<link>` tags for the configured entry assets. */
export function assetTags(context: InertiaRootContext): string {
  const nonce =
    context.nonce === undefined ? '' : ` nonce=${attribute(context.nonce)}`;
  const styles = context.styles.map(
    (href) => `<link rel="stylesheet" href=${attribute(href)}>`,
  );
  const scripts = context.scripts.map(
    (src) => `<script type="module" src=${attribute(src)}${nonce}></script>`,
  );
  return [...styles, ...scripts].join('');
}

/** Default root view: a minimal, valid HTML5 document. */
export const defaultRootView: InertiaRootView = (context) =>
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  `<title>${escapeHtml(context.title)}</title>${assetTags(context)}${context.head}</head>` +
  `<body>${context.body}</body></html>`;

export interface ViewRootOptions {
  /** Extra template model derived per render (never sent to the client). */
  readonly model?: (context: InertiaRootContext) => ViewModel;
}

/**
 * Root view rendered by a Nestvexa `ViewEngineAdapter` (for example HBS). The
 * template receives `inertiaHead`, `inertiaBody` and `inertiaAssets` as trusted
 * `SafeHtml` (print with `{{inertiaBody}}` in Handlebars), plus `inertiaTitle`
 * as text and any `viewData`/`model` entries.
 */
export function viewRootView(
  engine: ViewEngineAdapter,
  view: string,
  options: ViewRootOptions = {},
): InertiaRootView {
  return (context) =>
    engine.render(
      view,
      {
        ...context.viewData,
        ...(options.model ? options.model(context) : {}),
        inertiaTitle: context.title,
        inertiaHead: SafeHtml.trusted(context.head),
        inertiaBody: SafeHtml.trusted(context.body),
        inertiaAssets: SafeHtml.trusted(assetTags(context)),
      },
      { layout: false },
    );
}
