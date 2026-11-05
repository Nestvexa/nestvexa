import {
  SafeHtml,
  TemplateRoot,
  ViewError,
  assertViewAliases,
  copyViewModel,
  expressViewModel,
  type RenderOptions,
  type ViewCapabilities,
  type ViewEngineAdapter,
  type ViewModel,
} from '@nestvexa/views';

/**
 * A complete third-party adapter for a deliberately tiny template language:
 * `{{ path.to.value }}` prints an escaped value. There is no raw-output syntax;
 * only server-side `SafeHtml` (Live mounts, slots, layout bodies) is emitted
 * unescaped. It reuses the hardened `@nestvexa/views` adapter kit for root
 * containment, view-ID validation and public-data-only models.
 */
export interface TokenEngineOptions {
  readonly root: string;
  readonly cache?: boolean;
  readonly debug?: boolean;
  readonly defaultLayout?: string;
  readonly maxTemplateBytes?: number;
}

/** Honest flags: no partials, helpers, streaming or precompilation. */
const capabilities: ViewCapabilities = Object.freeze({
  layouts: true,
  partials: false,
  slots: true,
  asyncComposition: true,
  streaming: false,
  precompilation: false,
  safeHtml: true,
  viewComposers: true,
});

type Part =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'value';
      readonly path: readonly string[];
      readonly line: number;
    };
interface CompiledTemplate {
  readonly id: string;
  readonly parts: readonly Part[];
}

class TemplateSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
    public template = '',
  ) {
    super(message);
    this.name = 'TemplateSyntaxError';
  }
}

const escapes: Readonly<Record<string, string>> = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => escapes[character] ?? '');
}
const expression = /\{\{\s*([A-Za-z_]\w*(?:\.\w+)*)\s*\}\}/y;

function compile(id: string, source: string): CompiledTemplate {
  const parts: Part[] = [];
  let index = 0;
  let line = 1;
  while (index < source.length) {
    const open = source.indexOf('{{', index);
    const end = open === -1 ? source.length : open;
    const text = source.slice(index, end);
    if (text) parts.push({ kind: 'text', text });
    line += text.split('\n').length - 1;
    if (open === -1) break;
    expression.lastIndex = open;
    const match = expression.exec(source);
    if (!match?.[1])
      throw new TemplateSyntaxError('Malformed {{ expression }}', line, id);
    parts.push({ kind: 'value', path: match[1].split('.'), line });
    index = expression.lastIndex;
  }
  return Object.freeze({ id, parts: Object.freeze(parts) });
}

class TrustedMarkup {
  constructor(readonly html: string) {
    Object.freeze(this);
  }
}

/** Looks up own properties only; models are null-prototype copies. */
function lookup(scope: unknown, path: readonly string[]): unknown {
  let current = scope;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    if (!Object.hasOwn(current, key)) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

function print(value: unknown, part: Part & { kind: 'value' }): string {
  if (value === undefined || value === null) return '';
  if (value instanceof TrustedMarkup) return value.html;
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return escapeHtml(String(value));
  throw new TemplateSyntaxError(
    `Cannot print a non-scalar value at ${part.path.join('.')}`,
    part.line,
  );
}

export class TokenEngine implements ViewEngineAdapter {
  readonly name = 'tokens';
  readonly extensions = Object.freeze(['.tok']);
  readonly capabilities = capabilities;
  readonly #root: TemplateRoot;
  readonly #options: TokenEngineOptions;
  readonly #debug: boolean;
  readonly #cache = new Map<string, CompiledTemplate>();
  constructor(options: TokenEngineOptions) {
    this.#root = new TemplateRoot({
      root: options.root,
      extension: '.tok',
      ...(options.maxTemplateBytes === undefined
        ? {}
        : { maxTemplateBytes: options.maxTemplateBytes }),
    });
    this.#options = Object.freeze({ ...options });
    this.#debug = options.debug ?? !options.cache;
  }
  async initialize(): Promise<void> {
    await this.#root.assertDirectory();
  }
  async dispose(): Promise<void> {
    this.#cache.clear();
  }
  async #template(view: string): Promise<CompiledTemplate> {
    const filename = await this.#root.resolve(view);
    const cached = this.#options.cache ? this.#cache.get(filename) : undefined;
    if (cached) return cached;
    const id = this.#root.viewFromFile(filename) ?? this.#root.id(view);
    const compiled = compile(id, await this.#root.read(filename));
    if (this.#options.cache) this.#cache.set(filename, compiled);
    return compiled;
  }
  #run(template: CompiledTemplate, scope: Record<string, unknown>): string {
    let html = '';
    for (const part of template.parts) {
      if (part.kind === 'text') html += part.text;
      else {
        try {
          html += print(lookup(scope, part.path), part);
        } catch (error) {
          if (error instanceof TemplateSyntaxError)
            error.template = template.id;
          throw error;
        }
      }
    }
    return html;
  }
  async render(
    view: string,
    model: ViewModel,
    options: RenderOptions = {},
  ): Promise<string> {
    if (options.partials && Object.keys(options.partials).length)
      throw new ViewError(
        'UNSUPPORTED_CAPABILITY',
        'The tokens engine has no partials',
      );
    if (options.helpers && Object.keys(options.helpers).length)
      throw new ViewError(
        'UNSUPPORTED_CAPABILITY',
        'The tokens engine has no helpers; compute values in the view model',
      );
    if (options.theme !== undefined)
      throw new ViewError(
        'UNSUPPORTED_CAPABILITY',
        'The tokens engine has no theme override directories',
      );
    try {
      const trusted = (html: SafeHtml) => new TrustedMarkup(html.value);
      const scope = copyViewModel(model, trusted);
      const slots = options.slots ?? {};
      assertViewAliases(slots);
      scope['slots'] = copyViewModel(slots, trusted);
      const main = await this.#template(view);
      const layoutView = options.layout ?? this.#options.defaultLayout;
      const layout = layoutView ? await this.#template(layoutView) : undefined;
      const body = this.#run(main, scope);
      if (!layout) return body;
      return this.#run(layout, { ...scope, body: new TrustedMarkup(body) });
    } catch (cause) {
      if (cause instanceof ViewError) throw cause;
      const detail =
        this.#debug && cause instanceof TemplateSyntaxError
          ? ` (${cause.template}:${cause.line})`
          : '';
      throw new ViewError(
        'RENDER_FAILED',
        `Unable to render view: ${view}${detail}`,
        { cause },
      );
    }
  }
  /** Express `app.engine` bridge; strips host settings from the model. */
  renderFile(
    filename: string,
    options: Record<string, unknown>,
    callback: (error: Error | null, html?: string) => void,
  ): void {
    const view = this.#root.viewFromFile(filename);
    if (view === undefined) {
      callback(new ViewError('INVALID_VIEW', 'Template escapes root'));
      return;
    }
    void this.render(view, expressViewModel(options)).then(
      (html) => callback(null, html),
      (error: unknown) =>
        callback(error instanceof Error ? error : new Error('Render failed')),
    );
  }
}
