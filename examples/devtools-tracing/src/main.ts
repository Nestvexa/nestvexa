import 'reflect-metadata';
import {
  Controller,
  Get,
  Header,
  Inject,
  Module,
  NotFoundException,
  Render,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Cache } from '@nestvexa/cache';
import {
  Action,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  State,
} from '@nestvexa/live';
import {
  DevtoolsInspector,
  DevtoolsModule,
  MemoryInstrumentation,
  combineInstrumentation,
  openTelemetryInstrumentation,
  requestTracingMiddleware,
  traceContextMiddleware,
} from '@nestvexa/observability';
import { context, trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import session from 'express-session';
import { HbsEngine, NestvexaModule, configureNestvexa } from 'nestvexa';
import { NestvexaAssetsModule, NestvexaAssetsService } from 'nestvexa/assets';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

declare module 'express-session' {
  interface SessionData {
    csrf?: string;
  }
}
interface SessionRequest {
  session: session.Session & Partial<session.SessionData>;
  sessionID: string;
  socket?: { remoteAddress?: string };
}

const port = Number(process.env['PORT'] ?? 4340);
const development = process.env['NODE_ENV'] !== 'production';
const root = fileURLToPath(new URL('../views', import.meta.url));
const renderer = new HbsEngine({ root });

// OpenTelemetry: the official SDK with an in-memory exporter so the example
// can show its spans at /api/traces. Swap the exporter for OTLP in a real
// deployment; Nestvexa only talks to `@opentelemetry/api`.
const exporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(
  new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  }),
);
const otel = openTelemetryInstrumentation(trace.getTracer('nestvexa-example'), {
  // Parent spans on the validated inbound `traceparent` (the browser's).
  api: { context, trace },
});
// Development panel recorders. The inspector refuses to exist in production.
const memory = new MemoryInstrumentation();
const inspector = development ? new DevtoolsInspector() : undefined;
const instrumentation = development
  ? combineInstrumentation(memory, otel)
  : otel;
const cache = new Cache({
  instrumentation,
  // Structural hook: hit/miss/invalidate events reach the panel.
  onEvent: (event) => inspector?.cacheEvent(event),
});

@LiveComponent({ name: 'meter', view: 'meter' })
class Meter {
  @State() count = 0;
  @State() plan = '';
  @State() lookups = 0;
  @Action() async bump(): Promise<void> {
    this.count++;
    this.lookups++;
    // A read-through lookup: the first call misses, later calls hit.
    this.plan = await cache.get(
      { scope: { kind: 'public' }, namespace: 'data:meter-plan' },
      { ttlMs: 60_000, tags: ['meter-plan'] },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return 'Team plan';
      },
    );
  }
  @Action() async refreshPlan(): Promise<void> {
    await cache.invalidate(['meter-plan']);
    this.plan = '';
  }
}

/** The panel is for the developer on this machine only. */
function isLocalDeveloper(request: object): boolean {
  const address = (request as SessionRequest).socket?.remoteAddress ?? '';
  return (
    development && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)
  );
}

@Controller()
class PageController {
  constructor(
    @Inject(LiveRuntime) private readonly live: LiveRuntime,
    @Inject(NestvexaAssetsService)
    private readonly assets: NestvexaAssetsService,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  )
  @Render('page')
  async page(@Req() request: SessionRequest) {
    request.session.csrf ??= randomBytes(32).toString('base64url');
    return { widget: await this.live.mount(Meter, request), development };
  }
  @Get('api/health') health() {
    return { status: 'ok' };
  }
  /** Spans the OpenTelemetry SDK finished (development only). */
  @Get('api/traces')
  @Header('Cache-Control', 'no-store')
  traces(@Req() request: object) {
    if (!isLocalDeveloper(request)) throw new NotFoundException();
    return exporter.getFinishedSpans().map((span) => ({
      name: span.name,
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
      parentSpanId: span.parentSpanContext?.spanId ?? null,
      attributes: span.attributes,
    }));
  }
  @Get('assets/example.css')
  @Header('Content-Type', 'text/css; charset=utf-8')
  stylesheet() {
    return 'body{font-family:system-ui,sans-serif;line-height:1.6;margin:2rem;max-width:48rem}button{font:inherit;min-height:2.75rem;padding:.4rem .8rem;margin:.25rem}output{font-variant-numeric:tabular-nums}';
  }
  /** The browser half of the panel, served in development only. */
  @Get('assets/devtools-client.js')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  async devtoolsClient() {
    if (!development) throw new NotFoundException();
    return readFile(
      fileURLToPath(
        import.meta.resolve('@nestvexa/observability/devtools-client'),
      ),
      'utf8',
    );
  }
  @Get('assets/boot.js')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  boot() {
    const { entries } = this.assets.getManifest();
    const live = JSON.stringify(entries.live);
    // `tracing: true` sends a W3C traceparent with every Live request, so
    // server spans join the browser trace; the reporter sends morph timing
    // and network sizes to the development panel.
    return development
      ? `import {createLiveClient} from ${live};
import {devtoolsReporter} from '/assets/devtools-client.js';
const reporter = devtoolsReporter();
const client = createLiveClient({tracing: true, development: true, onDiagnostic: reporter.onDiagnostic});
client.mount();
window.addEventListener('pagehide', () => {void reporter.flush(); client.dispose();});`
      : `import {createLiveClient} from ${live};
const client = createLiveClient();
client.mount();
window.addEventListener('pagehide', () => client.dispose());`;
  }
}

class LiveRendererLifecycle {
  onModuleInit(): Promise<void> {
    return renderer.initialize();
  }
  onApplicationShutdown(): Promise<void> {
    return renderer.dispose();
  }
}

@Module({
  imports: [
    NestvexaModule.forRoot({ views: { root } }),
    NestvexaAssetsModule.register(),
    LiveModule.register({
      components: [Meter],
      renderer,
      origin: `http://127.0.0.1:${port}`,
      instrumentation,
      ...(inspector ? { inspector } : {}),
      resolveIdentity(request: object) {
        const value = request as Partial<SessionRequest>;
        if (!value.session?.csrf || !value.sessionID)
          throw new UnauthorizedException();
        return {
          binding: `guest-session:${value.sessionID}`,
          csrfToken: value.session.csrf,
        };
      },
      authorize: (_identity, component, action) =>
        component === 'meter' &&
        ['$mount', '$sync', 'bump', 'refreshPlan'].includes(action),
    }),
    // Development only: DevtoolsModule.register throws in production.
    ...(development
      ? [
          DevtoolsModule.register({
            instrumentation: memory,
            ...(inspector ? { inspector } : {}),
            authorize: isLocalDeveloper,
          }),
        ]
      : []),
  ],
  controllers: [PageController],
  providers: [LiveRendererLifecycle],
})
class AppModule {}

const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
// Validated inbound trace context first (never used for authorization), then
// request ids and the request span.
app.use(traceContextMiddleware());
app.use(requestTracingMiddleware(instrumentation));
// Local demonstration only: production requires a persistent session store and deployment secret.
app.use(
  session({
    secret: randomBytes(48).toString('base64url'),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      secure: false,
      maxAge: 900_000,
    },
  }),
);
await configureNestvexa(app);
app.enableShutdownHooks();
await app.listen(port, '127.0.0.1');
console.log(`Devtools and tracing: ${await app.getUrl()}`);
