import 'reflect-metadata';
import {
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Module,
  Post,
  Render,
  Req,
  Res,
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
  consumeLiveFlash,
  createTextStreamResponse,
  parseTextStreamRequest,
} from 'nestvexa';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import session from 'express-session';
import { WorkBoard } from './work-board.js';
import { StartupPanel, DeniedStartupPanel } from './startup-panel.js';
import { ActivityPanel } from './activity-panel.js';
import {
  TeamBoard,
  TeamMember,
  TeamRolePicker,
  TeamStats,
} from './team-board.js';
import {
  ProjectBoard,
  ProjectRow,
  ProjectsModule,
  ProjectToast,
} from './projects.js';
import { RealtimeModule, RealtimeService } from '@nestvexa/realtime';
import {
  RealtimeBoard,
  RealtimeDemoModule,
  connectReportJobs,
  guestBinding,
  publicChannel,
  reportJobs,
} from './realtime-board.js';

declare module 'express-session' {
  interface SessionData {
    csrf?: string;
  }
}
interface SessionRequest {
  session: session.Session & Partial<session.SessionData>;
  sessionID: string;
  body?: unknown;
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
  @Get('realtime')
  @Header('Cache-Control', 'no-store')
  @Header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  )
  @Render('projects')
  async realtime(@Req() request: SessionRequest) {
    request.session.csrf ??= randomBytes(32).toString('base64url');
    return {
      title: 'Realtime activity',
      flash: [],
      widget: await this.live.mount(RealtimeBoard, request),
    };
  }
  @Get('projects')
  @Header('Cache-Control', 'no-store')
  @Header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  )
  @Render('projects')
  async projects(@Req() request: SessionRequest) {
    request.session.csrf ??= randomBytes(32).toString('base64url');
    return {
      title: 'Projects',
      flash: consumeLiveFlash(request),
      widget: await this.live.mount(ProjectBoard, request),
    };
  }
  @Get('team')
  @Header('Cache-Control', 'no-store')
  @Header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  )
  @Render('home')
  async team(@Req() request: SessionRequest) {
    request.session.csrf ??= randomBytes(32).toString('base64url');
    return {
      title: 'Team board',
      widget: await this.live.mount(TeamBoard, request),
    };
  }
  @Get('about')
  @Render('about')
  about() {
    return { title: 'About this starter' };
  }
  @Get('init')
  @Header('Cache-Control', 'no-store')
  @Header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  )
  @Render('home')
  async startup(@Req() request: SessionRequest) {
    request.session.csrf ??= randomBytes(32).toString('base64url');
    return {
      title: 'Automatic startup panel',
      widget: await this.live.mount(StartupPanel, request),
    };
  }
  @Get('init/denied')
  @Header('Cache-Control', 'no-store')
  @Header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  )
  @Render('home')
  async deniedStartup(@Req() request: SessionRequest) {
    request.session.csrf ??= randomBytes(32).toString('base64url');
    return {
      title: 'Denied startup action',
      widget: await this.live.mount(DeniedStartupPanel, request),
    };
  }
  @Get('api/health')
  health() {
    return { status: 'ok' };
  }
  @Get('activity.css')
  @Header('Content-Type', 'text/css; charset=utf-8')
  activityStyles() {
    return '.activity-fade{transition:opacity .15s ease}.activity-fade-start{opacity:0}.activity-fade-end{opacity:1}.active{font-weight:bold}@media(prefers-reduced-motion:reduce){.activity-fade{transition:none}}';
  }
  @Get('activity')
  @Header('Cache-Control', 'no-store')
  @Header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  )
  @Render('home')
  async activity(@Req() request: SessionRequest) {
    request.session.csrf ??= randomBytes(32).toString('base64url');
    return {
      title: 'Activity preferences',
      activityClient: true,
      widget: await this.live.mount(ActivityPanel, request),
    };
  }
  @Post('activity-stream')
  @HttpCode(200)
  async activityStream(
    @Req() request: SessionRequest,
    @Res({ passthrough: true }) response: object,
  ) {
    const input = parseTextStreamRequest(request.body);
    const authorization = await this.live.authorizeStream(
      request,
      ActivityPanel,
      'summary',
      { snapshot: input.snapshot, revision: input.revision },
    );
    return createTextStreamResponse({
      request,
      response,
      authorization,
      produce: async function* ({ signal, state }) {
        yield `Activity query: ${String(state['query'])}\n`;
        await delay(75, undefined, { signal });
        yield 'Public demonstration summary — مرحباً\n';
        await delay(75, undefined, { signal });
        yield '<script>This is literal text, never HTML.</script>';
      },
    });
  }
  @Get('activity-client.js')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  activityClient(): string {
    return `import {app} from '/_nestvexa/boot.js';
document.addEventListener('click', async (event) => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest('#activity-stream-start, #activity-stream-cancel');
  const target = document.getElementById('activity-summary');
  const status = document.getElementById('activity-stream-status');
  if (!(button instanceof HTMLButtonElement) || !target || !status) return;
  if (button.id === 'activity-stream-cancel') { app.client.cancelStream(target); return; }
  button.disabled = true;
  status.textContent = 'Reading summary';
  try { await app.client.startStream(target); status.textContent = 'Summary complete'; }
  catch { status.textContent = 'Summary stopped. Start again to request a fresh read.'; }
  finally { if (button.isConnected) button.disabled = false; }
});`;
  }
}

@Module({
  imports: [
    RealtimeModule.forRoot({
      secrets: [randomBytes(48).toString('base64url')],
      origin: `http://127.0.0.1:${port}`,
      resolveIdentity: (request) => ({ binding: guestBinding(request) }),
      authorizeChannel: (identity, channel) =>
        channel === publicChannel || reportJobs.authorize(identity, channel),
    }),
    NestvexaModule.forRoot(
      { views: { root, layout: 'layout' }, live: { enabled: true } },
      {
        browser: {
          streams: { summary: { endpoint: '/activity-stream' } },
          realtime: { endpoint: '/_nestvexa/realtime' },
        },
        components: [
          Counter,
          WorkBoard,
          StartupPanel,
          DeniedStartupPanel,
          ActivityPanel,
          TeamBoard,
          TeamMember,
          TeamRolePicker,
          TeamStats,
          ProjectBoard,
          ProjectRow,
          ProjectToast,
          RealtimeBoard,
        ],
        imports: [ProjectsModule, RealtimeDemoModule],
        inject: [RealtimeService],
        useFactory: (realtime: RealtimeService) => ({
          origin: `http://127.0.0.1:${port}`,
          realtime,
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
            (component === 'activity-panel' &&
              [
                '$mount',
                '$sync',
                'remember',
                'like',
                'refresh',
                'appear',
                'toggle',
                'reorder',
                '$stream:summary',
              ].includes(action)) ||
            (component === 'realtime-board' &&
              [
                '$mount',
                '$sync',
                'post',
                'startReport',
                'cancelReport',
              ].includes(action)) ||
            (component === 'project-board' &&
              [
                '$mount',
                '$sync',
                'sortByName',
                'sortByStatus',
                'search',
                'create',
                'removed',
                'exportCsv',
                'archiveDone',
              ].includes(action)) ||
            (component === 'project-row' &&
              ['$mount', 'toggleStar', 'remove'].includes(action)) ||
            (component === 'project-toast' &&
              ['$mount', 'show'].includes(action)) ||
            (component === 'team-board' &&
              [
                '$mount',
                '$sync',
                'renameGrace',
                'memberLeft',
                'finish',
              ].includes(action)) ||
            (component === 'team-member' &&
              ['$mount', 'thank', 'leave'].includes(action)) ||
            (component === 'team-role-picker' &&
              ['$mount', 'chooseEditor', 'chooseOwner'].includes(action)) ||
            (component === 'team-stats' &&
              ['$mount', '$sync'].includes(action)) ||
            (component === 'startup-panel' &&
              ['$mount', 'load', 'refresh'].includes(action)) ||
            (component === 'startup-denied' &&
              ['$mount', 'refresh'].includes(action)) ||
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
connectReportJobs(app.get(RealtimeService));
app.enableShutdownHooks();
await app.listen(port, '127.0.0.1');
console.log(`Default Live starter: ${await app.getUrl()}`);
