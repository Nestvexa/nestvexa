import 'reflect-metadata';
import {
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
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  Action,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  State,
} from '@nestvexa/live';
import { ViewEngineRegistry } from '@nestvexa/views';
import { NestvexaAssetsModule, NestvexaAssetsService } from 'nestvexa/assets';
import session from 'express-session';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TokenEngine } from './engine.js';

declare module 'express-session' {
  interface SessionData {
    csrf?: string;
  }
}
interface SessionRequest {
  session: session.Session & Partial<session.SessionData>;
  sessionID: string;
}

const port = Number(process.env['PORT'] ?? 3103);
const root = fileURLToPath(new URL('../views', import.meta.url));
const renderer = new TokenEngine({
  root,
  cache: process.env['NODE_ENV'] === 'production',
  defaultLayout: 'layout',
});

// Startup capability gate: fail before listening, naming every missing flag
// and the flags the adapter does declare, instead of failing on first render.
const views = new ViewEngineRegistry();
views.register(renderer);
views.requireAll('tokens', ['layouts', 'slots', 'safeHtml']);

@LiveComponent({ name: 'counter', view: 'counter' })
class Counter {
  @State() count = 0;
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 40,
  })
  note = '';
  @Action() increment(): void {
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
  @Render('home')
  async home(@Req() request: SessionRequest) {
    request.session.csrf ??= randomBytes(32).toString('base64url');
    return {
      title: 'Custom engine <tokens>',
      intro: 'Rendered by a third-party ViewEngineAdapter.',
      widget: await this.live.mount(Counter, request),
    };
  }
  @Get('assets/boot.js')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  boot() {
    const { entries } = this.assets.getManifest();
    return `import {createLiveClient} from ${JSON.stringify(entries.live)};
const client = createLiveClient();
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
        ['$mount', '$sync', 'increment'].includes(action),
    }),
  ],
  controllers: [PageController],
  providers: [RendererLifecycle],
})
class AppModule {}

const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  logger: ['error', 'warn'],
});
// Local demonstration only: production requires a persistent session store and deployment secret.
app.use(
  session({
    secret: randomBytes(48).toString('base64url'),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'strict', secure: false },
  }),
);
// MVC bridge: Nest's @Render resolves `<root>/<view>.tok` through the adapter.
app.engine(
  'tok',
  (
    filename: string,
    options: Record<string, unknown>,
    callback: (error: Error | null, html?: string) => void,
  ) => renderer.renderFile(filename, options, callback),
);
app.setBaseViewsDir(root);
app.setViewEngine('tok');
app.enableShutdownHooks();
await app.listen(port, '127.0.0.1');
console.log(`Custom engine example: ${await app.getUrl()}`);
