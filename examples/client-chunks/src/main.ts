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
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  Action,
  ActionInput,
  LiveComponent,
  LiveRuntime,
  NestvexaModule,
  State,
  configureNestvexa,
} from 'nestvexa';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import session from 'express-session';

// On-demand Live client chunks (ADR 0036) behind the canonical boot.js, a
// nonce-only script policy (no 'self', no 'strict-dynamic') and an import map
// pinning every client module to its SRI digest. `/` needs only the core
// entry; `/board` uses nv:sort, so the browser fetches live-sort.js when the
// board is discovered.

declare module 'express-session' {
  interface SessionData {
    csrf?: string;
  }
}
interface SessionRequest {
  session: session.Session & Partial<session.SessionData>;
  sessionID: string;
}
const port = Number(process.env['PORT'] ?? 3880);
const root = fileURLToPath(new URL('../views', import.meta.url));
const nonces = new WeakMap<object, string>();
function policy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');
}

@LiveComponent({ name: 'chunk-counter', view: 'counter' })
class ChunkCounter {
  @State() count = 0;
  @Action() increment(): void {
    this.count++;
  }
}

const titles: Readonly<Record<string, string>> = {
  docs: 'Write the guide',
  tests: 'Add browser tests',
  audit: 'Security review',
  ship: 'Publish the release',
};
const photos = ['dunes', 'harbor', 'forest', 'glacier', 'canyon', 'meadow'];

/** Connected `todo`/`done` columns and a photo grid; the server owns every order. */
@LiveComponent({ name: 'chunk-board', view: 'board' })
class ChunkBoard {
  @State() todo = ['docs', 'tests', 'audit'];
  @State() done = ['ship'];
  @State() photos = [...photos];
  @State() titles = { ...titles };
  @Action() move(@ActionInput() input: unknown): void {
    // `{ item, lists }`: the moved item and the new order of each list it
    // touched. Accept only a permutation of the authoritative items.
    const lists: unknown =
      input && typeof input === 'object' ? Reflect.get(input, 'lists') : null;
    const item: unknown =
      input && typeof input === 'object' ? Reflect.get(input, 'item') : null;
    if (
      !input ||
      typeof input !== 'object' ||
      Object.keys(input).length !== 2 ||
      typeof item !== 'string' ||
      !lists ||
      typeof lists !== 'object' ||
      Array.isArray(lists)
    )
      throw new BadRequestException('Unknown move');
    const next: Record<'todo' | 'done', string[]> = {
      todo: [...this.todo],
      done: [...this.done],
    };
    const keys = Object.keys(lists);
    if (!keys.length || keys.length > 2) throw new BadRequestException();
    for (const key of keys) {
      const ids: unknown = Reflect.get(lists, key);
      if (
        (key !== 'todo' && key !== 'done') ||
        !Array.isArray(ids) ||
        ids.some((id) => typeof id !== 'string')
      )
        throw new BadRequestException('Unknown list');
      next[key] = ids.map(String);
    }
    const all = [...next.todo, ...next.done];
    const known = [...this.todo, ...this.done];
    if (
      all.length !== known.length ||
      new Set(all).size !== all.length ||
      !known.every((id) => all.includes(id)) ||
      !all.includes(item)
    )
      throw new BadRequestException('Unknown order');
    this.todo = next.todo;
    this.done = next.done;
  }
  @Action() arrange(@ActionInput() input: unknown): void {
    const ids: unknown =
      input && typeof input === 'object' ? Reflect.get(input, 'ids') : null;
    if (
      !Array.isArray(ids) ||
      ids.length !== this.photos.length ||
      [...ids].sort().join() !== [...this.photos].sort().join()
    )
      throw new BadRequestException('Unknown order');
    this.photos = ids.map(String);
  }
}

@Controller()
class PageController {
  constructor(@Inject(LiveRuntime) private readonly live: LiveRuntime) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Render('index')
  async index(@Req() request: SessionRequest) {
    request.session.csrf ??= randomBytes(32).toString('base64url');
    return {
      title: 'Core only',
      cspNonce: nonces.get(request),
      widget: await this.live.mount(ChunkCounter, request),
    };
  }
  @Get('board')
  @Header('Cache-Control', 'no-store')
  @Render('board-page')
  async board(@Req() request: SessionRequest) {
    request.session.csrf ??= randomBytes(32).toString('base64url');
    return {
      title: 'Sortable board',
      cspNonce: nonces.get(request),
      widget: await this.live.mount(ChunkBoard, request),
    };
  }
  @Get('api/health') health() {
    return { status: 'ok' };
  }
  @Get('assets/chunks.css')
  @Header('Content-Type', 'text/css; charset=utf-8')
  stylesheet() {
    return 'body{font-family:system-ui,sans-serif;line-height:1.5;margin:2rem;max-width:60rem}button{font:inherit;min-height:2.75rem;margin:.25rem}.columns{display:flex;gap:2rem}.columns ol{min-height:8rem;min-width:14rem;padding:.5rem 1.5rem;border:1px solid #888}.grid{display:grid;grid-template-columns:repeat(3,10rem);gap:.5rem;list-style:none;padding:0}.grid li{border:1px solid #888;padding:.5rem}';
  }
}

@Module({
  imports: [
    NestvexaModule.forRoot(
      { views: { root, layout: 'layout' }, live: { enabled: true } },
      {
        components: [ChunkCounter, ChunkBoard],
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
            (component === 'chunk-counter' &&
              ['$mount', 'increment'].includes(action)) ||
            (component === 'chunk-board' &&
              ['$mount', 'move', 'arrange'].includes(action)),
        }),
      },
    ),
  ],
  controllers: [PageController],
})
class AppModule {}

const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  logger: ['error', 'warn'],
});
// A fresh nonce per document; pages render it on the boot script and import map.
app.use(
  (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const nonce = randomBytes(16).toString('base64');
    nonces.set(request, nonce);
    response.setHeader('Content-Security-Policy', policy(nonce));
    next();
  },
);
// Local demonstration only: production requires a persistent session store and deployment secret.
app.use(
  session({
    secret: randomBytes(48).toString('base64url'),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'strict', secure: false },
  }),
);
await configureNestvexa(app);
app.enableShutdownHooks();
await app.listen(port, '127.0.0.1');
console.log(`Client chunks example: http://127.0.0.1:${port}`);
