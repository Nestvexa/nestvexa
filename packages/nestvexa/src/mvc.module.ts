import { Inject, Injectable, Module } from '@nestjs/common';
import type {
  DynamicModule,
  INestApplication,
  OnApplicationShutdown,
  Provider,
} from '@nestjs/common';
import { CoreModule, NestvexaConfigService } from '@nestvexa/core';
import { HbsEngine } from '@nestvexa/engine-hbs';
import { resolve } from 'node:path';
import {
  NestvexaBrowserModule,
  NestvexaBrowserService,
  documentScripts,
} from './browser.module.js';

function engineProvider(withLive: boolean): Provider {
  return {
    provide: HbsEngine,
    inject: [
      NestvexaConfigService,
      ...(withLive ? [NestvexaBrowserService] : []),
    ],
    useFactory: (
      config: NestvexaConfigService,
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
      return new HbsEngine({
        root: views.root,
        cache: views.cache,
        ...(views.layout ? { defaultLayout: views.layout } : {}),
        ...(browser
          ? {
              helpers: {
                nvScripts: (...args: unknown[]) =>
                  documentScripts(browser, args),
              },
            }
          : {}),
      });
    },
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
      providers: [engineProvider(browser !== undefined), NestvexaRuntime],
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
        typeof host.set === 'function'
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
      const html = await engine.render(view, model);
      return this.type('text/html; charset=utf-8').send(html);
    });
  }
}

/** Application-local initialization and teardown; no process-global registry. */
@Injectable()
class NestvexaRuntime implements OnApplicationShutdown {
  private app: INestApplication | undefined;
  private setup: Promise<void> | undefined;
  private disposed = false;
  constructor(
    @Inject(HbsEngine) private readonly engine: HbsEngine,
    @Inject(NestvexaConfigService)
    private readonly config: NestvexaConfigService,
  ) {}

  configure(app: INestApplication): Promise<void> {
    if (this.disposed)
      return Promise.reject(new Error('Nestvexa runtime has shut down'));
    if (this.app && this.app !== app)
      return Promise.reject(
        new Error('Nestvexa runtime is already bound to another application'),
      );
    this.app = app;
    this.setup ??= installViews(app, this.engine, this.config);
    return this.setup;
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.setup) await this.setup.catch(() => undefined);
    await this.engine.dispose();
  }
}

/** Install the view bridge once before listen(). Concurrent repeated calls share initialization. */
export async function configureNestvexa(app: INestApplication): Promise<void> {
  await app.get(NestvexaRuntime).configure(app);
}
