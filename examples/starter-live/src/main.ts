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
import {
  Action,
  Computed,
  LiveComponent,
  LiveRuntime,
  NestvexaModule,
  State,
  configureNestvexa,
} from 'nestvexa';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
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
const port = Number(process.env['PORT'] ?? 3102);
const root = fileURLToPath(new URL('../views', import.meta.url));

@LiveComponent({ name: 'counter', view: 'counter' })
class Counter {
  @State() count = 0;
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 80,
  })
  name = '';
  @State() saved = '';
  @State() editorDisabled = false;
  @State() editorHidden = false;
  @State({ writable: true, validate: (value) => typeof value === 'boolean' })
  panelVisible = true;
  @Computed() get doubled(): number {
    return this.count * 2;
  }
  @Action() increment(): void {
    this.count++;
  }
  @Action() save(): void {
    this.saved = this.name;
  }
  @Action() disableEditor(): void {
    this.editorDisabled = true;
  }
  @Action() hideEditor(): void {
    this.editorHidden = true;
  }
  @Action() hidePanel(): void {
    this.panelVisible = false;
  }
  @Action() async slowPanel(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
}

@Controller()
class Pages {
  constructor(@Inject(LiveRuntime) private readonly live: LiveRuntime) {}
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
      title: 'Nestvexa default Live setup',
      widget: await this.live.mount(Counter, request),
    };
  }
  @Get('about')
  @Render('about')
  about() {
    return { title: 'About this starter' };
  }
  @Get('api/health')
  health() {
    return { status: 'ok' };
  }
}

@Module({
  imports: [
    NestvexaModule.forRoot(
      { views: { root, layout: 'layout' }, live: { enabled: true } },
      {
        components: [Counter],
        useFactory: () => ({
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
              'save',
              'disableEditor',
              'hideEditor',
              'hidePanel',
              'slowPanel',
            ].includes(action),
        }),
      },
    ),
  ],
  controllers: [Pages],
})
class AppModule {}

const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
// Local guest demonstration: production hosts supply authentication, a persistent
// session store, a deployment secret, HTTPS cookies, and resource-level policies.
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
console.log(`Default Live starter: ${await app.getUrl()}`);
