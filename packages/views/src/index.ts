/**
 * Explicitly trusted, already rendered HTML. This API does not sanitize input.
 * Never construct a fragment from browser-provided text or markup.
 */
export class SafeHtml {
  private constructor(readonly value: string) {
    Object.freeze(this);
  }
  static trusted(value: string): SafeHtml {
    return new SafeHtml(value);
  }
}
export type ViewModel = Readonly<Record<string, unknown>>;
export type ViewHelper = (...args: unknown[]) => unknown;
export interface ViewCapabilities {
  readonly layouts: boolean;
  readonly partials: boolean;
  readonly slots: boolean;
  readonly asyncComposition: boolean;
  readonly streaming: boolean;
  readonly precompilation: boolean;
  readonly safeHtml: boolean;
  readonly viewComposers: boolean;
}
export interface RenderOptions {
  readonly layout?: string | false;
  readonly partials?: Readonly<Record<string, string>>;
  readonly slots?: Readonly<Record<string, SafeHtml>>;
  readonly helpers?: Readonly<Record<string, ViewHelper>>;
  /**
   * Registered theme whose override directory is searched first for the view,
   * its layouts and its partials. Unknown themes fail with `INVALID_VIEW`.
   */
  readonly theme?: string;
}
/** Engines render trusted templates with explicitly supplied public view models. */
export interface ViewEngineAdapter {
  readonly name: string;
  readonly extensions: readonly string[];
  readonly capabilities: ViewCapabilities;
  initialize(): Promise<void>;
  render(
    view: string,
    model: ViewModel,
    options?: RenderOptions,
  ): Promise<string>;
  dispose(): Promise<void>;
}
export class ViewError extends Error {
  constructor(
    readonly code:
      | 'INVALID_VIEW'
      | 'UNSAFE_MODEL'
      | 'UNKNOWN_ENGINE'
      | 'DUPLICATE_ENGINE'
      | 'UNSUPPORTED_CAPABILITY'
      | 'RENDER_FAILED',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ViewError';
  }
}
/** Per-render composers receive host-owned request context; no context is stored. */
export type ViewComposer<Context> = (
  view: string,
  context: Context,
) => ViewModel | Promise<ViewModel>;
const capabilityNames: readonly (keyof ViewCapabilities)[] = Object.freeze([
  'layouts',
  'partials',
  'slots',
  'asyncComposition',
  'streaming',
  'precompilation',
  'safeHtml',
  'viewComposers',
]);
/** Rejects malformed third-party adapters at registration instead of first render. */
function assertAdapterShape(engine: ViewEngineAdapter): void {
  const problems: string[] = [];
  if (
    !Array.isArray(engine.extensions) ||
    !engine.extensions.every(
      (extension: unknown) =>
        typeof extension === 'string' && /^\.[a-z0-9]+$/i.test(extension),
    )
  )
    problems.push('extensions must be strings such as ".ejs"');
  const capabilities: unknown = engine.capabilities;
  if (typeof capabilities !== 'object' || capabilities === null)
    problems.push('capabilities must be an object');
  else
    for (const key of capabilityNames)
      if (typeof Reflect.get(capabilities, key) !== 'boolean')
        problems.push(`capability "${key}" must be declared as a boolean`);
  for (const method of ['initialize', 'render', 'dispose'] as const)
    if (typeof engine[method] !== 'function')
      problems.push(`${method}() must be a function`);
  if (problems.length)
    throw new ViewError(
      'INVALID_VIEW',
      `Invalid view engine adapter ${engine.name}: ${problems.join('; ')}`,
    );
}
export class ViewEngineRegistry {
  readonly #engines = new Map<string, ViewEngineAdapter>();
  register(engine: ViewEngineAdapter): void {
    if (!/^[a-z][a-z0-9-]*$/.test(engine.name))
      throw new ViewError('INVALID_VIEW', 'Invalid engine name');
    assertAdapterShape(engine);
    if (this.#engines.has(engine.name))
      throw new ViewError(
        'DUPLICATE_ENGINE',
        `Engine already registered: ${engine.name}`,
      );
    this.#engines.set(engine.name, engine);
  }
  get(name: string): ViewEngineAdapter {
    const engine = this.#engines.get(name);
    if (!engine)
      throw new ViewError('UNKNOWN_ENGINE', `Unknown engine: ${name}`);
    return engine;
  }
  require(name: string, capability: keyof ViewCapabilities): void {
    this.requireAll(name, [capability]);
  }
  /**
   * Startup check for every capability an application relies on. Fails once,
   * naming all missing capabilities and the ones the adapter does declare.
   */
  requireAll(
    name: string,
    required: readonly (keyof ViewCapabilities)[],
  ): void {
    const { capabilities } = this.get(name);
    for (const capability of required)
      if (!capabilityNames.includes(capability))
        throw new ViewError(
          'UNSUPPORTED_CAPABILITY',
          `Unknown view capability: ${String(capability)}`,
        );
    const missing = required.filter((capability) => !capabilities[capability]);
    if (missing.length) {
      const supported = capabilityNames.filter((key) => capabilities[key]);
      throw new ViewError(
        'UNSUPPORTED_CAPABILITY',
        `Engine ${name} does not support ${missing.join(', ')}. ` +
          `Declared capabilities: ${supported.join(', ') || 'none'}. ` +
          'Choose an engine that declares them or remove the dependent feature.',
      );
    }
  }
  async render<Context>(
    engine: string,
    view: string,
    model: ViewModel,
    context: Context,
    composers: readonly ViewComposer<Context>[] = [],
    options?: RenderOptions,
  ): Promise<string> {
    const composed: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    const merge = (source: ViewModel): void => {
      for (const [key, descriptor] of Object.entries(
        Object.getOwnPropertyDescriptors(source),
      )) {
        if (
          ['__proto__', 'prototype', 'constructor'].includes(key) ||
          descriptor.get ||
          descriptor.set
        )
          throw new ViewError('UNSAFE_MODEL', 'Unsafe composed view property');
        if (descriptor.enumerable)
          Object.defineProperty(composed, key, {
            ...descriptor,
            configurable: true,
          });
      }
    };
    for (const composer of composers) merge(await composer(view, context));
    merge(model);
    return this.get(engine).render(view, composed, options);
  }
  async initialize(): Promise<void> {
    const initialized: ViewEngineAdapter[] = [];
    try {
      for (const engine of this.#engines.values()) {
        await engine.initialize();
        initialized.push(engine);
      }
    } catch (error) {
      await Promise.allSettled(initialized.map((engine) => engine.dispose()));
      throw error;
    }
  }
  async dispose(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#engines.values()].reverse().map((engine) => engine.dispose()),
    );
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    );
    if (errors.length)
      throw new AggregateError(errors, 'View engine cleanup failed');
  }
}
export {
  TemplateRoot,
  assertViewAliases,
  copyViewModel,
  expressViewModel,
  invokeViewHelper,
  normalizeQualifiedViewId,
  normalizeViewId,
  parseViewName,
  resolveTemplateReference,
  type TemplateRootOptions,
  type ViewModelLimits,
  type ViewName,
} from './adapter-kit.js';
export {
  RouteTable,
  assetHelpers,
  escapeHtml,
  grantPermissions,
  helperArguments,
  pageMetaHelpers,
  permissionHelpers,
  routeHelpers,
  routesFromControllers,
  type ControllerRouteOptions,
  type HelperArguments,
  type PageMeta,
  type PageMetaOptions,
  type RouteParams,
  type RouteTableOptions,
  type ViewAssetProvider,
  type ViewPermissionCheck,
} from './helpers.js';
export {
  ViewErrorPageFilter,
  errorStatus,
  renderErrorPage,
  templateLocation,
  type ErrorPage,
  type ErrorPageHost,
  type ErrorPageOptions,
  type TemplateLocation,
  type ViewErrorPageFilterOptions,
} from './error-pages.js';
