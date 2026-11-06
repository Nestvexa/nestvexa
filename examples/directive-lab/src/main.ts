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
  Action,
  ActionInput,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  State,
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
const port = Number(process.env['PORT'] ?? 3360);
const root = fileURLToPath(new URL('../views', import.meta.url));
const renderer = new HbsEngine({ root });
/**
 * Strict policy: same-origin scripts/styles only, no eval and enforced Trusted
 * Types. The Live client routes server HTML through its `nestvexa` policy.
 */
const policy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "require-trusted-types-for 'script'",
  'trusted-types nestvexa',
].join('; ');

/** One component exercising directive combinations against a real server. */
@LiveComponent({ name: 'lab', view: 'lab' })
class DirectiveLab {
  @State() count = 0;
  @State() hotkeys = 0;
  @State() message = 'Ready';
  @State() open = true;
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 40,
  })
  query = '';
  @State({
    writable: true,
    validate: (value) =>
      typeof value === 'number' && Number.isInteger(value) && value >= 0,
  })
  quantity = 1;
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 80,
  })
  email = '';
  @State() saved = '';
  /** Only city and zip are client-writable; `verified` is server-owned. */
  @State({
    writable: ['city', 'zip'],
    validate: (value) =>
      !!value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof value['city'] === 'string' &&
      value['city'].length <= 40,
  })
  address = { city: 'Cairo', zip: '11511', verified: false };
  /** A checkbox group: the server validates count and allowlist. */
  @State({
    writable: true,
    validate: (value) =>
      Array.isArray(value) &&
      value.length <= 3 &&
      value.every(
        (topic) =>
          typeof topic === 'string' && ['news', 'tips', 'beta'].includes(topic),
      ),
  })
  topics: string[] = ['news'];
  @State() balance = 0;
  @State() order = ['alpha', 'beta', 'gamma'];
  @Action() saveProfile(): void {
    this.message = `Profile ${this.address.city} ${this.topics.join('+')}`;
  }
  /** Idempotent: an identical browser retry replays the committed result. */
  @Action({ idempotent: true }) deposit(): void {
    this.balance += 10;
  }
  @Action() reorder(@ActionInput() input: unknown): void {
    const ids: unknown =
      input && typeof input === 'object' ? Reflect.get(input, 'ids') : null;
    if (
      !Array.isArray(ids) ||
      ids.length !== this.order.length ||
      [...ids].sort().join() !== [...this.order].sort().join()
    )
      throw new BadRequestException('Unknown order');
    this.order = ids.map(String);
  }
  @Action() increment(): void {
    this.count++;
  }
  @Action() hotkey(): void {
    this.hotkeys++;
  }
  @Action() async slow(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 450));
    this.count++;
  }
  @Action() save(): void {
    this.saved = this.email;
    this.message = `Saved ${this.email}`;
  }
  @Action() remove(): void {
    this.message = 'Removed';
  }
  @Action() toggle(): void {
    this.open = !this.open;
  }
  @Action() crash(): void {
    throw new Error('Unexpected failure for the demonstration');
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
  @Header('Content-Security-Policy', policy)
  @Render('page')
  async page(@Req() request: SessionRequest) {
    request.session.csrf ??= randomBytes(32).toString('base64url');
    return { widget: await this.live.mount(DirectiveLab, request) };
  }
  @Get('about')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', policy)
  @Render('about')
  about() {
    return {};
  }
  @Get('api/health') health() {
    return { status: 'ok' };
  }
  @Get('assets/lab.css')
  @Header('Content-Type', 'text/css; charset=utf-8')
  stylesheet() {
    return '[nv\\:cloak]{display:none}body{font-family:system-ui,sans-serif;line-height:1.5;margin:2rem;max-width:60rem}button,input{font:inherit;min-height:2.75rem;margin:.25rem}.busy{outline:2px dashed}.fade{transition:opacity .3s ease}.faded{opacity:0}';
  }
  @Get('assets/lab.js')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  boot() {
    const { entries } = this.assets.getManifest();
    return `import {createLiveClient} from ${JSON.stringify(entries.live)};
window.nvViolations = [];
document.addEventListener('securitypolicyviolation', (event) => window.nvViolations.push(event.violatedDirective));
const client = createLiveClient({onError(error) {const status = document.getElementById('error'); if (status) status.textContent = 'Error: ' + (error.code ?? 'UNKNOWN');}});
client.mount();
window.addEventListener('pagehide', () => client.dispose());`;
  }
}

class RendererLifecycle {
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
      components: [DirectiveLab],
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
        component === 'lab' &&
        [
          '$mount',
          '$sync',
          'increment',
          'hotkey',
          'slow',
          'save',
          'remove',
          'toggle',
          'crash',
          'saveProfile',
          'deposit',
          'reorder',
        ].includes(action),
    }),
  ],
  controllers: [PageController],
  providers: [RendererLifecycle],
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
console.log(`Directive lab: ${await app.getUrl()}`);
