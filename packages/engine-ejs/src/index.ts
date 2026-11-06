import ejs, { type EjsTemplateFunction } from 'ejs';
import {
  SafeHtml,
  TemplateRoot,
  ViewError,
  assertViewAliases,
  copyViewModel,
  expressViewModel,
  invokeViewHelper,
  parseViewName,
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
  /** Namespace -> trusted directory, addressed as `admin::users/index`. */
  readonly namespaces?: Readonly<Record<string, string>>;
  /** Theme -> trusted override directory, selected per render with `RenderOptions.theme`. */
  readonly themes?: Readonly<Record<string, string>>;
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
interface Compiled {
  readonly render: EjsTemplateFunction;
  /** Real path of the template; parent of its relative includes. */
  readonly filename: string;
}

/** Each instance owns its compiled templates; EJS's process-global cache is never used. */
export class EjsEngine implements ViewEngineAdapter {
  readonly name = 'ejs';
  readonly extensions = Object.freeze(['.ejs']);
  readonly capabilities = capabilities;
  readonly #root: TemplateRoot;
  readonly #options: EjsOptions;
  readonly #cacheEntries: number;
  readonly #debug: boolean;
  readonly #templates = new Map<string, Compiled>();
  readonly #sources = new Map<string, string>();
  /** Partial aliases of the synchronous render currently executing. */
  #activeAliases: Aliases | undefined;
  /** Theme of the synchronous render currently executing. */
  #activeTheme: string | undefined;
  constructor(options: EjsOptions) {
    this.#root = new TemplateRoot({
      root: options.root,
      extension: '.ejs',
      ...(options.maxTemplateBytes === undefined
        ? {}
        : { maxTemplateBytes: options.maxTemplateBytes }),
      ...(options.namespaces === undefined
        ? {}
        : { namespaces: options.namespaces }),
      ...(options.themes === undefined ? {} : { themes: options.themes }),
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
  #compile(source: string, filename: string): Compiled {
    const render = ejs.compile(source, {
      // Only used for compileDebug line diagnostics.
      filename,
      root: this.#root.path,
      escape: escapeHtml,
      // Templates call the engine-owned `include` local (see #execute), so
      // EJS's own include path, which probes `fs.existsSync` with the raw
      // reference before any includer runs, is never reached. Fail closed if it is.
      includer: () => {
        throw new ViewError(
          'INVALID_VIEW',
          'EJS include must use the engine include function',
        );
      },
      compileDebug: this.#debug,
      strict: false,
      _with: true,
      localsName: 'locals',
      cache: false,
      async: false,
      rmWhitespace: false,
    });
    return Object.freeze({ render, filename });
  }
  async #template(view: string, theme: string | undefined): Promise<Compiled> {
    const filename = await this.#root.resolve(view, undefined, theme);
    const cached = this.#options.cache
      ? this.#templates.get(filename)
      : undefined;
    if (cached) return cached;
    const compiled = this.#compile(await this.#root.read(filename), filename);
    this.#remember(this.#templates, filename, compiled);
    return compiled;
  }
  /**
   * Resolve an include reference. Aliases resolve first; `/x` names the
   * default root; `ns::x` names a namespace; other references are relative to
   * the including template (inside its namespace). The active theme's
   * overrides apply. Traversal, absolute, UNC, drive, backslash, control and
   * NUL references are rejected by pure string validation before any
   * filesystem call (including existence probes, which on Windows could reach
   * a remote SMB share or abort the process for U+10FFFF).
   */
  #include(
    reference: string,
    parent: string,
  ): {
    filename: string;
    template: string;
  } {
    const alias = this.#activeAliases?.[reference];
    let id: string;
    if (alias !== undefined) id = alias;
    else {
      // Validates the reference itself (no filesystem access) in every branch.
      const local = resolveTemplateReference(undefined, reference);
      if (
        reference.startsWith('/') ||
        parseViewName(reference).namespace !== undefined
      )
        id = this.#root.id(local);
      else {
        // The engine-owned include knows the including file, so relative
        // references resolve against its ID (namespace and theme mounts
        // included) instead of an EJS-probed filesystem path.
        const parentId = this.#root.viewFromFile(parent);
        if (parentId === undefined)
          throw new ViewError('INVALID_VIEW', 'Template include escapes root');
        id = this.#root.id(resolveTemplateReference(parentId, reference));
      }
    }
    const filename = this.#root.resolveSync(id, undefined, this.#activeTheme);
    const cached = this.#options.cache
      ? this.#sources.get(filename)
      : undefined;
    const template = cached ?? this.#root.readSync(filename);
    if (cached === undefined) this.#remember(this.#sources, filename, template);
    return { filename, template };
  }
  /**
   * Runs one compiled template with an `include(reference, data?)` local bound
   * to that template's file. It shadows EJS's generated `include` parameter
   * inside `with (locals)`, mirroring EJS semantics: the child receives a
   * shallow copy of the caller's locals merged with `data`.
   */
  #execute(compiled: Compiled, locals: Record<string, unknown>): string {
    const scope = Object.assign(
      Object.create(null) as Record<string, unknown>,
      locals,
    );
    scope['include'] = (reference: unknown, data?: unknown): string => {
      if (typeof reference !== 'string')
        throw new ViewError(
          'INVALID_VIEW',
          'Template include reference must be a string',
        );
      if (
        data !== undefined &&
        data !== null &&
        (typeof data !== 'object' || Array.isArray(data))
      )
        throw new ViewError('INVALID_VIEW', 'Include data must be an object');
      const { filename, template } = this.#include(
        reference,
        compiled.filename,
      );
      const child = Object.assign(
        Object.create(null) as Record<string, unknown>,
        scope,
        data ?? {},
      );
      return this.#execute(this.#compile(template, filename), child);
    };
    const html: unknown = compiled.render(scope);
    if (typeof html !== 'string')
      throw new ViewError('RENDER_FAILED', 'EJS returned non-string output');
    return html;
  }
  #run(
    compiled: Compiled,
    context: Record<string, unknown>,
    aliases: Aliases,
    theme: string | undefined,
  ): string {
    const previous = this.#activeAliases;
    const previousTheme = this.#activeTheme;
    this.#activeAliases = aliases;
    this.#activeTheme = theme;
    try {
      return this.#execute(compiled, context);
    } finally {
      this.#activeAliases = previous;
      this.#activeTheme = previousTheme;
    }
  }
  async render(
    view: string,
    model: ViewModel,
    options: RenderOptions = {},
  ): Promise<string> {
    try {
      const theme = this.#root.theme(options.theme);
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
      const main = await this.#template(view, theme);
      const layoutView = options.layout ?? this.#options.defaultLayout;
      const layout = layoutView
        ? await this.#template(layoutView, theme)
        : undefined;
      const html = this.#run(main, context, aliases, theme);
      if (!layout) return html;
      return this.#run(
        layout,
        Object.assign(Object.create(null) as Record<string, unknown>, context, {
          body: new TrustedMarkup(html),
        }),
        aliases,
        theme,
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
