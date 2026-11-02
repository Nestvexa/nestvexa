import 'reflect-metadata';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Module,
  Post,
  Render,
  Req,
  Res,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ActionsModule } from '@nestvexa/actions';
import { NestvexaModule, configureNestvexa } from 'nestvexa';
import session from 'express-session';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CartActions, CartModule } from './cart.js';
import type { SessionState } from './cart.js';

declare module 'express-session' {
  interface SessionData {
    csrf?: string;
    userId?: string;
  }
}
interface SessionRequest {
  session: session.Session & Partial<session.SessionData>;
  sessionID: string;
}
interface RedirectResponse {
  redirect(status: number, url: string): void;
}

const port = Number(process.env['PORT'] ?? 3111);
const origin = `http://127.0.0.1:${port}`;
const views = fileURLToPath(new URL('../views', import.meta.url));
const bundle = readFileSync(
  new URL('./public/app.js', import.meta.url),
  'utf8',
);
const csp =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function sameToken(left: unknown, right: string | undefined): boolean {
  if (typeof left !== 'string' || right === undefined) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

@Controller()
class PagesController {
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('home')
  home(@Req() request: SessionRequest) {
    request.session.csrf ??= randomBytes(32).toString('base64url');
    return {
      title: 'Nestvexa server actions',
      csrf: request.session.csrf,
      user: request.session.userId ?? null,
    };
  }

  /** Demo sign-in: regenerates the session (fixation protection) and rotates CSRF. */
  @Post('login')
  async login(
    @Req() request: SessionRequest,
    @Body() body: { _csrf?: unknown; name?: unknown },
    @Res() response: RedirectResponse,
  ): Promise<void> {
    if (!sameToken(body._csrf, request.session.csrf))
      throw new ForbiddenException('Invalid form token');
    const name =
      typeof body.name === 'string' && /^[a-z]{1,20}$/i.test(body.name)
        ? body.name.toLowerCase()
        : 'demo';
    await new Promise<void>((resolve, reject) =>
      request.session.regenerate((error: unknown) =>
        error
          ? reject(error instanceof Error ? error : new Error('Session error'))
          : resolve(),
      ),
    );
    request.session.userId = `user:${name}`;
    request.session.csrf = randomBytes(32).toString('base64url');
    response.redirect(303, '/');
  }

  @Post('logout')
  logout(
    @Req() request: SessionRequest,
    @Body() body: { _csrf?: unknown },
    @Res() response: RedirectResponse,
  ): void {
    if (!sameToken(body._csrf, request.session.csrf))
      throw new ForbiddenException('Invalid form token');
    request.session.destroy(() => response.redirect(303, '/'));
  }

  @Get('assets/app.js')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  @Header('Cache-Control', 'no-cache')
  script(): string {
    return bundle;
  }

  @Get('api/health')
  health() {
    return { status: 'ok' };
  }
}

@Module({
  imports: [
    NestvexaModule.forRoot({ views: { root: views, layout: 'layouts/main' } }),
    ActionsModule.register({
      groups: [CartActions],
      imports: [CartModule],
      origin,
      // Identity comes from the server-side session only. Guests get a
      // session-scoped subject; the group's SessionAuthGuard requires sign-in.
      resolveIdentity(request) {
        const value = request as Partial<SessionRequest> & {
          session?: SessionState;
        };
        if (!value.session?.csrf || !value.sessionID) return null;
        return {
          subject: value.session.userId ?? `guest:${value.sessionID}`,
          tenant: 'demo-store',
          csrfToken: value.session.csrf,
        };
      },
      authorize: (_identity, action) => action.group === 'cart',
      exposeErrorDetails: process.env['NODE_ENV'] === 'development',
    }),
  ],
  controllers: [PagesController],
})
class AppModule {}

const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
// Local demonstration only: production hosts use a persistent session store,
// a deployment secret, HTTPS-only cookies and real authentication.
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
console.log(`Server actions example: ${await app.getUrl()}`);
