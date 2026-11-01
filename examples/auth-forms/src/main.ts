import 'reflect-metadata';
import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  Inject,
  Module,
  Post,
  Redirect,
  Render,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  LiveRuntime,
  NestvexaModule,
  configureNestvexa,
  consumeLiveFlash,
} from 'nestvexa';
import {
  FORM_ERROR,
  MemorySubmissionLedger,
  consumeFormState,
  csrfToken,
  errorSummary,
  formView,
  issueSubmissionToken,
  pushFlash,
  rotateCsrfToken,
  submitForm,
  verifyCsrf,
} from '@nestvexa/forms';
import type { FormErrors, FormState } from '@nestvexa/forms';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import session from 'express-session';
import {
  AuthModule,
  AuthService,
  UserRepository,
  VersionConflictError,
  currentUserId,
  regenerateSession,
} from './auth.js';
import type { SessionRequest } from './auth.js';
import { ProfileEditor, conflictMessage } from './profile.js';
import {
  loginAdapter,
  profilePostAdapter,
  registerAdapter,
} from './schemas.js';

const port = Number(process.env['PORT'] ?? 3104);
const root = fileURLToPath(new URL('../views', import.meta.url));
const allowedOrigins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
const csp =
  "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** View data for a classic (server-rendered) form page. */
function page(
  request: SessionRequest,
  form: string,
  fields: readonly string[],
  labels: Record<string, string>,
  extra: Record<string, unknown> = {},
) {
  const state: FormState = consumeFormState(request, form);
  const errors: FormErrors = state.errors;
  return {
    csrf: csrfToken(request),
    flash: consumeLiveFlash(request),
    signedIn: currentUserId(request) !== undefined,
    old: state.old,
    fields: formView(errors, fields, { idPrefix: `${form}-` }),
    summary: errorSummary(errors, {
      idPrefix: `${form}-`,
      labels,
      order: fields,
    }),
    ...extra,
  };
}

@Controller()
class AuthPages {
  readonly #registrations = new MemorySubmissionLedger();
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(UserRepository) private readonly users: UserRepository,
    @Inject(LiveRuntime) private readonly live: LiveRuntime,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('home')
  home(@Req() request: SessionRequest) {
    return {
      title: 'Nestvexa forms starter',
      csrf: csrfToken(request),
      flash: consumeLiveFlash(request),
      signedIn: currentUserId(request) !== undefined,
    };
  }

  @Get('register')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('register')
  registerPage(@Req() request: SessionRequest) {
    return {
      title: 'Create an account',
      ...page(
        request,
        'register',
        ['displayName', 'email', 'password', 'passwordConfirmation'],
        {
          displayName: 'Display name',
          email: 'Email',
          password: 'Password',
          passwordConfirmation: 'Confirm password',
        },
        { submission: issueSubmissionToken(request, 'register') },
      ),
    };
  }

  @Post('register')
  @Redirect()
  register(@Req() request: SessionRequest) {
    return submitForm(request, {
      form: 'register',
      adapter: registerAdapter,
      back: '/register',
      allowedOrigins,
      remember: ['displayName', 'email'],
      // A double-clicked submit creates one account and both requests land on /profile.
      singleUse: this.#registrations,
      handle: async (value) => {
        const user = await this.auth.register(
          { displayName: value.displayName, email: value.email, bio: '' },
          value.password,
        );
        if (!user)
          return {
            errors: {
              [FORM_ERROR]: [
                'We could not create an account with these details. If you already have an account, sign in instead.',
              ],
            },
          };
        await regenerateSession(request);
        request.session.userId = user.id;
        rotateCsrfToken(request);
        return {
          redirect: '/profile',
          flash: `Welcome, ${user.displayName}. Your account is ready.`,
        };
      },
    });
  }

  @Get('login')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('login')
  loginPage(@Req() request: SessionRequest) {
    return {
      title: 'Sign in',
      ...page(request, 'login', ['email', 'password'], {
        email: 'Email',
        password: 'Password',
      }),
    };
  }

  @Post('login')
  @Redirect()
  login(@Req() request: SessionRequest) {
    return submitForm(request, {
      form: 'login',
      adapter: loginAdapter,
      back: '/login',
      allowedOrigins,
      remember: ['email'],
      handle: async ({ email, password }) => {
        const result = await this.auth.authenticate(
          email,
          password,
          request.ip ?? 'unknown',
        );
        if (result === 'throttled')
          return {
            errors: {
              [FORM_ERROR]: [
                'Too many sign-in attempts. Wait a few minutes and try again.',
              ],
            },
          };
        // One generic message: never reveal whether the email has an account.
        if (!result)
          return {
            errors: { [FORM_ERROR]: ['The email or password is incorrect.'] },
          };
        // Session fixation protection: a fresh session id and CSRF token.
        await regenerateSession(request);
        request.session.userId = result.id;
        rotateCsrfToken(request);
        return { redirect: '/profile', flash: 'You are signed in.' };
      },
    });
  }

  @Post('logout')
  @Redirect()
  async logout(@Req() request: SessionRequest) {
    if (!verifyCsrf(request))
      throw new ForbiddenException('Invalid or missing CSRF token');
    await regenerateSession(request);
    pushFlash(request, 'You have signed out.');
    return { url: '/login', statusCode: 303 };
  }

  @Get('profile')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('profile')
  async profile(@Req() request: SessionRequest) {
    const id = currentUserId(request);
    if (!id || !this.users.find(id))
      return { title: 'Sign in required', signedOut: true };
    return {
      title: 'Your profile',
      csrf: csrfToken(request),
      flash: consumeLiveFlash(request),
      signedIn: true,
      editor: await this.live.mount(ProfileEditor, request),
    };
  }

  /** The no-JavaScript submission of the profile editor's own markup. */
  @Post('profile')
  @Redirect()
  updateProfile(@Req() request: SessionRequest) {
    const id = currentUserId(request);
    if (!id) throw new UnauthorizedException();
    return submitForm(request, {
      form: 'profile',
      adapter: profilePostAdapter(this.users, id),
      back: '/profile',
      allowedOrigins,
      remember: ['displayName', 'email', 'bio'],
      handle: (value) => {
        try {
          this.users.update(id, value.version, {
            displayName: value.displayName,
            email: value.email,
            bio: value.bio,
          });
        } catch (error) {
          if (error instanceof VersionConflictError)
            return { errors: { [FORM_ERROR]: [conflictMessage] } };
          throw error;
        }
        return { redirect: '/profile', flash: 'Profile saved.' };
      },
    });
  }

  @Get('api/health')
  health() {
    return { status: 'ok' };
  }

  @Get('forms.css')
  @Header('Content-Type', 'text/css; charset=utf-8')
  styles() {
    return [
      'body{font-family:system-ui,sans-serif;max-width:42rem;margin:0 auto;padding:1rem;line-height:1.5;color:#1b1b1b;background:#fff}',
      'label{display:block;font-weight:600;margin-top:1rem}',
      'input,textarea{display:block;width:100%;box-sizing:border-box;padding:.5rem;border:2px solid #555;border-radius:4px;font:inherit}',
      '[aria-invalid="true"]{border-color:#b00020}',
      '.error{color:#b00020;margin:.25rem 0 0}',
      '.hint{color:#444;margin:.25rem 0 0}',
      '.summary{border:3px solid #b00020;padding:0 1rem;margin:1rem 0}',
      '.summary a{color:#b00020}',
      'button{margin-top:1rem;padding:.5rem 1rem;font:inherit}',
      ':focus-visible{outline:3px solid #1a5fb4;outline-offset:2px}',
      '.flash{border-left:4px solid #26a269;padding:.25rem .75rem}',
      'header nav{display:flex;gap:1rem;align-items:center;flex-wrap:wrap}',
      'header form button{margin:0}',
    ].join('');
  }
}

@Module({
  imports: [
    AuthModule,
    NestvexaModule.forRoot(
      { views: { root, layout: 'layout' }, live: { enabled: true } },
      {
        components: [ProfileEditor],
        imports: [AuthModule],
        useFactory: () => ({
          origin: `http://127.0.0.1:${port}`,
          maxRequestsPerMinute: 240,
          resolveIdentity(request: object) {
            const value = request as Partial<SessionRequest>;
            if (!value.session?.csrf || !value.sessionID)
              throw new UnauthorizedException();
            const user = currentUserId(request);
            // The session id changes on sign-in/out, so earlier snapshots stop matching.
            return {
              binding: `${user ? `user:${user}` : 'guest'}:session:${value.sessionID}`,
              csrfToken: value.session.csrf,
            };
          },
          // Only signed-in identities may mount or drive the profile editor.
          authorize: (identity, component, action) =>
            identity.binding.startsWith('user:') &&
            component === 'profile-editor' &&
            ['$mount', '$sync', 'save'].includes(action),
        }),
      },
    ),
  ],
  controllers: [AuthPages],
})
class AppModule {}

const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  logger: ['error', 'warn'],
});
// Flat urlencoded keys: @nestvexa/forms parses brackets itself and refuses
// prototype keys loudly (qs would drop them silently).
app.useBodyParser('urlencoded', { extended: false, limit: '64kb' });
// Local demonstration: production hosts supply a persistent session store, a
// deployment secret, HTTPS-only cookies and trusted proxy configuration.
app.use(
  session({
    name: 'nvforms.sid',
    secret: randomBytes(48).toString('base64url'),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 30 * 60_000,
    },
  }),
);
await configureNestvexa(app);
app.enableShutdownHooks();
await app.listen(port, '127.0.0.1');
console.log(`Forms and auth starter: ${await app.getUrl()}`);
