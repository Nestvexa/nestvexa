import 'reflect-metadata';
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Inject,
  Module,
  Post,
  Query,
  Redirect,
  Render,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  Action,
  ActionInput,
  LiveComponent,
  LiveRuntime,
  MemoryLiveStore,
  NestvexaModule,
  OnEvent,
  State,
  configureNestvexa,
  dispatchLiveEvent,
} from 'nestvexa';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import session from 'express-session';

declare module 'express-session' {
  interface SessionData {
    csrf?: string;
    served?: Record<string, number>;
    note?: string;
  }
}
interface SessionRequest {
  session: session.Session & Partial<session.SessionData>;
  sessionID: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}
const port = Number(process.env['PORT'] ?? 3860);
const root = fileURLToPath(new URL('../views', import.meta.url));
const policy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

/** A counter with a deferred draft: typing makes the page "dirty" until saved. */
@LiveComponent({ name: 'lab-counter', view: 'lab-counter' })
class LabCounter {
  @State() count = 0;
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 80,
  })
  note = '';
  @State() saved = '';
  @Action() increment(): void {
    this.count++;
  }
  @Action() save(): void {
    this.saved = this.note;
  }
}

function label(input: unknown): string {
  const text: unknown =
    input && typeof input === 'object' ? Reflect.get(input, 'text') : input;
  if (typeof text !== 'string' || text.length > 40)
    throw new BadRequestException('Invalid lab event payload');
  return text;
}

/** Receives browser-dispatched events and emits a server event for Alpine `$live.on`. */
@LiveComponent({ name: 'lab-listener', view: 'lab-listener' })
class LabListener {
  @State() received = 0;
  @State() last = '';
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 40,
  })
  title = 'Draft';
  @State() level = 1;
  @Action()
  @OnEvent('lab.ping')
  ping(@ActionInput({ transform: label }) text: string): void {
    this.received++;
    this.last = text;
  }
  @Action() announce(): void {
    this.level++;
    dispatchLiveEvent(this, 'lab.pong', { text: `level ${this.level}` });
  }
  @Action() rename(): void {
    this.title = `${this.title}!`;
  }
}

/** Polls once per second and exposes connectivity presentation. */
@LiveComponent({ name: 'lab-ticker', view: 'lab-ticker' })
class LabTicker {
  @State() ticks = 0;
  @State() clicks = 0;
  @Action() tick(): void {
    this.ticks++;
  }
  @Action() click(): void {
    this.clicks++;
  }
}

/**
 * One of many small components for lifecycle/leak checks: a slow poll timer,
 * an intersection observer and an Alpine `$live` subtree per instance.
 */
@LiveComponent({ name: 'lab-cell', view: 'lab-cell' })
class LabCell {
  @State() hits = 0;
  @State() seen = false;
  @Action() hit(): void {
    this.hits++;
  }
  @Action() see(): void {
    this.seen = true;
  }
  @Action() poll(): void {
    // Background refresh; the 60 s interval never fires during tests.
  }
}

function count(request: SessionRequest, page: string): number {
  const served = (request.session.served ??= {});
  served[page] = (served[page] ?? 0) + 1;
  return served[page];
}
function start(request: SessionRequest): void {
  request.session.csrf ??= randomBytes(32).toString('base64url');
}

@Controller()
class LabPages {
  constructor(@Inject(LiveRuntime) private readonly live: LiveRuntime) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', policy)
  @Render('home')
  async home(@Req() request: SessionRequest) {
    start(request);
    return {
      title: 'Browser lab',
      description: 'Live navigation and runtime lab',
      served: count(request, 'home'),
      hostNote: request.session.note ?? '',
      widget: await this.live.mount(LabCounter, request),
    };
  }
  /**
   * The no-JS equivalent of the counter's `save` action. The Live client hands
   * the form to the browser only once the component is suspended.
   */
  @Post('note')
  @Redirect('/', 303)
  note(@Req() request: SessionRequest) {
    if (request.headers['origin'] !== `http://127.0.0.1:${port}`)
      throw new ForbiddenException();
    const note: unknown =
      request.body && typeof request.body === 'object'
        ? Reflect.get(request.body, 'note')
        : undefined;
    if (typeof note !== 'string' || note.length > 80)
      throw new BadRequestException('Invalid note');
    request.session.note = note;
    return undefined;
  }
  @Get('long')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', policy)
  @Render('long')
  async long(@Req() request: SessionRequest) {
    start(request);
    return {
      title: 'Long page',
      description: 'A tall page for scroll restoration',
      robots: 'noindex',
      served: count(request, 'long'),
      widget: await this.live.mount(LabCounter, request),
    };
  }
  @Get('prefetch')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', policy)
  @Render('prefetch')
  prefetch(@Req() request: SessionRequest) {
    start(request);
    return {
      title: 'Prefetched page',
      description: 'Served from the prefetch cache',
      served: count(request, 'prefetch'),
    };
  }
  /** Same layout plus one extra stylesheet: asset identity differs, so navigation falls back. */
  @Get('assets-differ')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', policy)
  @Render('plain')
  assetsDiffer(@Req() request: SessionRequest) {
    return {
      title: 'Different assets',
      description: 'Loads an extra stylesheet',
      extraStyles: true,
      served: count(request, 'assets-differ'),
    };
  }
  /** Right-to-left document: direction differs, so navigation falls back. */
  @Get('rtl')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', policy)
  @Render('plain')
  rtl(@Req() request: SessionRequest) {
    return {
      title: 'RTL page',
      description: 'Right-to-left document',
      dir: 'rtl',
      served: count(request, 'rtl'),
    };
  }
  @Get('plain.txt')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  text(@Req() request: SessionRequest) {
    count(request, 'plain.txt');
    return 'Plain text is never swapped into the document.';
  }
  @Get('to-long')
  @Redirect('/long', 302)
  toLong() {
    return undefined;
  }
  @Get('alpine')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', policy)
  @Render('alpine')
  async alpine(@Req() request: SessionRequest) {
    start(request);
    return {
      title: 'Alpine bridge',
      description: 'Alpine $live helpers against a real server',
      served: count(request, 'alpine'),
      widget: await this.live.mount(LabListener, request),
    };
  }
  @Get('ticker')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', policy)
  @Render('home')
  async ticker(@Req() request: SessionRequest) {
    start(request);
    return {
      title: 'Ticker',
      description: 'Polling and connectivity',
      served: count(request, 'ticker'),
      widget: await this.live.mount(LabTicker, request),
    };
  }
  @Get('many')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', policy)
  @Render('many')
  async many(@Req() request: SessionRequest, @Query('count') size?: string) {
    start(request);
    const total = Math.min(Math.max(Number(size ?? '12') || 12, 1), 40);
    const cells = [];
    for (let index = 0; index < total; index++)
      cells.push(await this.live.mount(LabCell, request));
    return {
      title: `Many components (${total})`,
      description: 'Lifecycle and leak checks',
      served: count(request, 'many'),
      total,
      cells,
    };
  }
  /** Per-session counts of full HTML responses, so tests can tell swaps, prefetch reuse and reloads apart. */
  @Get('api/served')
  @Header('Cache-Control', 'no-store')
  served(@Req() request: SessionRequest) {
    return request.session.served ?? {};
  }
  @Get('api/health')
  health() {
    return { status: 'ok' };
  }
  @Get('lab.css')
  @Header('Content-Type', 'text/css; charset=utf-8')
  styles() {
    return 'body{font-family:system-ui,sans-serif;line-height:1.5;margin:0 auto;max-width:60rem;padding:1rem}button,input{font:inherit;min-height:2.75rem;margin:.25rem}.tall{height:2400px;border-left:4px solid #888;padding-left:1rem}.cell{display:inline-block;border:1px solid #888;margin:.25rem;padding:.25rem}.reload-hint{display:none}[data-nv-suspended] .reload-hint{display:block}';
  }
  /**
   * CSP-build Alpine has no arrow functions in templates, so callbacks for
   * `$live.on` live in registered components. This module runs before the
   * default boot module, which announces `nestvexa:alpine:init` before start.
   */
  @Get('lab-alpine.js')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  alpineComponents() {
    return `document.addEventListener('nestvexa:alpine:init', (event) => {
  const { Alpine } = event.detail;
  Alpine.data('labCell', () => ({
    pongs: 0,
    init() { this.$live.on('lab.cell', () => { this.pongs++; }); },
  }));
  Alpine.data('labEvents', () => ({
    log: '',
    unsubscribe: null,
    init() {
      this.unsubscribe = this.$live.on('lab.pong', (payload, source) => {
        this.log += (this.log ? ',' : '') + String(source) + ':' + payload.text;
      });
    },
    stop() { if (this.unsubscribe) this.unsubscribe(); this.unsubscribe = null; },
  }));
});`;
  }
  @Get('lab-extra.css')
  @Header('Content-Type', 'text/css; charset=utf-8')
  extraStyles() {
    return 'h1{letter-spacing:.02em}';
  }
}

@Module({
  imports: [
    NestvexaModule.forRoot(
      { views: { root, layout: 'layout' }, live: { enabled: true } },
      {
        components: [LabCounter, LabListener, LabTicker, LabCell],
        useFactory: () => ({
          origin: `http://127.0.0.1:${port}`,
          // The leak checks mount hundreds of components per minute per session.
          maxRequestsPerMinute: 5000,
          store: new MemoryLiveStore({ maxEntries: 50_000, ttlMs: 600_000 }),
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
            (component === 'lab-counter' &&
              ['$mount', '$sync', 'increment', 'save'].includes(action)) ||
            (component === 'lab-listener' &&
              ['$mount', '$sync', 'ping', 'announce', 'rename'].includes(
                action,
              )) ||
            (component === 'lab-ticker' &&
              ['$mount', '$sync', 'tick', 'click'].includes(action)) ||
            (component === 'lab-cell' &&
              ['$mount', '$sync', 'hit', 'see', 'poll'].includes(action)),
        }),
      },
    ),
  ],
  controllers: [LabPages],
})
class AppModule {}

const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
// Local demonstration only: production requires authentication, a persistent
// session store, a deployment secret and HTTPS cookies.
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
console.log(`Browser lab: ${await app.getUrl()}`);
