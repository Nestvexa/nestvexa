import 'reflect-metadata';
import {
  Controller,
  Get,
  Header,
  Inject,
  Module,
  Redirect,
  Render,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { LiveRuntime, NestvexaModule, configureNestvexa } from 'nestvexa';
import session from 'express-session';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  TaskBoard,
  TaskEditor,
  TaskRepository,
  TaskRow,
  TasksModule,
  ownerOf,
} from './tasks.js';

declare module 'express-session' {
  interface SessionData {
    csrf?: string;
  }
}
interface SessionRequest {
  session: session.Session & Partial<session.SessionData>;
  sessionID: string;
}

const port = Number(process.env['PORT'] ?? 3115);
const origin = `http://127.0.0.1:${port}`;
const root = fileURLToPath(new URL('../views', import.meta.url));
const csp =
  "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** Host-owned dialog focus management (see public/dialog.js). */
const dialogScript = readFileSync(
  fileURLToPath(new URL('../public/dialog.js', import.meta.url)),
  'utf8',
);

@Controller()
class Pages {
  constructor(
    @Inject(LiveRuntime) private readonly live: LiveRuntime,
    @Inject(TaskRepository) private readonly tasks: TaskRepository,
  ) {}
  @Get()
  @Redirect('/tasks', 302)
  home(): void {}
  @Get('tasks')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('tasks')
  async board(@Req() request: SessionRequest) {
    request.session.csrf ??= randomBytes(32).toString('base64url');
    return {
      title: 'Tasks',
      widget: await this.live.mount(TaskBoard, request),
    };
  }
  /** Read-only JSON for the same per-session data, through ordinary Nest routing. */
  @Get('api/tasks')
  list(@Req() request: SessionRequest) {
    if (!request.session.csrf) throw new UnauthorizedException();
    return this.tasks.list(ownerOf(request));
  }
  @Get('api/health')
  health() {
    return { status: 'ok' };
  }
  @Get('assets/dialog.js')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  @Header('Cache-Control', 'no-cache')
  script(): string {
    return dialogScript;
  }
  @Get('assets/crud.css')
  @Header('Content-Type', 'text/css; charset=utf-8')
  @Header('Cache-Control', 'no-cache')
  stylesheet(): string {
    return [
      'body{font-family:system-ui,sans-serif;line-height:1.5;margin:0 auto;max-width:60rem;padding:1rem}',
      'button,input,select{font:inherit}button{min-height:2.5rem;padding:.25rem .75rem}input,select{min-height:2.5rem;padding:.25rem .5rem}',
      'table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #ccc;padding:.4rem;text-align:start;vertical-align:middle}',
      'th button{background:none;border:0;font-weight:700;padding:0;text-decoration:underline;cursor:pointer}',
      '.filters{display:flex;flex-wrap:wrap;gap:.75rem;align-items:end}.filters label{display:block}',
      '.done-yes{text-decoration:line-through;color:#3d3d3d}',
      '.backdrop{position:fixed;inset:0;background:rgb(0 0 0/.45);display:flex;align-items:center;justify-content:center;padding:1rem}',
      '.dialog{background:#fff;color:#111;border-radius:.5rem;max-width:32rem;width:100%;padding:1rem 1.25rem;box-shadow:0 10px 30px rgb(0 0 0/.3)}',
      '.dialog label{display:block;margin-top:.6rem}.dialog input,.dialog select{width:100%;box-sizing:border-box}',
      '[aria-invalid="true"]{outline:2px solid #b00020}.error{color:#b00020;margin:.2rem 0}',
      '.summary{border:2px solid #b00020;padding:.5rem .75rem;margin-bottom:.5rem}',
      '.notice{color:#0b6b2e;font-weight:600;min-height:1.5em}',
      'nav ul{list-style:none;display:flex;gap:.5rem;padding:0}',
    ].join('');
  }
}

@Module({
  imports: [
    TasksModule,
    NestvexaModule.forRoot(
      { views: { root, layout: 'layout' }, live: { enabled: true } },
      {
        components: [TaskBoard, TaskRow, TaskEditor],
        imports: [TasksModule],
        useFactory: () => ({
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
          // Every reachable action is listed; anything else is refused.
          authorize: (_identity, component, action) =>
            (component === 'task-board' &&
              [
                '$mount',
                '$sync',
                'sortTitle',
                'sortDue',
                'sortPriority',
                'applyFilters',
                'clearFilters',
                'newTask',
                'openEditor',
                'editorClosed',
                'saved',
                'removed',
                'changed',
              ].includes(action)) ||
            (component === 'task-row' &&
              ['$mount', 'toggleDone', 'edit', 'remove'].includes(action)) ||
            (component === 'task-editor' &&
              ['$mount', '$sync', 'save', 'cancel'].includes(action)),
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
console.log(`Live CRUD: ${await app.getUrl()}/tasks`);
