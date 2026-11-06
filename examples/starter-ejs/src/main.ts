import 'reflect-metadata';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Inject,
  Module,
  Post,
  Render,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { EjsEngine } from '@nestvexa/engine-ejs';
import {
  Action,
  Computed,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  State,
} from '@nestvexa/live';
import { NestvexaAssetsModule, NestvexaAssetsService } from 'nestvexa/assets';
import session from 'express-session';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

declare module 'express-session' {
  interface SessionData {
    csrf?: string;
    contact?: { name: string; message: string };
    contactErrors?: Record<string, string>;
    contactSent?: string;
  }
}
interface SessionRequest {
  session: session.Session & Partial<session.SessionData>;
  sessionID: string;
  headers: Record<string, string | string[] | undefined>;
}

const port = Number(process.env['PORT'] ?? 3114);
const origin = `http://127.0.0.1:${port}`;
const root = fileURLToPath(new URL('../views', import.meta.url));
const csp =
  "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** One EJS engine instance renders MVC pages and Live component templates. */
const engine = new EjsEngine({
  root,
  cache: process.env['NODE_ENV'] === 'production',
  defaultLayout: 'layouts/main',
  partials: { nav: 'partials/nav' },
  helpers: {
    year: () => new Date().getUTCFullYear(),
    plural: (count: unknown, word: unknown) =>
      `${String(count)} ${String(word)}${count === 1 ? '' : 's'}`,
  },
});

@LiveComponent({ name: 'counter', view: 'components/counter' })
class Counter {
  @State() count = 0;
  /** Writable with a transport bound; the browser can change only this field. */
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 60,
  })
  name = '';
  @Computed() get greeting(): string {
    return this.name.trim() ? `Hello, ${this.name.trim()}!` : 'Hello!';
  }
  @Action() increment(): void {
    this.count++;
  }
  @Action() reset(): void {
    this.count = 0;
  }
}

function csrfOf(request: SessionRequest): string {
  request.session.csrf ??= randomBytes(32).toString('base64url');
  return request.session.csrf;
}
function sameToken(left: unknown, right: string | undefined): boolean {
  if (typeof left !== 'string' || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

@Controller()
class Pages {
  constructor(
    @Inject(LiveRuntime) private readonly live: LiveRuntime,
    @Inject(NestvexaAssetsService)
    private readonly assets: NestvexaAssetsService,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('home')
  async home(@Req() request: SessionRequest) {
    csrfOf(request);
    return {
      title: 'Nestvexa with EJS',
      path: '/',
      features: ['Layouts', 'Partials', 'Helpers', 'Live components'],
      untrusted: '<script>alert("escaped by <%= %>")</script>',
      counter: await this.live.mount(Counter, request),
    };
  }
  @Get('about')
  @Header('Content-Security-Policy', csp)
  @Render('about')
  about() {
    return { title: 'About the EJS starter', path: '/about' };
  }
  /** Progressive form: works without JavaScript through post/redirect/get. */
  @Get('contact')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('contact')
  contact(@Req() request: SessionRequest) {
    const csrf = csrfOf(request);
    const values = request.session.contact ?? { name: '', message: '' };
    const errors = request.session.contactErrors ?? {};
    const sent = request.session.contactSent ?? '';
    delete request.session.contact;
    delete request.session.contactErrors;
    delete request.session.contactSent;
    return { title: 'Contact', path: '/contact', csrf, values, errors, sent };
  }
  @Post('contact')
  submit(
    @Req() request: SessionRequest,
    @Body() body: unknown,
    @Res() response: { redirect(status: number, url: string): void },
  ) {
    // Same-origin and per-session CSRF checks before reading any field.
    if (request.headers['origin'] !== origin) throw new ForbiddenException();
    const fields =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    if (!sameToken(fields['_csrf'], request.session.csrf))
      throw new ForbiddenException('Invalid form token');
    const name =
      typeof fields['name'] === 'string' ? fields['name'].trim() : '';
    const message =
      typeof fields['message'] === 'string' ? fields['message'].trim() : '';
    const errors: Record<string, string> = {};
    if (name.length < 2 || name.length > 60)
      errors['name'] = 'Enter a name between 2 and 60 characters.';
    if (message.length < 10 || message.length > 500)
      errors['message'] = 'Write a message between 10 and 500 characters.';
    if (Object.keys(errors).length) {
      request.session.contact = {
        name: name.slice(0, 60),
        message: message.slice(0, 500),
      };
      request.session.contactErrors = errors;
    } else {
      // A real host would store or send the message here.
      request.session.contactSent = `Thanks, ${name}. Your message was received.`;
    }
    // 303 See Other: the browser follows with GET, so a reload never re-posts.
    response.redirect(303, '/contact');
  }
  @Get('api/health')
  health() {
    return { status: 'ok', engine: 'ejs' };
  }
  @Get('assets/site.css')
  @Header('Content-Type', 'text/css; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=300')
  stylesheet(): string {
    return 'body{font-family:system-ui,sans-serif;line-height:1.5;margin:0 auto;max-width:48rem;padding:1rem}nav a{margin-inline-end:1rem}nav a[aria-current]{font-weight:700}button,input,textarea{font:inherit}button{min-height:2.5rem;padding:.25rem .75rem}input,textarea{padding:.4rem;width:100%;max-width:28rem;box-sizing:border-box}label{display:block;margin-top:.75rem}[aria-invalid="true"]{outline:2px solid #b00020}.error{color:#b00020}.notice{color:#0b6b2e;font-weight:600}output{font-weight:700}';
  }
  /** App-owned boot module importing the versioned client assets. */
  @Get('assets/boot.js')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  boot(): string {
    const { entries } = this.assets.getManifest();
    return `import {createLiveClient} from ${JSON.stringify(entries.live)};
const client = createLiveClient();
client.mount();
window.addEventListener('pagehide', () => client.dispose());`;
  }
}

class EngineLifecycle {
  onModuleInit(): Promise<void> {
    return engine.initialize();
  }
  onApplicationShutdown(): Promise<void> {
    return engine.dispose();
  }
}

@Module({
  imports: [
    NestvexaAssetsModule.register(),
    LiveModule.register({
      components: [Counter],
      renderer: engine,
      origin,
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
        component === 'counter' &&
        ['$mount', '$sync', 'increment', 'reset'].includes(action),
    }),
  ],
  controllers: [Pages],
  providers: [EngineLifecycle],
})
class AppModule {}

const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  logger: ['error', 'warn'],
  // Explicit, small body parsers below instead of the defaults.
  bodyParser: false,
});
// Local guest demonstration: production hosts supply a persistent session store,
// a deployment secret, HTTPS-only cookies and their own authentication.
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
// JSON for Live requests; small flat urlencoded bodies for the contact form.
app.useBodyParser('json');
app.useBodyParser('urlencoded', { extended: false, limit: '8kb' });
// MVC bridge: @Render('home') resolves <root>/home.ejs through the adapter.
app.engine(
  'ejs',
  (
    file: string,
    options: Record<string, unknown>,
    done: (error: Error | null, html?: string) => void,
  ) => engine.renderFile(file, options, done),
);
app.setBaseViewsDir(root);
app.setViewEngine('ejs');
app.enableShutdownHooks();
await app.listen(port, '127.0.0.1');
console.log(`EJS starter: ${await app.getUrl()}`);
