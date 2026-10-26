import 'reflect-metadata';
import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Inject,
  Module,
  Render,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HbsEngine, NestvexaModule, configureNestvexa } from 'nestvexa';
import {
  LiveModule,
  LiveRuntime,
  LiveComponent,
  State,
  Computed,
  Action,
} from '@nestvexa/live';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import session from 'express-session';

declare module 'express-session' {
  interface SessionData {
    csrf?: string;
  }
}
interface SessionRequest {
  session: session.Session & Partial<session.SessionData>;
  sessionID: string;
}
const port = Number(process.env['PORT'] ?? 3101);
const root = fileURLToPath(new URL('../views', import.meta.url));
const renderer = new HbsEngine({ root });
const clientEntry = new URL(import.meta.resolve('@nestvexa/client'));
const alpineAdapter = new URL(import.meta.resolve('@nestvexa/alpine'));
const alpineEntry = new URL(
  './module.esm.js',
  import.meta.resolve('@alpinejs/csp'),
);

@LiveComponent({ name: 'counter', view: 'counter' })
class Counter {
  @State() count = 0;
  @State({ writable: true }) name = '';
  @State() saved = '';
  @State() visible = true;
  @State() healthLink = '/api/health';
  @Action() toggleVisible(): void {
    this.visible = !this.visible;
  }
  @Computed() get doubled(): number {
    return this.count * 2;
  }
  @Action() increment(): void {
    this.count++;
  }
  @Action() decrement(): void {
    this.count--;
  }
  @Action() save(): void {
    if (this.name.length > 80)
      throw new BadRequestException('Name is too long');
    this.saved = this.name;
  }
  @Action() async slow(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 200));
    this.count++;
  }
}

@Controller()
class PageController {
  constructor(@Inject(LiveRuntime) private readonly live: LiveRuntime) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  )
  @Render('page')
  async page(@Req() request: SessionRequest) {
    request.session.csrf ??= randomBytes(32).toString('base64url');
    return { widget: await this.live.mount(Counter, request) };
  }
  @Get('api/health') health() {
    return { status: 'ok' };
  }
  @Get('assets/example.css')
  @Header('Content-Type', 'text/css; charset=utf-8')
  stylesheet() {
    return 'body{font-family:system-ui,sans-serif;line-height:1.6;margin:2rem;max-width:60rem}button,input{font:inherit;min-height:2.75rem;box-sizing:border-box}button{padding:.4rem .8rem;margin:.25rem}input{padding:.4rem;margin:.25rem}form{margin-block:1rem}output{font-variant-numeric:tabular-nums}';
  }
  @Get('assets/live.js')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  client() {
    return readFile(clientEntry, 'utf8');
  }
  @Get('assets/morph.js')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  morph() {
    return readFile(new URL('./morph.js', clientEntry), 'utf8');
  }
  @Get('assets/protocol.js')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  protocol() {
    return readFile(new URL('./protocol.js', clientEntry), 'utf8');
  }
  @Get('assets/grammar.js')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  grammar() {
    return readFile(new URL('./grammar.js', clientEntry), 'utf8');
  }
  @Get('assets/bindings.js')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  bindings() {
    return readFile(new URL('./bindings.js', clientEntry), 'utf8');
  }
  @Get('assets/alpine.js')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  alpine() {
    return readFile(alpineEntry, 'utf8');
  }
  @Get('assets/alpine-adapter.js')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  adapter() {
    return readFile(alpineAdapter, 'utf8');
  }
  @Get('assets/boot.js')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  boot() {
    return `import {createLiveClient} from './live.js';
import Alpine from './alpine.js';
import {installLiveAlpine} from './alpine-adapter.js';
const client = createLiveClient({onError(error) {document.getElementById('status').textContent = error.message;}});
client.mount(); client.mount();
installLiveAlpine(Alpine, client); installLiveAlpine(Alpine, client);
Alpine.data('localCounter', () => ({clicks: 0, incrementLocal() {this.clicks++}, incrementServer() {return this.$live.call('increment')}, renameServer() {this.$live.set('name', 'From Alpine'); return this.$live.call('save')}}));
Alpine.start();
window.addEventListener('pagehide', () => client.dispose());
document.addEventListener('nestvexa:updated', () => {document.getElementById('status').textContent = 'Updated';});`;
  }
}

@Module({
  imports: [
    NestvexaModule.forRoot({ views: { root } }),
    LiveModule.register({
      components: [Counter],
      renderer,
      origin: `http://127.0.0.1:${port}`,
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
        [
          '$mount',
          'increment',
          'decrement',
          'save',
          'slow',
          'toggleVisible',
        ].includes(action),
    }),
  ],
  controllers: [PageController],
})
class AppModule {}

const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
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
console.log(`Live counter: ${await app.getUrl()}`);
