import 'reflect-metadata';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Req,
} from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  InertiaModule,
  InertiaPage,
  InertiaService,
  InertiaValidationException,
  defer,
  optional,
  redirect,
} from '@nestvexa/inertia';
import type { InertiaProp, InertiaSsrRenderer } from '@nestvexa/inertia';
import {
  ViteAssets,
  createViteDevServer,
  cspNonce,
  cspNonceMiddleware,
  moduleSsrRenderer,
  viteInertiaRootView,
  viteStaticMiddleware,
} from '@nestvexa/vite';
import type { SsrRenderer } from '@nestvexa/vite';
import session from 'express-session';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ActionsPageController, NotesModule, noteActions } from './actions.js';
import { DocumentsController, documentUploads } from './documents.js';
import { FeaturesController } from './features.js';
import type { AppPages, User } from './page-types.js';

declare module 'express-session' {
  interface SessionData {
    xsrf?: string;
    visits?: number;
    assetVersion?: string;
  }
}

type SessionRequest = {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  session: session.Session & Partial<session.SessionData>;
};

/** Server-side page props: values, lazy callbacks or Inertia prop helpers. */
type ServerProps<T> = {
  readonly [K in keyof T]-?: T[K] | (() => T[K]) | InertiaProp;
};

const framework = 'Vue';
const root = fileURLToPath(new URL('..', import.meta.url));
const dev = process.argv.includes('--dev');
const testControls = process.argv.includes('--test-controls');
// Client-only mode: no SSR at all; the client mounts into an empty root.
const clientOnly = process.argv.includes('--client-only');
const port = Number(process.env['PORT'] ?? 3107);
/** The browser origin that upload and action requests must send. */
const origin = process.env['ORIGIN'] ?? `http://127.0.0.1:${port}`;
const logger = new Logger(`Inertia${framework}Example`);
// The SSR bundle is imported lazily on the first render, so this selects the
// production builds of the framework runtime it loads (it externalizes them).
process.env['NODE_ENV'] ??= dev ? 'development' : 'production';

const assets = new ViteAssets({
  mode: dev ? 'development' : 'production',
  apps: {
    vue: {
      entries: ['client/app.ts'],
      base: '/build/',
      manifest: join(root, 'dist/client/.vite/manifest.json'),
    },
  },
});

// SSR runs in-process: production imports the built SSR bundle once
// (dist/ssr/ssr.js); development loads client/ssr.ts through Vite.
let devRenderer: SsrRenderer | undefined;
const renderer: InertiaSsrRenderer = dev
  ? {
      render: (page, json) => {
        if (!devRenderer) throw new Error('Vite dev server is not ready');
        return devRenderer.render(page, json);
      },
    }
  : moduleSsrRenderer(join(root, 'dist/ssr/ssr.js'), { timeoutMs: 3000 });

const users: User[] = [
  { id: 1, name: 'Ada Lovelace', email: 'ada@example.test' },
  { id: 2, name: 'Grace Hopper', email: 'grace@example.test' },
];

/**
 * Host-owned CSRF protection for the official Inertia client: a per-session
 * token mirrored into the readable `XSRF-TOKEN` cookie, which `@inertiajs/core`
 * echoes in `X-XSRF-TOKEN`.
 */
@Injectable()
class XsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<SessionRequest>();
    const response = http.getResponse<{
      cookie(name: string, value: string, options: object): void;
    }>();
    request.session.xsrf ??= randomBytes(32).toString('base64url');
    const token = request.session.xsrf;
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      response.cookie('XSRF-TOKEN', token, { sameSite: 'lax', path: '/' });
      return true;
    }
    // The official client echoes XSRF-TOKEN in X-XSRF-TOKEN; the
    // @nestvexa/uploads browser client sends the same token as x-nestvexa-csrf.
    const sent =
      request.headers['x-xsrf-token'] ?? request.headers['x-nestvexa-csrf'];
    const actual = Buffer.from(
      typeof sent === 'string' ? decodeURIComponent(sent) : '',
    );
    const expected = Buffer.from(token);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new ForbiddenException('CSRF token mismatch');
    return true;
  }
}

function field(body: unknown, name: string): string {
  const value =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)[name]
      : undefined;
  return typeof value === 'string' ? value.trim() : '';
}

function validateUser(body: unknown): { name: string; email: string } {
  const name = field(body, 'name');
  const email = field(body, 'email');
  const errors: Record<string, string> = {};
  if (!name) errors['name'] = 'The name field is required.';
  else if (name.length > 40)
    errors['name'] = 'The name may not be greater than 40 characters.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    errors['email'] = 'The email must be a valid email address.';
  if (Object.keys(errors).length) throw new InertiaValidationException(errors);
  return { name, email };
}

@Controller()
class PagesController {
  constructor(
    @Inject(InertiaService) private readonly inertia: InertiaService,
  ) {}

  @Get()
  @InertiaPage('Home')
  home(@Req() request: SessionRequest): ServerProps<AppPages['Home']> {
    request.session.visits = (request.session.visits ?? 0) + 1;
    return {
      greeting: `Welcome to Nestvexa + ${framework}`,
      visits: request.session.visits,
      renderedBy: 'Nest controller',
      stats: defer(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { users: users.length };
      }),
      extra: optional(
        () => `Loaded by a partial reload at visit ${request.session.visits}`,
      ),
    };
  }

  @Get('users')
  @InertiaPage('Users/Index')
  index(): ServerProps<AppPages['Users/Index']> {
    return { users: () => users.map((user) => ({ ...user })) };
  }

  @Get('users/create')
  @InertiaPage('Users/Create')
  create(): ServerProps<AppPages['Users/Create']> {
    return {};
  }

  @Get('users/:id')
  @InertiaPage('Users/Show')
  show(
    @Param('id', ParseIntPipe) id: number,
  ): ServerProps<AppPages['Users/Show']> {
    const user = users.find((candidate) => candidate.id === id);
    if (!user) throw new NotFoundException();
    return { user: { ...user } };
  }

  @Post('users')
  store(@Req() request: SessionRequest, @Body() body: unknown) {
    const { name, email } = validateUser(body);
    users.push({ id: users.length + 1, name, email });
    this.inertia.flash(request, 'success', `User ${name} created`);
    return redirect('/users');
  }

  /** Renders a page component that throws: SSR fails, the client boundary shows a fallback. */
  @Get('broken')
  @InertiaPage('Broken')
  broken(): ServerProps<AppPages['Broken']> {
    return { reason: 'This page throws while rendering on purpose.' };
  }

  /** Test-only control: bumps this session's asset version (enabled with --test-controls). */
  @Post('__test/version')
  bump(@Req() request: SessionRequest) {
    if (!testControls) throw new NotFoundException();
    request.session.assetVersion = `bumped-${randomBytes(4).toString('hex')}`;
    return { ok: true };
  }
}

@Module({
  imports: [
    documentUploads(origin),
    noteActions(origin),
    NotesModule,
    InertiaModule.forRoot({
      version: (request) =>
        (request as SessionRequest).session.assetVersion ??
        assets.version('vue'),
      title: (page) => `${page.component} · Nestvexa ${framework}`,
      rootView: viteInertiaRootView(assets, { app: 'vue' }),
      nonce: (request) => cspNonce(request),
      share: () => ({ appName: 'Nestvexa Inertia', framework }),
      ...(clientOnly
        ? {}
        : {
            ssr: {
              renderer,
              mode: 'fallback' as const,
              onError: (error: unknown) =>
                logger.warn(
                  `SSR failed: ${error instanceof Error ? error.message : 'unknown error'}`,
                ),
            },
          }),
    }),
  ],
  controllers: [
    PagesController,
    FeaturesController,
    DocumentsController,
    ActionsPageController,
  ],
  providers: [{ provide: APP_GUARD, useClass: XsrfGuard }],
})
class AppModule {}

const app = await NestFactory.create<NestExpressApplication>(AppModule);
app.use(cspNonceMiddleware());
if (dev) {
  const vite = await createViteDevServer({
    root,
    hmrServer: app.getHttpServer(),
  });
  devRenderer = vite.ssrRenderer('/client/ssr.ts');
  app.use(vite.middlewares);
} else {
  app.use(
    viteStaticMiddleware({
      root: join(root, 'dist/client'),
      prefix: '/build/',
    }),
  );
}
app.use(
  session({
    secret: randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: true,
    cookie: { httpOnly: true, sameSite: 'lax' },
  }),
);
app.enableShutdownHooks();
await app.listen(port, '127.0.0.1');
logger.log(
  `${framework} example on http://127.0.0.1:${port} (${dev ? 'Vite dev' : 'production, in-process SSR'})`,
);
