import {
  SafeHtml,
  TemplateRoot,
  ViewError,
  copyViewModel,
  expressViewModel,
  type RenderOptions,
  type ViewCapabilities,
  type ViewEngineAdapter,
  type ViewModel,
} from '@nestvexa/views';

/**
 * A third-party view-engine adapter (MAINT-007), built outside the Nestvexa
 * repository against the packed `@nestvexa/views` public API only. Its
 * template language prints `{{ name }}` escaped; only server `SafeHtml`
 * (Live mounts, a layout's `{{ body }}`) is emitted unescaped.
 */
export interface MiniEngineOptions {
  readonly root: string;
  readonly defaultLayout?: string;
}

const capabilities: ViewCapabilities = Object.freeze({
  layouts: true,
  partials: false,
  slots: false,
  asyncComposition: true,
  streaming: false,
  precompilation: false,
  safeHtml: true,
  viewComposers: false,
});
class Trusted {
  constructor(readonly html: string) {}
}
const escapes: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
function print(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (value instanceof Trusted) return value.html;
  if (['string', 'number', 'boolean'].includes(typeof value))
    return String(value).replace(/[&<>"']/g, (c) => escapes[c] ?? '');
  throw new ViewError('RENDER_FAILED', 'Only scalar values can be printed');
}

export class MiniEngine implements ViewEngineAdapter {
  readonly name = 'mini';
  readonly extensions = Object.freeze(['.mini']);
  readonly capabilities = capabilities;
  readonly #root: TemplateRoot;
  readonly #layout: string | undefined;
  constructor(options: MiniEngineOptions) {
    this.#root = new TemplateRoot({ root: options.root, extension: '.mini' });
    this.#layout = options.defaultLayout;
  }
  async initialize(): Promise<void> {
    await this.#root.assertDirectory();
  }
  async dispose(): Promise<void> {}
  async #fill(view: string, scope: Record<string, unknown>): Promise<string> {
    const source = await this.#root.read(await this.#root.resolve(view));
    return source.replace(/\{\{\s*([A-Za-z_]\w*)\s*\}\}/g, (_, key: string) =>
      print(Object.hasOwn(scope, key) ? scope[key] : undefined),
    );
  }
  async render(
    view: string,
    model: ViewModel,
    options: RenderOptions = {},
  ): Promise<string> {
    if (options.partials || options.helpers || options.slots || options.theme)
      throw new ViewError(
        'UNSUPPORTED_CAPABILITY',
        'The mini engine supports layouts only',
      );
    const scope = copyViewModel(
      model,
      (html: SafeHtml) => new Trusted(html.value),
    );
    const body = await this.#fill(view, scope);
    const layout = options.layout ?? this.#layout;
    if (layout === undefined || layout === false) return body;
    return this.#fill(layout, { ...scope, body: new Trusted(body) });
  }
  /** Express `app.engine('mini', ...)` bridge for Nest's `@Render`. */
  renderFile(
    filename: string,
    options: Record<string, unknown>,
    callback: (error: Error | null, html?: string) => void,
  ): void {
    const view = this.#root.viewFromFile(filename);
    if (view === undefined) {
      callback(new ViewError('INVALID_VIEW', 'Template outside the view root'));
      return;
    }
    void this.render(view, expressViewModel(options)).then(
      (html) => callback(null, html),
      (error: unknown) =>
        callback(error instanceof Error ? error : new Error('Render failed')),
    );
  }
}
