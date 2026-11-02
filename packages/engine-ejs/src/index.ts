import ejs, { type EjsTemplateFunction } from 'ejs';
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

export interface EjsOptions {
  /** Trusted template directory (operating-system path, Windows paths included). */
  readonly root: string;
  /** Production cache; deployments must call clearCache after replacing templates. */
  readonly cache?: boolean;
  readonly cacheEntries?: number;
  readonly maxTemplateBytes?: number;
  /**
   * Development diagnostics: EJS line instrumentation and template name/line in
   * ViewError messages. Defaults to `!cache`.
   */
  readonly debug?: boolean;
  readonly defaultLayout?: string;
  /** Alias -> root-relative trusted template ID, usable as `include('alias')`. */
  readonly partials?: Readonly<Record<string, string>>;
  /** Trusted synchronous functions exposed as template locals. */
  readonly helpers?: Readonly<Record<string, ViewHelper>>;
}

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
/** Names EJS's generated function uses inside `with (locals)`; data must not shadow them. */
const reservedLocals = new Set(['include', 'locals', 'escapeFn', 'rethrow']);

/**
 * Engine-private trusted markup. `<%= value %>` emits it unescaped through the
 * adapter's escape function; `<%- value %>` stringifies it. Browser data can
 * never produce this type: only `SafeHtml` from server code is converted.
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
function escapeHtml(value: unknown): string {
  return value instanceof TrustedMarkup
    ? value.toString()
    : ejs.escapeXML(value);
}
function trusted(html: SafeHtml): TrustedMarkup {
  return new TrustedMarkup(html.value);
}
type Aliases = Readonly<Record<string, string>>;

/** Each instance owns its compiled templates; EJS's process-global cache is never used. */
export class EjsEngine implements ViewEngineAdapter {
  readonly name = 'ejs';
  readonly extensions = Object.freeze(['.ejs']);
  readonly capabilities = capabilities;
  readonly #root: TemplateRoot;
  readonly #options: EjsOptions;
  readonly #cacheEntries: number;
  readonly #debug: boolean;
  readonly #templates = new Map<string, EjsTemplateFunction>();
  readonly #sources = new Map<string, string>();
  /** Partial aliases of the synchronous render currently executing. */
  #activeAliases: Aliases | undefined;
  constructor(options: EjsOptions) {
    this.#root = new TemplateRoot({
      root: options.root,
      extension: '.ejs',
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
    this.#options = Object.freeze({
      ...options,
      helpers: Object.freeze({ ...options.helpers }),
      partials: Object.freeze({ ...options.partials }),
    });
    this.#debug = options.debug ?? !options.cache;
    assertViewAliases(this.#options.helpers ?? {});
    for (const name of Object.keys(this.#options.helpers ?? {}))
      if (reservedLocals.has(name))
        throw new ViewError(
          'INVALID_VIEW',
          `Reserved EJS helper name: ${name}`,
        );
    this.#aliases(this.#options.partials ?? {});
  }
  async initialize(): Promise<void> {
    await this.#root.assertDirectory();
  }
  clearCache(): void {
    this.#templates.clear();
    this.#sources.clear();
  }
  async dispose(): Promise<void> {
    this.clearCache();
  }
  #aliases(partials: Aliases): Aliases {
    assertViewAliases(partials);
    const result = Object.create(null) as Record<string, string>;
    for (const [alias, view] of Object.entries(partials))
      result[alias] = this.#root.id(view);
    return Object.freeze(result);
  }
  #remember<T>(cache: Map<string, T>, key: string, value: T): void {
    if (!this.#options.cache) return;
    if (cache.size >= this.#cacheEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, value);
  }
  #compile(source: string, filename: string): EjsTemplateFunction {
    return ejs.compile(source, {
      filename,
      root: this.#root.path,
      escape: escapeHtml,
      includer: (reference, parsed) => this.#include(reference, parsed),
      compileDebug: this.#debug,
      strict: false,
      _with: true,
      localsName: 'locals',
      cache: false,
      async: false,
      rmWhitespace: false,
    });
  }
  async #template(view: string): Promise<EjsTemplateFunction> {
    const filename = await this.#root.resolve(view);
    const cached = this.#options.cache
      ? this.#templates.get(filename)
      : undefined;
    if (cached) return cached;
    const compiled = this.#compile(await this.#root.read(filename), filename);
    this.#remember(this.#templates, filename, compiled);
    return compiled;
  }
  /**
   * EJS include hook. Aliases resolve first; `/x` is root-relative; other
   * references are relative to the including template. Traversal, absolute,
   * drive, backslash and NUL references are rejected before any file access.
   */
  #include(
    reference: string,
    parsed: string | undefined,
  ): {
    filename: string;
    template: string;
  } {
    const alias = this.#activeAliases?.[reference];
    let id: string;
    if (alias !== undefined) id = alias;
    else {
      const local = resolveTemplateReference(undefined, reference);
      if (reference.startsWith('/')) id = this.#root.id(local);
      else {
        if (parsed === undefined)
          throw new Error(`EJS include not found: ${reference}`);
        const relative = this.#root.viewFromFile(parsed);
        if (relative === undefined)
          throw new ViewError('INVALID_VIEW', 'Template include escapes root');
        id = this.#root.id(relative);
      }
    }
    const filename = this.#root.resolveSync(id);
    const cached = this.#options.cache
      ? this.#sources.get(filename)
      : undefined;
    const template = cached ?? this.#root.readSync(filename);
    if (cached === undefined) this.#remember(this.#sources, filename, template);
    return { filename, template };
  }
  #run(
    template: EjsTemplateFunction,
    context: Record<string, unknown>,
    aliases: Aliases,
  ): string {
    const previous = this.#activeAliases;
    this.#activeAliases = aliases;
    try {
      const html: unknown = template(context);
      if (typeof html !== 'string')
        throw new ViewError('RENDER_FAILED', 'EJS returned non-string output');
      return html;
    } finally {
      this.#activeAliases = previous;
    }
  }
  async render(
    view: string,
    model: ViewModel,
    options: RenderOptions = {},
  ): Promise<string> {
    try {
      const safe = copyViewModel(model, trusted);
      for (const key of Object.keys(safe))
        if (reservedLocals.has(key) || key.startsWith('__'))
          throw new ViewError(
            'UNSAFE_MODEL',
            `Reserved EJS template variable: ${key}`,
          );
      const helpers = { ...this.#options.helpers, ...options.helpers };
      assertViewAliases(helpers);
      const aliases = this.#aliases({
        ...this.#options.partials,
        ...options.partials,
      });
      const slots = options.slots ?? {};
      assertViewAliases(slots);
      const context = Object.assign(
        Object.create(null) as Record<string, unknown>,
        safe,
      );
      for (const [name, helper] of Object.entries(helpers)) {
        if (reservedLocals.has(name) || Object.hasOwn(context, name))
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
      const html = this.#run(main, context, aliases);
      if (!layout) return html;
      return this.#run(
        layout,
        Object.assign(Object.create(null) as Record<string, unknown>, context, {
          body: new TrustedMarkup(html),
        }),
        aliases,
      );
    } catch (cause) {
      if (cause instanceof ViewError && cause.code !== 'RENDER_FAILED')
        throw cause;
      if (cause instanceof ViewError && !this.#debug) throw cause;
      throw new ViewError('RENDER_FAILED', this.#failure(view, cause), {
        cause,
      });
    }
  }
  #failure(view: string, cause: unknown): string {
    const base = `Unable to render view: ${view}`;
    if (!this.#debug || !(cause instanceof Error)) return base;
    // EJS compileDebug prefixes runtime errors with "<filename>:<line>\n".
    const match = /^(.+?):(\d+)\n/.exec(cause.message);
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
