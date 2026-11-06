import nunjucks from 'nunjucks';
import {
  SafeHtml,
  TemplateRoot,
  ViewError,
  assertViewAliases,
  copyViewModel,
  expressViewModel,
  invokeViewHelper,
  type RenderOptions,
  type ViewCapabilities,
  type ViewEngineAdapter,
  type ViewHelper,
  type ViewModel,
} from '@nestvexa/views';

export interface NunjucksOptions {
  /** Trusted template directory (operating-system path, Windows paths included). */
  readonly root: string;
  /** Production cache; deployments must call clearCache after replacing templates. */
  readonly cache?: boolean;
  readonly maxTemplateBytes?: number;
  /** Template name/line in ViewError messages. Defaults to `!cache`. */
  readonly debug?: boolean;
  /** Adapter-level layout receiving the rendered view as trusted `body`. */
  readonly defaultLayout?: string;
  /** Alias -> root-relative trusted template ID, usable as `{% include "alias" %}`. */
  readonly partials?: Readonly<Record<string, string>>;
  /** Trusted synchronous functions registered as environment globals. */
  readonly helpers?: Readonly<Record<string, ViewHelper>>;
  /** Trusted synchronous filters (`{{ value | name }}`). */
  readonly filters?: Readonly<Record<string, ViewHelper>>;
  readonly trimBlocks?: boolean;
  readonly lstripBlocks?: boolean;
  /** Namespace -> trusted directory, addressed as `admin::users/index`. */
  readonly namespaces?: Readonly<Record<string, string>>;
  /**
   * Theme -> trusted override directory, selected per render with
   * `RenderOptions.theme`. Each theme gets its own environment and cache.
   */
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
type Aliases = Readonly<Record<string, string>>;
const SafeString = nunjucks.runtime.SafeString;
function trusted(html: SafeHtml): nunjucks.runtime.SafeString {
  return new SafeString(html.value);
}
function adapt(helper: ViewHelper): (...args: unknown[]) => unknown {
  return (...args: unknown[]) => {
    const result = invokeViewHelper(helper, args);
    return result instanceof SafeHtml ? trusted(result) : result;
  };
}
/** First non-render ViewError (for example an include traversal) in a cause chain. */
function policyError(error: unknown): ViewError | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof ViewError && current.code !== 'RENDER_FAILED')
      return current;
    seen.add(current);
    current = current.cause;
  }
  return undefined;
}

interface SourceResolver {
  source(name: string): nunjucks.LoaderSource;
}
/**
 * Synchronous loader restricted to one root. Names are root-relative IDs; the
 * loader defines no relative-name resolution, so `./x` and `../x` are rejected.
 * The environment's per-loader cache is kept in a null-prototype object.
 */
class RootLoader implements nunjucks.ILoader {
  readonly async = false;
  #cache: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  readonly #resolver: SourceResolver;
  constructor(resolver: SourceResolver) {
    this.#resolver = resolver;
  }
  get cache(): Record<string, unknown> {
    return this.#cache;
  }
  /** Nunjucks resets the cache by assignment; always install a fresh null-prototype map. */
  set cache(_value: unknown) {
    this.#cache = Object.create(null) as Record<string, unknown>;
  }
  getSource(name: string): nunjucks.LoaderSource {
    return this.#resolver.source(name);
  }
}

/** Each instance owns one Nunjucks environment with autoescaping always enabled. */
export class NunjucksEngine implements ViewEngineAdapter {
  readonly name = 'nunjucks';
  readonly extensions = Object.freeze(['.njk']);
  readonly capabilities = capabilities;
  readonly #root: TemplateRoot;
  readonly #options: NunjucksOptions;
  readonly #debug: boolean;
  /** One environment per theme (`''` = no theme): Nunjucks caches by template name. */
  readonly #environments = new Map<
    string,
    { readonly env: nunjucks.Environment; readonly loader: RootLoader }
  >();
  readonly #aliases: Aliases;
  /** Partial aliases of the synchronous render currently executing. */
  #activeAliases: Aliases | undefined;
  constructor(options: NunjucksOptions) {
    this.#root = new TemplateRoot({
      root: options.root,
      extension: '.njk',
      ...(options.maxTemplateBytes === undefined
        ? {}
        : { maxTemplateBytes: options.maxTemplateBytes }),
      ...(options.namespaces === undefined
        ? {}
        : { namespaces: options.namespaces }),
      ...(options.themes === undefined ? {} : { themes: options.themes }),
    });
    this.#options = Object.freeze({ ...options });
    this.#debug = options.debug ?? !options.cache;
    const helpers = { ...options.helpers };
    const filters = { ...options.filters };
    assertViewAliases(helpers);
    assertViewAliases(filters);
    this.#aliases = this.#aliasMap(options.partials ?? {});
    for (const theme of [undefined, ...this.#root.themes]) {
      const loader = new RootLoader({
        source: (name) => this.#source(name, theme),
      });
      const env = new nunjucks.Environment(loader, {
        autoescape: true,
        throwOnUndefined: false,
        trimBlocks: options.trimBlocks ?? false,
        lstripBlocks: options.lstripBlocks ?? false,
        // Retains the original cause chain; ViewError hides it from HTTP clients.
        dev: true,
      });
      for (const [name, helper] of Object.entries(helpers))
        env.addGlobal(name, adapt(helper));
      for (const [name, filter] of Object.entries(filters))
        env.addFilter(name, adapt(filter));
      this.#environments.set(theme ?? '', { env, loader });
    }
  }
  #environment(theme: string | undefined): nunjucks.Environment {
    const entry = this.#environments.get(theme ?? '');
    if (!entry) throw new ViewError('INVALID_VIEW', 'Unknown view theme');
    return entry.env;
  }
  async initialize(): Promise<void> {
    await this.#root.assertDirectory();
  }
  clearCache(): void {
    for (const { loader } of this.#environments.values())
      loader.cache = undefined;
  }
  async dispose(): Promise<void> {
    this.clearCache();
  }
  #aliasMap(partials: Aliases): Aliases {
    assertViewAliases(partials);
    const result = Object.create(null) as Record<string, string>;
    for (const [alias, view] of Object.entries(partials))
      result[alias] = this.#root.id(view);
    return Object.freeze(result);
  }
  /**
   * Names ending in `.njk` are file IDs and cacheable in production. Other
   * names are partial aliases (render-level first) or extensionless IDs; they
   * are never cached so render-local aliases cannot be served stale.
   */
  #source(name: string, theme: string | undefined): nunjucks.LoaderSource {
    const file = name.endsWith('.njk');
    const id = file
      ? this.#root.id(name)
      : (this.#activeAliases?.[name] ??
        this.#aliases[name] ??
        this.#root.id(name));
    const filename = this.#root.resolveSync(id, undefined, theme);
    return {
      src: this.#root.readSync(filename),
      path: filename,
      noCache: !this.#options.cache || !file,
    };
  }
  #run(
    view: string,
    context: object,
    aliases: Aliases,
    theme: string | undefined,
  ): string {
    const previous = this.#activeAliases;
    this.#activeAliases = aliases;
    try {
      const html: unknown = this.#environment(theme).render(view, context);
      if (typeof html !== 'string')
        throw new ViewError(
          'RENDER_FAILED',
          'Nunjucks returned non-string output; async filters are unsupported',
        );
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
      const theme = this.#root.theme(options.theme);
      const id = this.#root.id(view);
      // Fail closed on missing or escaping views before Nunjucks sees the name.
      await this.#root.resolve(id, undefined, theme);
      const safe = copyViewModel(model, trusted);
      const aliases = this.#aliasMap({ ...options.partials });
      const helpers = options.helpers ?? {};
      assertViewAliases(helpers);
      const slots = options.slots ?? {};
      assertViewAliases(slots);
      const context = Object.assign(
        Object.create(null) as Record<string, unknown>,
        safe,
      );
      for (const [name, helper] of Object.entries(helpers)) {
        if (Object.hasOwn(context, name))
          throw new ViewError(
            'INVALID_VIEW',
            `Helper name collides with a template variable: ${name}`,
          );
        context[name] = adapt(helper);
      }
      context['slots'] = copyViewModel(slots, trusted);
      const layoutView = options.layout ?? this.#options.defaultLayout;
      const layout = layoutView ? this.#root.id(layoutView) : undefined;
      if (layout) await this.#root.resolve(layout, undefined, theme);
      const html = this.#run(id, context, aliases, theme);
      if (!layout) return html;
      return this.#run(
        layout,
        Object.assign(Object.create(null) as Record<string, unknown>, context, {
          body: new SafeString(html),
        }),
        aliases,
        theme,
      );
    } catch (cause) {
      const policy = policyError(cause);
      if (policy) throw policy;
      if (cause instanceof ViewError && !this.#debug) throw cause;
      throw new ViewError('RENDER_FAILED', this.#failure(view, cause), {
        cause,
      });
    }
  }
  #failure(view: string, cause: unknown): string {
    const base = `Unable to render view: ${view}`;
    if (!this.#debug || !(cause instanceof Error)) return base;
    // Nunjucks: "(<path>) [Line n, Column m]" for the innermost template.
    const match = /\(([^()\n]+)\) \[Line (\d+)/.exec(cause.message);
    if (!match?.[1] || !match[2]) return base;
    // Parser errors carry 1-based lines; runtime failures wrapped by
    // runtime.handleError keep the compiled 0-based line and the original cause.
    const lineno: unknown = Reflect.get(cause, 'lineno');
    const line =
      typeof lineno === 'number' && Number.isSafeInteger(lineno)
        ? lineno + (cause.cause instanceof Error ? 1 : 0)
        : Number(match[2]);
    const template = this.#root.viewFromFile(match[1]) ?? match[1];
    return `${base} (${template}:${line})`;
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
