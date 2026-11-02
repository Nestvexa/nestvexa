import pug, { type PugFilter, type PugPlugin, type PugToken } from 'pug';
import {
  SafeHtml,
  TemplateRoot,
  ViewError,
  assertViewAliases,
  copyViewModel,
  expressViewModel,
  invokeViewHelper,
  resolveTemplateReference,
  type RenderOptions,
  type ViewCapabilities,
  type ViewEngineAdapter,
  type ViewHelper,
  type ViewModel,
} from '@nestvexa/views';

export type PugTextFilter = (
  text: string,
  options: Readonly<Record<string, unknown>>,
) => string;
export interface PugOptions {
  /** Trusted template directory (operating-system path, Windows paths included). */
  readonly root: string;
  /** Production cache; deployments must call clearCache after replacing templates. */
  readonly cache?: boolean;
  readonly cacheEntries?: number;
  readonly maxTemplateBytes?: number;
  /**
   * Development diagnostics: Pug line instrumentation and template name/line in
   * ViewError messages. Defaults to `!cache`.
   */
  readonly debug?: boolean;
  /** Adapter-level layout receiving the rendered view as trusted `body`. */
  readonly defaultLayout?: string;
  /** Trusted synchronous functions exposed as template locals. */
  readonly helpers?: Readonly<Record<string, ViewHelper>>;
  /**
   * Trusted compile-time text filters (`:name`). Only registered filters are
   * allowed; Pug never loads `jstransformer-*` modules for this adapter.
   */
  readonly filters?: Readonly<Record<string, PugTextFilter>>;
  /** Pug doctype for attribute serialization, for example `html`. */
  readonly doctype?: string;
}

/**
 * Pug composes with compile-time `include`, `extends`/`block` and mixins.
 * Render-time partial alias maps (RenderOptions.partials) are rejected.
 */
const capabilities: ViewCapabilities = Object.freeze({
  layouts: true,
  partials: true,
  slots: true,
  asyncComposition: true,
  streaming: false,
  precompilation: false,
  safeHtml: true,
  viewComposers: true,
});

/**
 * Engine-private trusted markup. Pug's escaped output (`= value`, `#{value}`)
 * emits it unescaped through the adapter runtime; unescaped output stringifies
 * it. Browser data can never produce this type: only server `SafeHtml` is.
 */
class TrustedMarkup {
  readonly #html: string;
  constructor(html: string) {
    this.#html = html;
    Object.freeze(this);
  }
  toString(): string {
    return this.#html;
  }
}
function trusted(html: SafeHtml): TrustedMarkup {
  return new TrustedMarkup(html.value);
}
const upstreamEscape: unknown = pug.runtime['escape'];
if (typeof upstreamEscape !== 'function')
  throw new Error('Unsupported Pug runtime: escape helper is missing');
const escapeUpstream = upstreamEscape as (value: unknown) => unknown;
/** Pug's own runtime with a trusted-markup-aware text escape. */
const runtime: Readonly<Record<string, unknown>> = Object.freeze({
  ...pug.runtime,
  escape: (value: unknown): unknown =>
    value instanceof TrustedMarkup ? value.toString() : escapeUpstream(value),
});
type PugTemplate = (locals: object) => unknown;

function reserved(name: string): boolean {
  return (
    name === 'pug' ||
    name === 'self' ||
    name === 'locals' ||
    name.startsWith('pug_')
  );
}

/** Each instance owns its compiled templates; Pug's process-global cache is never used. */
export class PugEngine implements ViewEngineAdapter {
  readonly name = 'pug';
  readonly extensions = Object.freeze(['.pug']);
  readonly capabilities = capabilities;
  readonly #root: TemplateRoot;
  readonly #options: PugOptions;
  readonly #cacheEntries: number;
  readonly #debug: boolean;
  readonly #filters: Readonly<Record<string, PugFilter>>;
  readonly #templates = new Map<string, PugTemplate>();
  readonly #plugin: PugPlugin;
  constructor(options: PugOptions) {
    this.#root = new TemplateRoot({
      root: options.root,
      extension: '.pug',
      ...(options.maxTemplateBytes === undefined
        ? {}
        : { maxTemplateBytes: options.maxTemplateBytes }),
    });
    this.#cacheEntries = options.cacheEntries ?? 256;
    if (!Number.isSafeInteger(this.#cacheEntries) || this.#cacheEntries < 1)
      throw new ViewError(
        'INVALID_VIEW',
        'Template limits must be positive integers',
      );
    if (
      options.doctype !== undefined &&
      !/^[a-z0-9 ]{1,32}$/i.test(options.doctype)
    )
      throw new ViewError('INVALID_VIEW', 'Invalid Pug doctype');
    this.#options = Object.freeze({
      ...options,
      helpers: Object.freeze({ ...options.helpers }),
    });
    this.#debug = options.debug ?? !options.cache;
    assertViewAliases(this.#options.helpers ?? {});
    for (const name of Object.keys(this.#options.helpers ?? {}))
      if (reserved(name))
        throw new ViewError(
          'INVALID_VIEW',
          `Reserved Pug helper name: ${name}`,
        );
    const filters = Object.create(null) as Record<string, PugFilter>;
    for (const [name, filter] of Object.entries(options.filters ?? {})) {
      if (!/^[a-zA-Z][\w-]*$/.test(name) || typeof filter !== 'function')
        throw new ViewError('INVALID_VIEW', 'Invalid Pug filter');
      filters[name] = filter;
    }
    this.#filters = Object.freeze(filters);
    this.#plugin = Object.freeze({
      resolve: (reference: string, source: string): string =>
        this.#resolveInclude(reference, source),
      read: (filename: string): string => {
        if (this.#root.viewFromFile(filename) === undefined)
          throw new ViewError('INVALID_VIEW', 'Template include escapes root');
        return this.#root.readSync(filename);
      },
      postLex: (tokens: PugToken[]): PugToken[] => {
        for (const token of tokens)
          if (
            token.type === 'filter' &&
            !Object.hasOwn(this.#filters, String(token.val))
          )
            throw new ViewError(
              'INVALID_VIEW',
              `Unregistered Pug filter: ${String(token.val)}`,
            );
        return tokens;
      },
    });
  }
  async initialize(): Promise<void> {
    await this.#root.assertDirectory();
  }
  clearCache(): void {
    this.#templates.clear();
  }
  async dispose(): Promise<void> {
    this.clearCache();
  }
  /**
   * Pug `include`/`extends`: `/x` is root-relative, other references are
   * relative to the including file. Pug appends `.pug` to extensionless
   * references; raw includes keep their own extension. Traversal, absolute,
   * drive, backslash and NUL references are rejected before any file access.
   */
  #resolveInclude(reference: string, source: string): string {
    const parent = this.#root.viewFromFile(source);
    if (parent === undefined)
      throw new ViewError('INVALID_VIEW', 'Template include escapes root');
    return this.#root.resolveSync(
      resolveTemplateReference(parent, reference),
      '',
    );
  }
  #compile(source: string, filename: string): PugTemplate {
    const body = pug.compileClient(source, {
      filename,
      basedir: this.#root.path,
      compileDebug: this.#debug,
      inlineRuntimeFunctions: false,
      name: 'template',
      self: false,
      pretty: false,
      filters: this.#filters,
      plugins: [this.#plugin],
      ...(this.#options.doctype === undefined
        ? {}
        : { doctype: this.#options.doctype }),
    });
    // Same construction as Pug's own compile()/pug-runtime/wrap, but bound to
    // this adapter's runtime so trusted markup bypasses escaping deliberately.
    const factory = new Function('pug', `${body}\nreturn template;`) as (
      runtime: object,
    ) => unknown;
    const template = factory(runtime);
    if (typeof template !== 'function')
      throw new ViewError('RENDER_FAILED', 'Pug produced no template function');
    return template as PugTemplate;
  }
  async #template(view: string): Promise<PugTemplate> {
    const filename = await this.#root.resolve(view);
    const cached = this.#options.cache
      ? this.#templates.get(filename)
      : undefined;
    if (cached) return cached;
    const compiled = this.#compile(await this.#root.read(filename), filename);
    if (this.#options.cache) {
      if (this.#templates.size >= this.#cacheEntries) {
        const oldest = this.#templates.keys().next().value;
        if (oldest !== undefined) this.#templates.delete(oldest);
      }
      this.#templates.set(filename, compiled);
    }
    return compiled;
  }
  async render(
    view: string,
    model: ViewModel,
    options: RenderOptions = {},
  ): Promise<string> {
    try {
      if (options.partials && Object.keys(options.partials).length)
        throw new ViewError(
          'UNSUPPORTED_CAPABILITY',
          'Pug resolves partials at compile time; use `include` or mixins instead of RenderOptions.partials',
        );
      const safe = copyViewModel(model, trusted);
      for (const key of Object.keys(safe))
        if (reserved(key))
          throw new ViewError(
            'UNSAFE_MODEL',
            `Reserved Pug template variable: ${key}`,
          );
      const helpers = { ...this.#options.helpers, ...options.helpers };
      assertViewAliases(helpers);
      const slots = options.slots ?? {};
      assertViewAliases(slots);
      const context = Object.assign(
        Object.create(null) as Record<string, unknown>,
        safe,
      );
      for (const [name, helper] of Object.entries(helpers)) {
        if (reserved(name) || Object.hasOwn(context, name))
          throw new ViewError(
            'INVALID_VIEW',
            `Helper name collides with a template variable: ${name}`,
          );
        context[name] = (...args: unknown[]) => {
          const result = invokeViewHelper(helper, args);
          return result instanceof SafeHtml ? trusted(result) : result;
        };
      }
      context['slots'] = copyViewModel(slots, trusted);
      const main = await this.#template(view);
      const layoutView = options.layout ?? this.#options.defaultLayout;
      const layout = layoutView ? await this.#template(layoutView) : undefined;
      const html = this.#run(main, context);
      if (!layout) return html;
      return this.#run(
        layout,
        Object.assign(Object.create(null) as Record<string, unknown>, context, {
          body: new TrustedMarkup(html),
        }),
      );
    } catch (cause) {
      if (
        cause instanceof ViewError &&
        (cause.code !== 'RENDER_FAILED' || !this.#debug)
      )
        throw cause;
      throw new ViewError('RENDER_FAILED', this.#failure(view, cause), {
        cause,
      });
    }
  }
  #run(template: PugTemplate, context: Record<string, unknown>): string {
    const html = template(context);
    if (typeof html !== 'string')
      throw new ViewError('RENDER_FAILED', 'Pug returned non-string output');
    return html;
  }
  #failure(view: string, cause: unknown): string {
    const base = `Unable to render view: ${view}`;
    if (!this.#debug || !(cause instanceof Error)) return base;
    // Pug compile and compileDebug runtime errors start with "<file>:<line>[:col]\n".
    const match = /^(.+?):(\d+)(?::\d+)?\n/.exec(cause.message);
    if (!match?.[1] || !match[2]) return base;
    const template = this.#root.viewFromFile(match[1]) ?? match[1];
    return `${base} (${template}:${match[2]})`;
  }
  /** Express engine bridge. Host settings and response locals metadata are not view data. */
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
