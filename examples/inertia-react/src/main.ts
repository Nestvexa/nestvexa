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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { FileInterceptor } from '@nestjs/platform-express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  HttpSsrGateway,
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
  viteInertiaRootView,
  viteStaticMiddleware,
} from '@nestvexa/vite';
import type { SsrRenderer } from '@nestvexa/vite';
import session from 'express-session';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FeaturesController } from './features.js';
import type { AppPages, Upload, User } from './page-types.js';

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

interface MultipartFile {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
}

const root = fileURLToPath(new URL('..', import.meta.url));
const dev = process.argv.includes('--dev');
const testControls = process.argv.includes('--test-controls');
// Client-only mode: no SSR at all; the client mounts into an empty root.
const clientOnly = process.argv.includes('--client-only');
const port = Number(process.env['PORT'] ?? 3106);
const ssrUrl = process.env['SSR_URL'] ?? 'http://127.0.0.1:13716';
const logger = new Logger('InertiaReactExample');

const assets = new ViteAssets({
  mode: dev ? 'development' : 'production',
  apps: {
    react: {
      entries: ['client/app.tsx'],
      base: '/build/',
      manifest: join(root, 'dist/client/.vite/manifest.json'),
    },
  },
});

// Production: the official SSR server process (`pnpm start:ssr`) behind the
// HTTP gateway. Development: Vite's ssrLoadModule inside this process.
let devRenderer: SsrRenderer | undefined;
const renderer: InertiaSsrRenderer = dev
  ? {
      render: (page, json) => {
        if (!devRenderer) throw new Error('Vite dev server is not ready');
        return devRenderer.render(page, json);
      },
    }
  : new HttpSsrGateway({ url: ssrUrl, timeoutMs: 3000 });

const users: User[] = [
  { id: 1, name: 'Ada Lovelace', email: 'ada@example.test' },
  { id: 2, name: 'Grace Hopper', email: 'grace@example.test' },
];
const uploads: Upload[] = [];

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
    const sent = request.headers['x-xsrf-token'];
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
      greeting: 'Welcome to Nestvexa + React',
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

  @Get('uploads')
  @InertiaPage('Files/Upload')
  uploadsPage(): ServerProps<AppPages['Files/Upload']> {
    return { uploads: () => uploads.map((upload) => ({ ...upload })) };
  }

  @Post('uploads')
  @UseInterceptors(
    FileInterceptor('document', {
      limits: { fileSize: 1024 * 1024, files: 1 },
    }),
  )
  upload(
    @Req() request: SessionRequest,
    @UploadedFile() file: MultipartFile | undefined,
  ) {
    if (!file)
      throw new InertiaValidationException({ document: 'Choose a file.' });
    if (!['text/plain', 'image/png'].includes(file.mimetype))
      throw new InertiaValidationException({
        document: 'Only plain text and PNG files are accepted.',
      });
    if (file.size > 64 * 1024)
      throw new InertiaValidationException({
        document: 'The file may not be larger than 64 KB.',
      });
    const name = file.originalname.replace(/[^\w.-]+/g, '_').slice(0, 80);
    uploads.unshift({ name, size: file.size, type: file.mimetype });
    this.inertia.flash(request, 'success', `Uploaded ${name}`);
    return redirect('/uploads');
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
    InertiaModule.forRoot({
      version: (request) =>
        (request as SessionRequest).session.assetVersion ??
        assets.version('react'),
      title: (page) => `${page.component} · Nestvexa React`,
      rootView: viteInertiaRootView(assets, { app: 'react' }),
      nonce: (request) => cspNonce(request),
      share: () => ({ appName: 'Nestvexa Inertia', framework: 'React' }),
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
  controllers: [PagesController, FeaturesController],
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
  devRenderer = vite.ssrRenderer('/client/ssr.tsx');
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
  `React example on http://127.0.0.1:${port} (${dev ? 'Vite dev' : clientOnly ? 'production, client-only' : `production, SSR ${ssrUrl}`})`,
);
