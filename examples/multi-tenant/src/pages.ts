import {
  Catch,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Redirect,
  Render,
  Req,
  UnauthorizedException,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { LiveRuntime, consumeLiveFlash } from 'nestvexa';
import {
  FORM_ERROR,
  consumeFormState,
  csrfToken,
  customAdapter,
  errorSummary,
  formView,
  pushFlash,
  rotateCsrfToken,
  submitForm,
  verifyCsrf,
} from '@nestvexa/forms';
import { TenantBoard } from './board.js';
import { allowedOrigins } from './config.js';
import { Directory, ProjectRepository, TenantGuard } from './tenancy.js';
import type { SessionRequest } from './tenancy.js';

export const csp =
  "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

interface PageResponse {
  status(code: number): PageResponse;
  redirect(status: number, url: string): void;
  render(view: string, model: Record<string, unknown>): void;
  setHeader(name: string, value: string): void;
}

/**
 * HTML pages answer a guest with a redirect to sign-in and a non-member with a
 * generic 403 page that names no tenant data. The JSON API keeps Nest's
 * default 401/403 bodies.
 */
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
      signedIn: true,
    });
  }
}

const loginAdapter = customAdapter<{ email: string; password: string }>(
  (input, issues) => {
    const email =
      typeof input['email'] === 'string' ? input['email'].trim() : '';
    const password =
      typeof input['password'] === 'string' ? input['password'] : '';
    if (!email || email.length > 254)
      issues.issue('email', 'required', 'Enter your email address.');
    if (!password || password.length > 128)
      issues.issue('password', 'required', 'Enter your password.');
    return { email, password };
  },
);

/** Session fixation protection: issue a new session id, keeping nothing. */
function regenerate(request: SessionRequest): Promise<void> {
  return new Promise((resolve, reject) =>
    request.session.regenerate((error: unknown) =>
      error
        ? reject(error instanceof Error ? error : new Error('Session error'))
        : resolve(),
    ),
  );
}

@Controller()
@UseFilters(PageAccessFilter)
export class Pages {
  constructor(
    @Inject(Directory) private readonly directory: Directory,
    @Inject(LiveRuntime) private readonly live: LiveRuntime,
  ) {}

  /** Shared layout data: navigation for the signed-in account. */
  private chrome(request: SessionRequest) {
    const account = this.directory.currentUser(request);
    return {
      csrf: csrfToken(request),
      flash: consumeLiveFlash(request),
      signedIn: account !== undefined,
      userName: account?.name ?? '',
    };
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('home')
  home(@Req() request: SessionRequest) {
    const account = this.directory.currentUser(request);
    return {
      title: 'Nestvexa workspaces',
      ...this.chrome(request),
      tenants: this.directory.tenants().map((tenant) => ({
        slug: tenant.slug,
        name: tenant.name,
        role: account ? this.directory.role(account, tenant.slug) : undefined,
      })),
    };
  }

  @Get('login')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('login')
  loginPage(@Req() request: SessionRequest) {
    const state = consumeFormState(request, 'login');
    const fields = ['email', 'password'];
    return {
      title: 'Sign in',
      ...this.chrome(request),
      old: state.old,
      fields: formView(state.errors, fields, { idPrefix: 'login-' }),
      summary: errorSummary(state.errors, {
        idPrefix: 'login-',
        labels: { email: 'Email', password: 'Password' },
        order: fields,
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
        const account = await this.directory.authenticate(email, password);
        // One generic message: never reveal whether the email has an account.
        if (!account)
          return {
            errors: { [FORM_ERROR]: ['The email or password is incorrect.'] },
          };
        await regenerate(request);
        request.session.userId = account.id;
        rotateCsrfToken(request);
        return { redirect: '/', flash: `Signed in as ${account.name}.` };
      },
    });
  }

  @Post('logout')
  @Redirect()
  async logout(@Req() request: SessionRequest) {
    if (!verifyCsrf(request))
      throw new ForbiddenException('Invalid or missing CSRF token');
    await regenerate(request);
    pushFlash(request, 'You have signed out.');
    return { url: '/', statusCode: 303 };
  }

  /** Public tenant page: only the name and tagline, never projects. */
  @Get('t/:tenant')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('tenant')
  tenant(@Req() request: SessionRequest, @Param('tenant') slug: string) {
    const tenant = this.directory.tenant(String(slug));
    if (!tenant) throw new NotFoundException();
    const account = this.directory.currentUser(request);
    return {
      title: tenant.name,
      ...this.chrome(request),
      tenant,
      member: account ? !!this.directory.role(account, tenant.slug) : false,
    };
  }

  /** Member area. The guard runs before this handler reads anything. */
  @Get('t/:tenant/projects')
  @UseGuards(TenantGuard)
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('projects')
  async projects(
    @Req() request: SessionRequest,
    @Param('tenant') slug: string,
  ) {
    const access = this.directory.accessTo(request, String(slug));
    // Live requests resolve their tenant from this server-side value only.
    request.session.activeTenant = access.tenant.slug;
    const chrome = this.chrome(request);
    return {
      title: `${access.tenant.name} projects`,
      ...chrome,
      tenant: access.tenant,
      role: access.role,
      board: await this.live.mount(TenantBoard, request),
    };
  }
}

/** Native Nest REST endpoints: unaffected by Nestvexa, guarded per tenant. */
@Controller('api')
export class Api {
  constructor(
    @Inject(Directory) private readonly directory: Directory,
    @Inject(ProjectRepository) private readonly projects: ProjectRepository,
  ) {}
  @Get('health')
  health() {
    return { status: 'ok', tenants: this.directory.tenants().length };
  }
  @Get('t/:tenant/projects')
  @UseGuards(TenantGuard)
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  list(@Req() request: SessionRequest, @Param('tenant') slug: string) {
    const access = this.directory.accessTo(request, String(slug));
    return {
      tenant: access.tenant.slug,
      role: access.role,
      projects: this.projects.list(access.tenant.slug),
    };
  }
}
