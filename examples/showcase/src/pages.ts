import {
  BadRequestException,
  Catch,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpException,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
  Redirect,
  Render,
  Req,
  Res,
  UnauthorizedException,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
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
  verifyCsrf,
} from '@nestvexa/forms';
import { MemoryMailTransport } from '@nestvexa/mail';
import { RealtimeService } from '@nestvexa/realtime';
import { UploadsService } from '@nestvexa/uploads';
import { ViteAssets } from '@nestvexa/vite';
import { LiveRuntime, SafeHtml, consumeLiveFlash } from 'nestvexa';
import { randomUUID } from 'node:crypto';
import { instance, origin } from './config.js';
import { ShowcaseData } from './data.js';
import {
  i18n,
  localeChoices,
  localeCookie,
  safeReturn,
  translator,
} from './i18n.js';
import { Directory, SignedInGuard, bindingOf } from './identity.js';
import type { SessionRequest } from './identity.js';
import { dashboardIslands } from './islands.js';
import { MetricsPanel } from './metrics.js';
import {
  ProfileService,
  ProfileWizard,
  initialValues,
  profileFields,
  profileWizard,
} from './profile.js';
import type { ProfileValues } from './profile.js';
import { accounts, workspaces } from './seed.js';
import { TaskBoard } from './tasks.js';

export const MAIL_OUTBOX = Symbol('mail-outbox');
/** The test transport when `MAIL_TRANSPORT=memory`, so the outbox page can read it. */
export interface MailOutbox {
  readonly memory: MemoryMailTransport | undefined;
}
export const ASSETS = Symbol('vite-assets');

export const csp =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

interface PageResponse {
  status(code: number): PageResponse;
  redirect(status: number, url: string): void;
  render(view: string, model: Record<string, unknown>): void;
  setHeader(name: string, value: string): void;
}

/**
 * Pages answer a guest with a redirect to sign-in and a wrong role with a
 * generic 403 page. The JSON API keeps Nest's default 401/403 bodies.
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
      i18n: translator(host.switchToHttp().getRequest<object>()).view,
      instance,
    });
  }
}

interface ErrorRequest {
  readonly method?: string;
  readonly path?: string;
  readonly headers?: Record<string, string | string[] | undefined>;
}
interface ErrorResponse {
  readonly headersSent: boolean;
  status(code: number): ErrorResponse;
  setHeader(name: string, value: string): void;
  render(
    view: string,
    model: Record<string, unknown>,
    callback: (error: Error | null, html?: string) => void,
  ): void;
  send(body: string): void;
  type(value: string): ErrorResponse;
}
const errorLogger = new Logger('Errors');

/**
 * Page controllers: guests and wrong roles as in `PageAccessFilter`; any
 * other unexpected error on a document request renders a translated 500
 * page with a short reference that matches the server log line. The error
 * text and stack never reach the browser. Other HTTP exceptions and
 * non-document requests keep Nest's default handling (JSON bodies).
 */
@Catch()
export class ErrorPageFilter extends BaseExceptionFilter {
  readonly #access = new PageAccessFilter();
  override catch(exception: unknown, host: ArgumentsHost): void {
    if (
      exception instanceof UnauthorizedException ||
      exception instanceof ForbiddenException
    ) {
      this.#access.catch(exception, host);
      return;
    }
    const http = host.switchToHttp();
    const request = http.getRequest<ErrorRequest>();
    const response = http.getResponse<ErrorResponse>();
    const accept = request.headers?.['accept'];
    const page =
      (request.method === 'GET' || request.method === 'HEAD') &&
      typeof accept === 'string' &&
      accept.includes('text/html');
    if (exception instanceof HttpException || !page || response.headersSent) {
      super.catch(exception, host);
      return;
    }
    const reference = randomUUID().slice(0, 8);
    errorLogger.error(
      `Unhandled error ${reference} on ${request.method ?? 'GET'} ${request.path ?? ''}`,
      exception instanceof Error ? exception.stack : undefined,
    );
    const t = translator(request);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', csp);
    response
      .status(500)
      .render(
        'error',
        { title: t.t('error.title'), i18n: t.view, instance, reference },
        (error, html) => {
          // The error page itself failed: a minimal text answer, still no detail.
          if (error || html === undefined)
            response.type('text/plain').send(`Internal error ${reference}`);
          else response.type('text/html').send(html);
        },
      );
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
/** The no-JavaScript wizard route validates per step itself; this only hardens the body. */
const wizardBody = customAdapter<Record<string, unknown>>((input) => ({
  ...input,
}));

/** Session fixation protection: a new session id, keeping nothing. */
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
@UseFilters(ErrorPageFilter)
export class PagesController {
  constructor(
    @Inject(Directory) private readonly directory: Directory,
    @Inject(LiveRuntime) private readonly live: LiveRuntime,
    @Inject(ShowcaseData) private readonly data: ShowcaseData,
    @Inject(UploadsService) private readonly uploads: UploadsService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
    @Inject(ASSETS) private readonly assets: ViteAssets,
    @Inject(MAIL_OUTBOX) private readonly mailbox: MailOutbox,
    @Inject(ProfileService) private readonly profileService: ProfileService,
  ) {}

  /** Layout data for every HBS page, in the negotiated locale. */
  private chrome(request: SessionRequest, current: string) {
    const access = this.directory.access(request);
    const t = translator(request);
    const nav = (
      [
        ['/app', 'nav.dashboard'],
        ['/app/tasks', 'nav.tasks'],
        ['/app/profile', 'nav.profile'],
        ['/insights', 'nav.analytics'],
        ['/insights/goals', 'nav.goals'],
        ['/app/outbox', 'nav.outbox'],
      ] as const
    ).map(([href, key]) => ({
      href,
      label: t.t(key),
      current: href === current,
    }));
    return {
      i18n: t.view,
      locales: localeChoices(request),
      returnTo: current,
      csrf: csrfToken(request),
      flash: [...consumeFlash(request), ...consumeLiveFlash(request)],
      signedIn: access !== undefined,
      userName: access?.user.name ?? '',
      role: access ? t.t(`roles.${access.role}`) : '',
      workspaceName: access?.workspace.name ?? '',
      nav: access ? nav : [],
      instance,
    };
  }

  /** Public landing page: plain HBS, SEO metadata, no workspace data. */
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('home')
  home(@Req() request: SessionRequest) {
    const t = translator(request);
    return {
      title: t.t('site.name'),
      description: t.t('home.description'),
      canonical: `${origin}/`,
      // One URL per language for search engines (the query wins negotiation).
      alternates: i18n.locales.map((locale) => ({
        code: locale,
        href: `${origin}/?lang=${locale}`,
      })),
      ...this.chrome(request, '/'),
      workspaces: workspaces.map((workspace) => ({ ...workspace })),
    };
  }

  @Get('login')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('login')
  loginPage(@Req() request: SessionRequest) {
    const state = consumeFormState(request, 'login');
    const fields = ['email', 'password'];
    const t = translator(request);
    return {
      title: t.t('login.title'),
      ...this.chrome(request, '/login'),
      old: state.old,
      fields: formView(state.errors, fields, { idPrefix: 'login-' }),
      summary: errorSummary(state.errors, {
        idPrefix: 'login-',
        labels: { email: t.t('login.email'), password: t.t('login.password') },
        order: fields,
      }),
      accounts: accounts.map((account) => ({
        email: account.email,
        role: account.role,
        workspace:
          workspaces.find((item) => item.slug === account.workspace)?.name ??
          '',
      })),
    };
  }

  @Post('login')
  @Redirect()
  login(@Req() request: SessionRequest) {
    return submitForm(request, {
      form: 'login',
      adapter: loginAdapter,
      back: '/login',
      allowedOrigins: [origin],
      remember: ['email'],
      handle: async ({ email, password }) => {
        const account = await this.directory.authenticate(email, password);
        // One generic message: never reveal whether the email has an account.
        if (!account)
          return {
            errors: {
              [FORM_ERROR]: [translator(request).t('login.incorrect')],
            },
          };
        await regenerate(request);
        request.session.userId = account.id;
        rotateCsrfToken(request);
        return { redirect: '/app', flash: `Signed in as ${account.name}.` };
      },
    });
  }

  @Post('logout')
  @Redirect()
  async logout(@Req() request: SessionRequest) {
    if (!verifyCsrf(request))
      throw new ForbiddenException('Invalid or missing CSRF token');
    // Close the realtime connections bound to this session before it ends.
    if (request.session.userId)
      this.realtime.revoke(bindingOf(this.directory, request));
    await regenerate(request);
    pushFlash(request, 'You have signed out.');
    return { url: '/', statusCode: 303 };
  }

  /**
   * Switches the display language: an allowlisted locale in the `nv-locale`
   * cookie, then back to the page the form was on. Works without JavaScript.
   */
  @Post('locale')
  @Redirect()
  setLocale(
    @Req() request: SessionRequest,
    @Res({ passthrough: true })
    response: { append(name: string, value: string): unknown },
  ) {
    if (!verifyCsrf(request))
      throw new ForbiddenException('Invalid or missing CSRF token');
    const body: unknown = request.body;
    const value = (name: string): unknown =>
      body && typeof body === 'object' && Object.hasOwn(body, name)
        ? Reflect.get(body, name)
        : undefined;
    const requested = value('locale');
    const locale =
      typeof requested === 'string' && requested.length <= 35
        ? i18n.match(requested)
        : undefined;
    if (!locale) throw new BadRequestException('Unsupported locale');
    response.append('Set-Cookie', localeCookie(locale));
    return { url: safeReturn(value('return')), statusCode: 303 };
  }

  /**
   * Dashboard: a Live realtime panel next to three independent islands, all
   * server-rendered: a Vue chart, a React chart (the @nestvexa/ui chart
   * wrapper) and a Svelte widget.
   */
  @Get('app')
  @UseGuards(SignedInGuard)
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('dashboard')
  async dashboard(@Req() request: SessionRequest) {
    const access = this.directory.require(request);
    const t = translator(request);
    const tasks = this.data.tasks(access.workspace.slug);
    const dashboard = await dashboardIslands(t, {
      throughput: this.data.throughput(access.workspace.slug),
      members: this.directory.members(access.workspace.slug).map((member) => {
        const assigned = tasks.filter((task) => task.assignee === member.id);
        return {
          name: member.name,
          open: assigned.filter((task) => !task.done).length,
          done: assigned.filter((task) => task.done).length,
        };
      }),
    });
    return {
      title: t.t('dashboard.title'),
      ...this.chrome(request, '/app'),
      islandTags: SafeHtml.trusted(
        this.assets.tags('islands') + dashboard.head,
      ),
      panel: await this.live.mount(MetricsPanel, request),
      ...dashboard.islands,
    };
  }

  @Get('app/tasks')
  @UseGuards(SignedInGuard)
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('tasks')
  async tasks(@Req() request: SessionRequest) {
    return {
      title: 'Tasks',
      ...this.chrome(request, '/app/tasks'),
      board: await this.live.mount(TaskBoard, request),
    };
  }

  /** Attachment download: members of the task's workspace only (404 otherwise, no oracle). */
  @Get('app/tasks/:id/attachment')
  @UseGuards(SignedInGuard)
  async attachment(
    @Req() request: SessionRequest,
    @Res() response: object,
    @Param('id') id: string,
  ) {
    const access = this.directory.require(request);
    const task = this.data.task(access.workspace.slug, String(id));
    if (!task?.attachment) throw new NotFoundException();
    await this.uploads.download(request, response, task.attachment, {
      disposition: 'attachment',
    });
  }

  @Get('app/profile')
  @UseGuards(SignedInGuard)
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('profile')
  async profile(@Req() request: SessionRequest) {
    return {
      title: 'Profile setup',
      ...this.chrome(request, '/app/profile'),
      wizard: await this.live.mount(ProfileWizard, request),
    };
  }

  /**
   * The wizard without JavaScript: the same steps and schemas, progress in the
   * server session, errors and old input through `submitForm` (CSRF, Origin
   * and body hardening first). The photo step needs JavaScript and is optional.
   */
  @Post('app/profile')
  @UseGuards(SignedInGuard)
  @Redirect()
  submitProfile(@Req() request: SessionRequest) {
    const access = this.directory.require(request);
    return submitForm(request, {
      form: 'profile',
      adapter: wizardBody,
      back: '/app/profile',
      allowedOrigins: [origin],
      remember: [...profileFields],
      handle: async (input) => {
        const flow = request.session.profileFlow ?? {
          state: profileWizard.initial(),
          values: initialValues(
            this.data.profile(access.user.id),
            access.user.name,
          ),
        };
        const position = profileWizard.position(flow.state);
        const values: ProfileValues = { ...flow.values };
        for (const field of position.fields)
          if (field in values && typeof input[field] === 'string')
            values[field as keyof ProfileValues] = input[field];
        const intent = input['intent'];
        if (intent === 'back') {
          request.session.profileFlow = {
            state: profileWizard.back(flow.state),
            values,
          };
          return { redirect: '/app/profile' };
        }
        if (intent === 'finish') {
          const result = await profileWizard.finish(flow.state, {
            ...values,
            avatar: '',
          });
          if (!result.ok) {
            request.session.profileFlow = { state: result.state, values };
            return { errors: result.errors };
          }
          await this.profileService.complete(access, result.value, undefined);
          delete request.session.profileFlow;
          return { redirect: '/app/profile', flash: 'Profile saved.' };
        }
        const result = await profileWizard.next(flow.state, {
          ...values,
          avatar: '',
        });
        request.session.profileFlow = { state: result.state, values };
        return result.ok
          ? { redirect: '/app/profile' }
          : { errors: result.errors };
      },
    });
  }

  /** The signed-in user's own photo only. */
  @Get('app/profile/avatar')
  @UseGuards(SignedInGuard)
  async avatar(@Req() request: SessionRequest, @Res() response: object) {
    const access = this.directory.require(request);
    const avatar = this.data.profile(access.user.id)?.avatar;
    if (!avatar) throw new NotFoundException();
    await this.uploads.download(request, response, avatar, {
      disposition: 'inline',
    });
  }

  /**
   * Development mail outbox: what the test transport captured for the
   * signed-in user's address only. Absent with the console transport.
   */
  @Get('app/outbox')
  @UseGuards(SignedInGuard)
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('outbox')
  mail(@Req() request: SessionRequest) {
    const access = this.directory.require(request);
    const outbox = this.mailbox.memory;
    const messages = outbox
      ? [...outbox.to(access.user.email)].reverse().map((message) => ({
          subject: message.subject,
          text: message.text ?? '',
        }))
      : [];
    return {
      title: 'Mail outbox',
      ...this.chrome(request, '/app/outbox'),
      memory: outbox !== undefined,
      messages,
    };
  }
}
