import {
  Body,
  Catch,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  Post,
  Query,
  Redirect,
  Render,
  Req,
  UnauthorizedException,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  FORM_ERROR,
  consumeFlash,
  consumeFormState,
  csrfToken,
  customAdapter,
  errorSummary,
  formView,
  pushFlash,
  rotateCsrfToken,
  submitForm,
} from '@nestvexa/forms';
import type { SubmitFormOptions } from '@nestvexa/forms';
import { Mailer } from '@nestvexa/mail';
import { LiveRuntime } from 'nestvexa';
import { AccountPanel } from './account.js';
import {
  CredentialsGuard,
  CsrfGuard,
  JwtAuthGuard,
  Roles,
  RolesGuard,
  SignedInGuard,
  VerifiedGuard,
  authenticateLocal,
  currentUser,
  logIn,
  logOut,
  regenerate,
} from './auth.js';
import type { AuthRequest, TokenClaims } from './auth.js';
import { APP_SETTINGS } from './settings.js';
import type { AppSettings } from './settings.js';
import { OneTimeTokens, UserStore, passwordError } from './users.js';
import type { User } from './users.js';

export const csp =
  "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

interface PageResponse {
  status(code: number): PageResponse;
  redirect(status: number, url: string): void;
  render(view: string, model: Record<string, unknown>): void;
  setHeader(name: string, value: string): void;
}

/** Guests are sent to /login; authorization failures get a generic 403 page. */
@Catch(UnauthorizedException, ForbiddenException)
export class PageAccessFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<PageResponse>();
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', csp);
    if (exception instanceof UnauthorizedException) {
      response.redirect(303, '/login');
      return;
    }
    response.status(403).render('forbidden', {
      title: 'Access denied',
      message:
        exception instanceof ForbiddenException
          ? exception.message
          : 'Access denied',
    });
  }
}

const text = (input: Record<string, unknown>, key: string) =>
  typeof input[key] === 'string' ? input[key] : '';

const loginAdapter = customAdapter<{ email: string; password: string }>(
  (input, issues) => {
    const email = text(input, 'email').trim();
    const password = text(input, 'password');
    if (!email || email.length > 254)
      issues.issue('email', 'required', 'Enter your email address.');
    if (!password || password.length > 128)
      issues.issue('password', 'required', 'Enter your password.');
    return { email, password };
  },
);
const emailAdapter = customAdapter<{ email: string }>((input, issues) => {
  const email = text(input, 'email').trim();
  if (!/^[^\s@]{1,64}@[^\s@]{1,189}$/.test(email))
    issues.issue('email', 'email', 'Enter a valid email address.');
  return { email };
});
const registerAdapter = customAdapter<{
  email: string;
  name: string;
  password: string;
}>((input, issues) => {
  const email = text(input, 'email').trim();
  const name = text(input, 'name').trim();
  const password = text(input, 'password');
  if (!/^[^\s@]{1,64}@[^\s@]{1,189}$/.test(email))
    issues.issue('email', 'email', 'Enter a valid email address.');
  if (name.length < 1 || name.length > 60)
    issues.issue('name', 'required', 'Enter a name of up to 60 characters.');
  const problem = passwordError(password);
  if (problem) issues.issue('password', 'password', problem);
  return { email, name, password };
});
const resetAdapter = customAdapter<{ token: string; password: string }>(
  (input, issues) => {
    const password = text(input, 'password');
    const problem = passwordError(password);
    if (problem) issues.issue('password', 'password', problem);
    if (password !== text(input, 'confirmation'))
      issues.issue('confirmation', 'confirmation', 'The passwords differ.');
    return { token: text(input, 'token'), password };
  },
);

/** Shared layout data. */
function chrome(request: object) {
  const user = currentUser(request);
  return {
    csrf: csrfToken(request),
    flash: consumeFlash(request),
    signedIn: user !== undefined,
    userName: user?.name ?? '',
    unverified: user !== undefined && user.verifiedAt === undefined,
  };
}
function formPage(request: object, form: string, fields: readonly string[]) {
  const state = consumeFormState(request, form);
  return {
    old: state.old,
    fields: formView(state.errors, fields, { idPrefix: `${form}-` }),
    summary: errorSummary(state.errors, {
      idPrefix: `${form}-`,
      order: [...fields],
    }),
  };
}

@Controller()
@UseFilters(PageAccessFilter)
export class AuthPages {
  constructor(
    @Inject(UserStore) private readonly users: UserStore,
    @Inject(OneTimeTokens) private readonly tokens: OneTimeTokens,
    @Inject(Mailer) private readonly mailer: Mailer,
    @Inject(APP_SETTINGS) private readonly settings: AppSettings,
  ) {}

  private submit<T>(
    request: AuthRequest,
    form: string,
    adapter: SubmitFormOptions<T>['adapter'],
    back: string,
    handle: SubmitFormOptions<T>['handle'],
    remember: readonly string[] = [],
  ) {
    return submitForm<T>(request, {
      form,
      adapter,
      back,
      allowedOrigins: this.settings.allowedOrigins,
      remember,
      handle,
    });
  }

  private async sendVerification(user: User): Promise<void> {
    const token = this.tokens.issue(user.id, 'email-verification');
    await this.mailer.sendTemplate('verify-email', {
      to: { address: user.email, name: user.name },
      model: {
        name: user.name,
        url: `${this.settings.origin}/verify-email?token=${token}`,
      },
    });
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('home')
  home(@Req() request: AuthRequest) {
    return { title: 'Auth starter', ...chrome(request) };
  }

  @Get('login')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('login')
  loginPage(@Req() request: AuthRequest) {
    return {
      title: 'Sign in',
      ...chrome(request),
      ...formPage(request, 'login', ['email', 'password']),
    };
  }

  /** CSRF + Origin + validation (forms), credentials (Passport), new session id. */
  @Post('login')
  @Redirect()
  login(@Req() request: AuthRequest) {
    return this.submit(
      request,
      'login',
      loginAdapter,
      '/login',
      async () => {
        const user = await authenticateLocal(request);
        if (!user)
          return {
            errors: { [FORM_ERROR]: ['The email or password is incorrect.'] },
          };
        await logIn(request, user);
        rotateCsrfToken(request);
        return { redirect: '/account', flash: `Signed in as ${user.name}.` };
      },
      ['email'],
    );
  }

  @Post('logout')
  @UseGuards(CsrfGuard)
  @Redirect()
  async logout(@Req() request: AuthRequest) {
    await logOut(request);
    pushFlash(request, 'You have signed out.');
    return { url: '/', statusCode: 303 };
  }

  @Get('register')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('register')
  registerPage(@Req() request: AuthRequest) {
    return {
      title: 'Create an account',
      ...chrome(request),
      ...formPage(request, 'register', ['email', 'name', 'password']),
    };
  }

  @Post('register')
  @Redirect()
  register(@Req() request: AuthRequest) {
    return this.submit(
      request,
      'register',
      registerAdapter,
      '/register',
      async (value) => {
        const user = await this.users.register(value);
        // Same answer for a taken email: no account enumeration.
        if (!user)
          return {
            errors: {
              [FORM_ERROR]: [
                'We could not create an account with these details. If you already have one, sign in or reset your password.',
              ],
            },
          };
        await this.sendVerification(user);
        await logIn(request, user);
        rotateCsrfToken(request);
        return {
          redirect: '/account',
          flash: 'Account created. Check your email to confirm your address.',
        };
      },
      ['email', 'name'],
    );
  }

  @Get('verify-email')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Header('Referrer-Policy', 'no-referrer')
  @Render('verify-email')
  verifyPage(@Req() request: AuthRequest, @Query('token') token: unknown) {
    // A GET never consumes the token: link scanners must not verify accounts.
    const valid = this.tokens.check(token, 'email-verification');
    return {
      title: 'Confirm your email',
      ...chrome(request),
      valid,
      token: valid ? token : '',
    };
  }

  @Post('verify-email')
  @UseGuards(CsrfGuard)
  @Redirect()
  verify(@Req() request: AuthRequest, @Body() body: { token?: unknown }) {
    const userId = this.tokens.consume(body.token, 'email-verification');
    if (!userId) {
      pushFlash(request, 'This confirmation link is invalid or has expired.');
      return { url: '/', statusCode: 303 };
    }
    this.users.markVerified(userId);
    pushFlash(request, 'Your email address is confirmed.');
    return { url: '/account', statusCode: 303 };
  }

  @Post('verify-email/resend')
  @UseGuards(CsrfGuard, SignedInGuard)
  @Redirect()
  async resend(@Req() request: AuthRequest) {
    const user = currentUser(request);
    if (user && user.verifiedAt === undefined)
      await this.sendVerification(user);
    pushFlash(request, 'We sent a new confirmation link.');
    return { url: '/account', statusCode: 303 };
  }

  @Get('forgot-password')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('forgot-password')
  forgotPage(@Req() request: AuthRequest) {
    return {
      title: 'Reset your password',
      ...chrome(request),
      ...formPage(request, 'forgot', ['email']),
    };
  }

  @Post('forgot-password')
  @Redirect()
  forgot(@Req() request: AuthRequest) {
    return this.submit(
      request,
      'forgot',
      emailAdapter,
      '/forgot-password',
      async ({ email }) => {
        const user = await this.users.byEmail(email);
        if (user) {
          const token = this.tokens.issue(user.id, 'password-reset');
          await this.mailer.sendTemplate('password-reset', {
            to: { address: user.email, name: user.name },
            model: {
              name: user.name,
              url: `${this.settings.origin}/reset-password?token=${token}`,
            },
          });
        }
        // Identical response whether or not the account exists.
        return {
          redirect: '/login',
          flash:
            'If an account exists for that email, we sent a link to reset the password.',
        };
      },
    );
  }

  @Get('reset-password')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Header('Referrer-Policy', 'no-referrer')
  @Render('reset-password')
  resetPage(@Req() request: AuthRequest, @Query('token') token: unknown) {
    const valid = this.tokens.check(token, 'password-reset');
    return {
      title: 'Choose a new password',
      ...chrome(request),
      ...formPage(request, 'reset', ['password', 'confirmation']),
      valid,
      token: valid ? token : '',
    };
  }

  @Post('reset-password')
  @Redirect()
  reset(@Req() request: AuthRequest) {
    const body: unknown = Reflect.get(request, 'body');
    const token: unknown =
      body && typeof body === 'object' ? Reflect.get(body, 'token') : '';
    return this.submit(
      request,
      'reset',
      resetAdapter,
      `/reset-password?token=${encodeURIComponent(typeof token === 'string' ? token : '')}`,
      async (value) => {
        const userId = this.tokens.consume(value.token, 'password-reset');
        if (!userId)
          return {
            errors: {
              [FORM_ERROR]: [
                'This reset link is invalid or has expired. Request a new one.',
              ],
            },
          };
        // Bumps the auth version: every existing session and JWT is revoked.
        await this.users.setPassword(userId, value.password);
        // The link proved control of the mailbox.
        this.users.markVerified(userId);
        await regenerate(request);
        return {
          redirect: '/login',
          flash: 'Your password was changed. Sign in with the new password.',
        };
      },
    );
  }
}

@Controller()
@UseFilters(PageAccessFilter)
export class AccountPages {
  constructor(@Inject(LiveRuntime) private readonly live: LiveRuntime) {}

  @Get('account')
  @UseGuards(SignedInGuard)
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('account')
  async account(@Req() request: AuthRequest) {
    const page = chrome(request);
    return {
      title: 'Your account',
      ...page,
      panel: await this.live.mount(AccountPanel, request),
    };
  }

  @Get('reports')
  @UseGuards(VerifiedGuard)
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('reports')
  reports(@Req() request: AuthRequest) {
    return { title: 'Reports (verified accounts)', ...chrome(request) };
  }

  @Get('admin')
  @UseGuards(SignedInGuard, RolesGuard)
  @Roles(['admin'])
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('admin')
  admin(@Req() request: AuthRequest) {
    return { title: 'Administration', ...chrome(request) };
  }
}

/** Bearer-token JSON API (no cookies, so no CSRF): Passport local + JWT. */
@Controller('api')
export class ApiController {
  constructor(@Inject(JwtService) private readonly jwt: JwtService) {}

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Post('token')
  @HttpCode(200)
  @UseGuards(CredentialsGuard)
  @Header('Cache-Control', 'no-store')
  async token(@Req() request: { user: User }) {
    const claims: TokenClaims = {
      sub: request.user.id,
      ver: request.user.authVersion,
    };
    return {
      tokenType: 'Bearer',
      accessToken: await this.jwt.signAsync({ ...claims }),
      expiresIn: 900,
    };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @Header('Cache-Control', 'no-store')
  me(@Req() request: { user: User }) {
    const { id, email, name, role } = request.user;
    return {
      id,
      email,
      name,
      role,
      verified: request.user.verifiedAt !== undefined,
    };
  }

  @Get('admin/stats')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(['admin'])
  @Header('Cache-Control', 'no-store')
  stats() {
    return { accounts: 'restricted to admins' };
  }
}
