import 'reflect-metadata';
import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { csrfToken } from '@nestvexa/forms';
import { ConsoleMailTransport, MailModule } from '@nestvexa/mail';
import type { MailTransport } from '@nestvexa/mail';
import { HbsEngine, NestvexaModule, configureNestvexa } from 'nestvexa';
import type { LiveIdentity } from 'nestvexa';
import session from 'express-session';
import passport from 'passport';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AccountPanel } from './account.js';
import {
  JWT_SETTINGS,
  JwtStrategy,
  LocalStrategy,
  SessionSerializer,
  currentUser,
} from './auth.js';
import { AccountPages, ApiController, AuthPages } from './pages.js';
import { APP_SETTINGS } from './settings.js';
import { CLOCK, OneTimeTokens, UserStore } from './users.js';
import type { Clock } from './users.js';

export interface AppOptions {
  readonly port: number;
  /** Public origin; default `http://127.0.0.1:<port>`. */
  readonly origin?: string;
  /** Delivery for verification and reset mail; default logs to the console. */
  readonly mail?: MailTransport;
  /** Time source for token expiry (tests). */
  readonly now?: Clock;
  /** `Secure` + `__Host-` session cookie. Default: true for an https origin. */
  readonly secureCookies?: boolean;
  /** Trust one reverse proxy (X-Forwarded-Proto) for `req.secure`. */
  readonly trustProxy?: boolean;
  /** At least 32 characters; default from SESSION_SECRET or random per start. */
  readonly sessionSecret?: string;
  /** At least 32 characters; default from JWT_SECRET or random per start. */
  readonly jwtSecret?: string;
  readonly logger?: false | ('error' | 'warn' | 'log')[];
}

const views = fileURLToPath(new URL('../views', import.meta.url));
const memberActions = new Set(['$mount', '$sync', 'rename']);

function secret(value: string | undefined, name: string): string {
  const chosen = value ?? process.env[name];
  if (chosen !== undefined && chosen.length < 32)
    throw new Error(`${name} must be at least 32 characters`);
  return chosen ?? randomBytes(48).toString('base64url');
}

/** Live identity: account, auth version and session id from the Passport session. */
function liveIdentity(request: object): LiveIdentity {
  const sessionId: unknown = Reflect.get(request, 'sessionID');
  if (typeof sessionId !== 'string') throw new Error('Missing session');
  const user = currentUser(request);
  const subject = user ? `user:${user.id}:v${user.authVersion}` : 'guest';
  return {
    binding: `${subject}:session:${sessionId}`,
    csrfToken: csrfToken(request),
  };
}

function appModule(options: AppOptions, origin: string): DynamicModule {
  const now = options.now ?? Date.now;
  const jwt = {
    secret: secret(options.jwtSecret, 'JWT_SECRET'),
    issuer: origin,
    audience: `${origin}/api`,
  };
  @Module({
    imports: [PassportModule.register({ session: true })],
    providers: [
      { provide: CLOCK, useValue: now },
      { provide: JWT_SETTINGS, useValue: jwt },
      UserStore,
      OneTimeTokens,
      LocalStrategy,
      JwtStrategy,
      SessionSerializer,
    ],
    exports: [UserStore, OneTimeTokens, CLOCK],
  })
  class IdentityModule {}

  @Module({})
  class AppModule {}
  return {
    module: AppModule,
    imports: [
      IdentityModule,
      JwtModule.register({
        secret: jwt.secret,
        signOptions: {
          algorithm: 'HS256',
          expiresIn: 900,
          issuer: jwt.issuer,
          audience: jwt.audience,
        },
        verifyOptions: { algorithms: ['HS256'] },
      }),
      MailModule.forRoot({
        global: true,
        transport: options.mail ?? new ConsoleMailTransport(),
        from: { address: 'noreply@auth-starter.test', name: 'Auth starter' },
        templates: {
          renderer: new HbsEngine({ root: views }),
          layout: 'emails/layout',
        },
      }),
      NestvexaModule.forRoot(
        { views: { root: views, layout: 'layout' }, live: { enabled: true } },
        {
          components: [AccountPanel],
          imports: [IdentityModule],
          useFactory: () => ({
            origin,
            maxRequestsPerMinute: 240,
            resolveIdentity: liveIdentity,
            // Guests can call nothing; members only the panel's own actions.
            authorize: (identity, component, action) =>
              identity.binding.startsWith('user:') &&
              component === 'account-panel' &&
              memberActions.has(action),
          }),
        },
      ),
    ],
    providers: [
      {
        provide: APP_SETTINGS,
        useValue: {
          origin,
          allowedOrigins: [origin],
        },
      },
    ],
    controllers: [AuthPages, AccountPages, ApiController],
  };
}

/** Builds the configured application without listening (tests and main.ts). */
export async function createApp(
  options: AppOptions,
): Promise<NestExpressApplication> {
  const origin = options.origin ?? `http://127.0.0.1:${options.port}`;
  const secure = options.secureCookies ?? origin.startsWith('https:');
  const app = await NestFactory.create<NestExpressApplication>(
    appModule(options, origin),
    { logger: options.logger ?? ['error', 'warn'] },
  );
  if (options.trustProxy) app.set('trust proxy', 1);
  // Flat urlencoded keys: @nestvexa/forms parses brackets itself.
  app.useBodyParser('urlencoded', { extended: false, limit: '16kb' });
  app.useBodyParser('json', { limit: '16kb' });
  // The in-memory session store is for demonstration only: production uses a
  // shared store (Redis, database) and a stable SESSION_SECRET.
  app.use(
    session({
      name: secure ? '__Host-auth.sid' : 'auth.sid',
      secret: secret(options.sessionSecret, 'SESSION_SECRET'),
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure,
        path: '/',
        maxAge: 8 * 60 * 60_000,
      },
    }),
  );
  app.use(passport.session());
  await configureNestvexa(app);
  app.enableShutdownHooks();
  return app;
}
