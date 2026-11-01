import 'reflect-metadata';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  Module,
  NotFoundException,
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
import session from 'express-session';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

declare module 'express-session' {
  interface SessionData {
    xsrf?: string;
    assetVersion?: string;
    visits?: number;
  }
}

type SessionRequest = {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  session: session.Session & Partial<session.SessionData>;
};

const port = Number(process.env['PORT'] ?? 3103);
const testControls = process.argv.includes('--test-controls');
const baseVersion = 'inertia-basic-1';
const users: { id: number; name: string }[] = [
  { id: 1, name: 'Ada Lovelace' },
  { id: 2, name: 'Grace Hopper' },
];

/**
 * Host-owned CSRF protection for the official Inertia client: a per-session
 * random token is mirrored into the readable `XSRF-TOKEN` cookie, which
 * `@inertiajs/core` echoes in `X-XSRF-TOKEN` on every request it makes.
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

function validateUser(body: unknown): string {
  const name =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)['name']
      : undefined;
  const value = typeof name === 'string' ? name.trim() : '';
  if (!value)
    throw new InertiaValidationException({
      name: 'The name field is required.',
    });
  if (value.length > 40)
    throw new InertiaValidationException({
      name: 'The name may not be greater than 40 characters.',
    });
  return value;
}

@Controller()
class PagesController {
  constructor(
    @Inject(InertiaService) private readonly inertia: InertiaService,
  ) {}

  @Get()
  @InertiaPage('Home')
  home(@Req() request: SessionRequest) {
    request.session.visits = (request.session.visits ?? 0) + 1;
    return {
      greeting: 'Welcome to Nestvexa Inertia',
      visits: request.session.visits,
      stats: defer(async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return { users: users.length };
      }),
      extra: optional(
        () =>
          `Loaded by a partial reload at visit ${request.session.visits ?? 0}`,
      ),
    };
  }

  @Get('users')
  @InertiaPage('Users/Index')
  index() {
    return { users: () => users.map((user) => ({ ...user })) };
  }

  @Get('users/create')
  @InertiaPage('Users/Create')
  create() {
    return {};
  }

  @Post('users')
  store(@Req() request: SessionRequest, @Body() body: unknown) {
    const name = validateUser(body);
    users.push({ id: users.length + 1, name });
    this.inertia.flash(request, 'success', `User ${name} created`);
    return redirect('/users');
  }

  /** Test-only control: bumps this session's asset version (enabled with --test-controls). */
  @Post('__test/version')
  bump(@Req() request: SessionRequest) {
    if (!testControls) throw new NotFoundException();
    request.session.assetVersion = `${baseVersion}-${randomBytes(4).toString('hex')}`;
    return { version: request.session.assetVersion };
  }
}

@Module({
  imports: [
    InertiaModule.forRoot({
      version: (request) =>
        (request as SessionRequest).session.assetVersion ?? baseVersion,
      title: (page) => `${page.component} · Nestvexa Inertia`,
      entry: { scripts: ['/assets/app.js'] },
      share: () => ({ appName: 'Nestvexa Inertia demo' }),
    }),
  ],
  controllers: [PagesController],
  providers: [{ provide: APP_GUARD, useClass: XsrfGuard }],
})
class AppModule {}

const app = await NestFactory.create<NestExpressApplication>(AppModule);
app.use(
  session({
    secret: randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: true,
    cookie: { httpOnly: true, sameSite: 'lax' },
  }),
);
app.useStaticAssets(fileURLToPath(new URL('./public', import.meta.url)), {
  prefix: '/assets/',
  index: false,
});
await app.listen(port, '127.0.0.1');
console.log(`Inertia example listening on http://127.0.0.1:${port}`);
