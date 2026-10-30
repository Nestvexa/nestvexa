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
import { WorkBoard } from './work-board.js';

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
  @State() editorFirst = false;
  @State({
    writable: true,
    validate: (value) =>
      Array.isArray(value) &&
      value.length <= 3 &&
      new Set(value).size === value.length &&
      value.every(
        (item) =>
          typeof item === 'string' &&
          ['design', 'build', 'review'].includes(item),
      ),
  })
  interests = ['design'];
  @State() savedInterests: string[] = [];
  @Computed() get interestOptions() {
    return ['design', 'build', 'review'].map((value) => ({
      value,
      selected: this.interests.includes(value),
    }));
  }
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
  @Action() reorderEditor(): void {
    this.editorFirst = !this.editorFirst;
  }
  @Action() saveInterests(): void {
    this.savedInterests = [...this.interests];
  }
  @Action() async slowInterests(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    this.savedInterests = [...this.interests];
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
  @Get('board')
  @Header('Cache-Control', 'no-store')
  @Header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  )
  @Render('home')
  async board(@Req() request: SessionRequest) {
    request.session.csrf ??= randomBytes(32).toString('base64url');
    return {
      title: 'Work board',
      widget: await this.live.mount(WorkBoard, request),
    };
  }
  // Host composition fixture; the client tests move the second independent root
  // into the board's explicitly ignored slot. No parent/child server API is implied.
  @Get('board/ownership')
  @Header('Cache-Control', 'no-store')
  @Header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  )
  @Render('home')
  async ownership(@Req() request: SessionRequest) {
    request.session.csrf ??= randomBytes(32).toString('base64url');
    return {
      title: 'Independent component ownership',
      widget: await this.live.mount(WorkBoard, request),
      secondary: await this.live.mount(Counter, request),
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
        components: [Counter, WorkBoard],
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
            (component === 'work-board' &&
              ['$mount', '$sync', 'sort', 'add', 'removeFirst'].includes(
                action,
              )) ||
            (component === 'counter' &&
              [
                '$mount',
                '$sync',
                'increment',
                'save',
                'disableEditor',
                'hideEditor',
                'reorderEditor',
                'saveInterests',
                'slowInterests',
                'hidePanel',
                'slowPanel',
              ].includes(action)),
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
