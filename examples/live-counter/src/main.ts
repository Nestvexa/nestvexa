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
import { NestvexaAssetsModule, NestvexaAssetsService } from 'nestvexa/assets';
import {
  LiveModule,
  LiveRuntime,
  LiveComponent,
  State,
  Computed,
  Action,
} from '@nestvexa/live';
import { fileURLToPath } from 'node:url';
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
const renderer = new HbsEngine({
  root,
  helpers: { eq: (left, right) => left === right },
});

@LiveComponent({ name: 'counter', view: 'counter' })
class Counter {
  @State() count = 0;
  @State({ writable: true }) name = '';
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 30,
  })
  search = '';
  @State({ writable: true }) nickname = '';
  @State({ writable: true }) quantity = 1;
  @State({ writable: true }) enabled = false;
  @State({
    writable: true,
    validate: (value) =>
      typeof value === 'string' && ['red', 'blue', 'green'].includes(value),
  })
  color = 'red';
  @State() allowGreen = false;
  @State() nativeNote = 'Server default';
  @State() nativeMemo = 'Server memo';
  @State() nativeChoice = 'low';
  @State() nativeReset = false;
  @State() nativeReverse = false;
  @Action() reorderNativeOptions(): void {
    this.nativeReverse = !this.nativeReverse;
  }
  @Action() resetNativeDefaults(): void {
    this.nativeNote = 'New server default';
    this.nativeMemo = 'New server memo';
    this.nativeChoice = 'high';
    this.nativeReset = true;
  }
  @Action() enableColorChoice(): void {
    this.allowGreen = true;
    this.color = 'green';
  }
  @State() saved = '';
  @State() visible = true;
  @State() healthLink = '/api/health';
  @State() numericControl = false;
  @Action() toggleInputType(): void {
    this.numericControl = !this.numericControl;
  }
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
    return { widget: await this.live.mount(Counter, request) };
  }
  @Get('api/health') health() {
    return { status: 'ok' };
  }
  @Get('assets/example.css')
  @Header('Content-Type', 'text/css; charset=utf-8')
  stylesheet() {
    return 'body{font-family:system-ui,sans-serif;line-height:1.6;margin:2rem;max-width:60rem}button,input{font:inherit;min-height:2.75rem;box-sizing:border-box}button{padding:.4rem .8rem;margin:.25rem}input{padding:.4rem;margin:.25rem}form{margin-block:1rem}output{font-variant-numeric:tabular-nums}.working,.queued{font-weight:700;text-decoration:underline}';
  }
  @Get('assets/boot.js')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  boot() {
    const { entries } = this.assets.getManifest();
    return `import {createLiveClient} from ${JSON.stringify(entries.live)};
import Alpine from ${JSON.stringify(entries.alpine)};
import {installLiveAlpine} from ${JSON.stringify(entries.alpineAdapter)};
const client = createLiveClient({onError(error) {document.getElementById('status').textContent = error.message;}});
client.mount(); client.mount();
installLiveAlpine(Alpine, client); installLiveAlpine(Alpine, client);
Alpine.data('localCounter', () => ({clicks: 0, incrementLocal() {this.clicks++}, incrementServer() {return this.$live.call('increment')}, renameServer() {this.$live.set('name', 'From Alpine'); return this.$live.call('save')}}));
Alpine.start();
window.addEventListener('pagehide', () => client.dispose());
document.addEventListener('nestvexa:updated', () => {document.getElementById('status').textContent = 'Updated';});`;
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
          '$sync',
          'increment',
          'decrement',
          'save',
          'slow',
          'toggleVisible',
          'toggleInputType',
          'reorderNativeOptions',
          'resetNativeDefaults',
          'enableColorChoice',
        ].includes(action),
    }),
  ],
  controllers: [PageController],
  providers: [LiveRendererLifecycle],
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
