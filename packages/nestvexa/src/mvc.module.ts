import { Inject, Injectable, Module } from '@nestjs/common';
import type {
  DynamicModule,
  INestApplication,
  OnApplicationShutdown,
  Provider,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import {
  CoreModule,
  NestvexaConfigService,
  NestvexaRegistry,
} from '@nestvexa/core';
import type { FeatureCapability } from '@nestvexa/core';
import { HbsEngine } from '@nestvexa/engine-hbs';
import { ViewErrorPageFilter, expressViewModel } from '@nestvexa/views';
import type { ViewErrorPageFilterOptions } from '@nestvexa/views';
import { resolve } from 'node:path';
import {
  NestvexaBrowserModule,
  NestvexaBrowserService,
  documentScripts,
} from './browser.module.js';
import { NestvexaViewContextInterceptor } from './view-context.js';

function engineProvider(withLive: boolean): Provider {
  return {
    provide: HbsEngine,
    inject: [
      NestvexaConfigService,
      NestvexaRegistry,
      ...(withLive ? [NestvexaBrowserService] : []),
    ],
    useFactory: (
      config: NestvexaConfigService,
      registry: NestvexaRegistry,
      browser?: NestvexaBrowserService,
    ) => {
      const { views, live } = config.value;
      if (views.engine !== 'hbs')
        throw new Error(
          'This distribution requires the hbs engine. Register another adapter explicitly.',
        );
      if (live.enabled !== withLive)
        throw new Error(
          'live.enabled must match the explicit umbrella Live registration.',
        );
      if (
        withLive &&
        (!config.value.security.csrf ||
          !config.value.security.requireAuthorizedActions)
      )
        throw new Error('Integrated Live requires CSRF and authorized actions');
      const engine = new HbsEngine({
        root: views.root,
        cache: views.cache,
        ...(views.layout ? { defaultLayout: views.layout } : {}),
        ...(views.namespaces ? { namespaces: views.namespaces } : {}),
        ...(views.themes ? { themes: views.themes } : {}),
        ...(browser
          ? {
              helpers: {
                nvScripts: (...args: unknown[]) =>
                  documentScripts(browser, args),
              },
            }
          : {}),
      });
      registry.registerFeature(viewsFeature(engine));
      return engine;
    },
  };
}

/** The default renderer and its declared capabilities, as a kernel feature. */
function viewsFeature(engine: HbsEngine) {
  const capabilities: Record<string, FeatureCapability> = {};
  for (const [name, supported] of Object.entries(engine.capabilities))
    capabilities[
      `${engine.name}.${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`
    ] =
      supported === true
        ? { supported: true }
        : {
            supported: false,
            reason: `Not supported by the ${engine.name} adapter`,
          };
  return {
    name: 'views',
    package: 'nestvexa',
    renderers: [engine.name],
    capabilities,
  };
}

/** Default distribution. Call configureNestvexa before app.listen(). */
@Module({})
export class NestvexaRendererModule {
  static configure(
    core: DynamicModule,
    browser?: DynamicModule,
  ): DynamicModule {
    return {
      module: NestvexaRendererModule,
      imports: [core, ...(browser ? [browser] : [])],
      providers: [
        engineProvider(browser !== undefined),
        NestvexaRuntime,
        // Rendered views read the kernel request context (CSP nonce, correlation ID).
        { provide: APP_INTERCEPTOR, useClass: NestvexaViewContextInterceptor },
      ],
      exports: [
        CoreModule,
        HbsEngine,
        NestvexaRuntime,
        ...(browser ? [NestvexaBrowserModule] : []),
      ],
    };
  }
}

interface ExpressViewHost {
  engine(
    extension: string,
    callback: (
      path: string,
      options: Record<string, unknown>,
      callback: (error: Error | null, html?: string) => void,
    ) => void,
  ): unknown;
  set(name: string, value: unknown): unknown;
  get(name: string): unknown;
}
interface ViewReply {
  type(contentType: string): ViewReply;
  send(html: string): unknown;
}
interface FastifyViewHost {
  hasReplyDecorator(name: string): boolean;
  decorateReply(
    name: string,
    fn: (
      this: ViewReply,
      view: string,
      model: Record<string, unknown>,
    ) => Promise<unknown>,
  ): unknown;
}

function expressHost(host: unknown): host is ExpressViewHost {
  return typeof host === 'function' ||
    (typeof host === 'object' && host !== null)
    ? 'engine' in host &&
        typeof host.engine === 'function' &&
        'set' in host &&
        typeof host.set === 'function' &&
        'get' in host &&
        typeof host.get === 'function'
    : false;
}
function fastifyHost(host: unknown): host is FastifyViewHost {
  return (
    typeof host === 'object' &&
    host !== null &&
    'hasReplyDecorator' in host &&
    typeof host.hasReplyDecorator === 'function' &&
    'decorateReply' in host &&
    typeof host.decorateReply === 'function'
  );
}

/** A first-party (or `TemplateRoot`-based) adapter for a non-HBS extension. */
export interface ViewEngineBridge {
  render(view: string, model: Record<string, unknown>): Promise<string>;
  renderFile(
    file: string,
    options: Record<string, unknown>,
    done: (error: Error | null, html?: string) => void,
  ): void;
  initialize?(): Promise<void>;
}
/** Per HTTP host: extension → adapter (Fastify's `reply.view` decorator consults it). */
const viewEngines = new WeakMap<object, Map<string, ViewEngineBridge>>();
function fastifyEngineFor(
  host: object,
  view: string,
): ViewEngineBridge | undefined {
  const engines = viewEngines.get(host);
  if (!engines) return undefined;
  const dot = view.lastIndexOf('.');
  return dot > view.lastIndexOf('/')
    ? engines.get(view.slice(dot + 1))
    : undefined;
}

/**
 * Register another template engine for `@Render('<view>.<extension>')` next to
 * the default Handlebars engine: `app.engine()` on Express; on Fastify the
 * `reply.view` decorator of `configureNestvexa` dispatches by extension. Views
 * without the extension keep rendering with Handlebars. Call before
 * `app.listen()`; the engine is initialized here.
 */
export async function registerViewEngine(
  app: INestApplication,
  extension: string,
  engine: ViewEngineBridge,
): Promise<void> {
  if (!/^[a-z][a-z0-9]{0,15}$/.test(extension) || extension === 'hbs')
    throw new Error(`Invalid view engine extension: ${extension}`);
  if (
    typeof engine?.render !== 'function' ||
    typeof engine.renderFile !== 'function'
  )
    throw new Error('A view engine needs render() and renderFile()');
  const adapter = app.getHttpAdapter();
  const kind: string = adapter.getType();
  const host: unknown = adapter.getInstance();
  const express = kind === 'express' && expressHost(host);
  if (!express && !(kind === 'fastify' && fastifyHost(host)))
    throw new Error(`Unsupported Nest HTTP adapter: ${kind}`);
  if (host === null || (typeof host !== 'object' && typeof host !== 'function'))
    throw new Error(`Unsupported Nest HTTP adapter: ${kind}`);
  const engines = viewEngines.get(host) ?? new Map<string, ViewEngineBridge>();
  if (engines.has(extension))
    throw new Error(`A .${extension} view engine is already registered`);
  await engine.initialize?.();
  engines.set(extension, engine);
  viewEngines.set(host, engines);
  if (express)
    host.engine(extension, (file, model, done) =>
      engine.renderFile(file, model, done),
    );
}

type ExpressRenderCallback = (error: Error | null, html?: string) => void;
/**
 * Express resolves `res.render(name)` to a file before calling an engine, which
 * cannot work for `admin::users/index`. This `view` class hands namespaced
 * names to the Handlebars engine (which resolves them inside the registered
 * namespace) and keeps Express's own `View` for every other name.
 */
function namespacedViews(base: unknown, engine: HbsEngine): unknown {
  if (typeof base !== 'function') return base;
  return function NestvexaView(
    name: unknown,
    options: unknown,
  ): { readonly path: string; render: unknown } {
    if (typeof name !== 'string' || !name.includes('::'))
      return Reflect.construct(base, [name, options]) as {
        readonly path: string;
        render: unknown;
      };
    return {
      path: name,
      render(model: Record<string, unknown>, done: ExpressRenderCallback) {
        void engine.render(name, expressViewModel(model)).then(
          (html) => done(null, html),
          (error: unknown) =>
            done(error instanceof Error ? error : new Error('Render failed')),
        );
      },
    };
  };
}

async function installViews(
  app: INestApplication,
  engine: HbsEngine,
  config: NestvexaConfigService,
): Promise<void> {
  const adapter = app.getHttpAdapter();
  const kind: string = adapter.getType();
  if (kind !== 'express' && kind !== 'fastify')
    throw new Error(`Unsupported Nest HTTP adapter: ${kind}`);
  const host: unknown = adapter.getInstance();
  if (kind === 'express') {
    if (!expressHost(host)) throw new Error('Invalid Express view host');
    await engine.initialize();
    host.engine('hbs', (file, model, done) =>
      engine.renderFile(file, model, done),
    );
    host.set('views', resolve(config.value.views.root));
    if (config.value.views.namespaces)
      host.set('view', namespacedViews(host.get('view'), engine));
    host.set('view engine', 'hbs');
    host.set('view cache', config.value.views.cache);
  } else {
    if (!fastifyHost(host)) throw new Error('Invalid Fastify view host');
    if (host.hasReplyDecorator('view'))
      throw new Error(
        'Fastify reply.view is already registered. Configure a single view owner.',
      );
    await engine.initialize();
    host.decorateReply('view', async function (view, model) {
      const html = await (fastifyEngineFor(host, view) ?? engine).render(
        view,
        model,
      );
      return this.type('text/html; charset=utf-8').send(html);
    });
  }
}

/**
 * View-rendered error pages installed by {@link configureNestvexa}: the
 * `ViewErrorPageFilter` options except `render`, which is the umbrella's own
 * Handlebars engine.
 */
export type NestvexaErrorPageOptions = Omit<
  ViewErrorPageFilterOptions,
  'render'
>;
export interface ConfigureNestvexaOptions {
  /**
   * Opt-in catch-all exception filter (`app.useGlobalFilters`) rendering error
   * views for browser page requests (`Accept: text/html`) and Nest's JSON body
   * for everything else, including Live and action calls. `development: true`
   * shows the diagnostic page (messages, template name/line, stacks); never
   * enable it in production.
   */
  readonly errorPages?: NestvexaErrorPageOptions;
}

/** Application-local initialization and teardown; no process-global registry. */
@Injectable()
class NestvexaRuntime implements OnApplicationShutdown {
  private app: INestApplication | undefined;
  private setup: Promise<void> | undefined;
  private options: ConfigureNestvexaOptions | undefined;
  private disposed = false;
  constructor(
    @Inject(HbsEngine) private readonly engine: HbsEngine,
    @Inject(NestvexaConfigService)
    private readonly config: NestvexaConfigService,
  ) {}

  configure(
    app: INestApplication,
    options: ConfigureNestvexaOptions | undefined,
  ): Promise<void> {
    if (this.disposed)
      return Promise.reject(new Error('Nestvexa runtime has shut down'));
    if (this.app && this.app !== app)
      return Promise.reject(
        new Error('Nestvexa runtime is already bound to another application'),
      );
    if (this.setup && options !== undefined && options !== this.options)
      return Promise.reject(
        new Error(
          'configureNestvexa options are accepted on the first call only',
        ),
      );
    this.app = app;
    if (!this.setup) {
      this.options = options;
      const errorPages = options?.errorPages;
      if (errorPages !== undefined) {
        if (
          typeof errorPages !== 'object' ||
          errorPages === null ||
          'render' in errorPages
        )
          return Promise.reject(
            new Error(
              'errorPages must be ViewErrorPageFilter options without render',
            ),
          );
        const engine = this.engine;
        app.useGlobalFilters(
          new ViewErrorPageFilter({
            ...errorPages,
            render: (view, model) => engine.render(view, model),
          }),
        );
      }
      this.setup = installViews(app, this.engine, this.config);
    }
    return this.setup;
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.setup) await this.setup.catch(() => undefined);
    await this.engine.dispose();
  }
}

/**
 * Install the view bridge once before listen(). Concurrent repeated calls
 * share initialization; options are accepted on the first call only.
 */
export async function configureNestvexa(
  app: INestApplication,
  options?: ConfigureNestvexaOptions,
): Promise<void> {
  await app.get(NestvexaRuntime).configure(app, options);
}
