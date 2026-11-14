import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  Post,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import {
  InertiaPage,
  InertiaService,
  InertiaValidationException,
  defer,
  optional,
  redirect,
} from '@nestvexa/inertia';
import { constantTimeEqual } from '@nestvexa/forms';
import { randomBytes } from 'node:crypto';
import { ShowcaseData } from './data.js';
import { translator } from './i18n.js';
import { Directory, Roles, SignedInGuard } from './identity.js';
import type { SessionRequest } from './identity.js';
import { PageAccessFilter } from './pages.js';

/**
 * Host-owned CSRF for the official Inertia client: a per-session token in the
 * readable `XSRF-TOKEN` cookie, echoed by `@inertiajs/core` as `X-XSRF-TOKEN`.
 * Live and uploads use their own CSRF headers.
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
    if (['GET', 'HEAD'].includes(request.method ?? 'GET')) {
      response.cookie('XSRF-TOKEN', token, {
        sameSite: 'strict',
        path: '/insights',
      });
      return true;
    }
    const sent = request.headers?.['x-xsrf-token'];
    if (
      !constantTimeEqual(
        typeof sent === 'string' ? decodeURIComponent(sent) : '',
        token,
      )
    )
      throw new ForbiddenException('CSRF token mismatch');
    return true;
  }
}

function field(body: unknown, name: string): string {
  const value =
    typeof body === 'object' && body !== null
      ? Reflect.get(body, name)
      : undefined;
  return typeof value === 'string'
    ? value.trim()
    : typeof value === 'number'
      ? String(value)
      : '';
}

const weekLabels = (count: number) =>
  Array.from({ length: count }, (_, index) => `W${index + 1}`);

/**
 * `/insights`: the Vue Inertia section (SSR, deferred and partial props, a chart, a form).
 * Guests are redirected to sign-in like every other page.
 */
@Controller('insights')
@UseFilters(PageAccessFilter)
@UseGuards(SignedInGuard, XsrfGuard)
export class InsightsController {
  constructor(
    @Inject(InertiaService) private readonly inertia: InertiaService,
    @Inject(Directory) private readonly directory: Directory,
    @Inject(ShowcaseData) private readonly data: ShowcaseData,
  ) {}

  @Get()
  @InertiaPage('Analytics')
  analytics(@Req() request: SessionRequest) {
    const access = this.directory.require(request);
    const workspace = access.workspace.slug;
    const tasks = this.data.tasks(workspace);
    return {
      heading: translator(request).t('insights:heading', {
        workspace: access.workspace.name,
      }),
      summary: {
        open: tasks.filter((task) => !task.done).length,
        done: tasks.filter((task) => task.done).length,
        members: this.directory.members(workspace).length,
      },
      // Deferred: rendered after the first paint by a follow-up partial request.
      throughput: defer(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const values = [...this.data.throughput(workspace)];
        return { labels: weekLabels(values.length), values };
      }),
      // Optional: only computed when a partial reload asks for it.
      breakdown: optional(() =>
        this.directory.members(workspace).map((member) => ({
          name: member.name,
          open: tasks.filter(
            (task) => task.assignee === member.id && !task.done,
          ).length,
        })),
      ),
    };
  }

  @Get('goals')
  @InertiaPage('Goals')
  goals(@Req() request: SessionRequest) {
    const access = this.directory.require(request);
    return {
      canCreate: access.role === 'admin',
      goals: () =>
        this.data.goals(access.workspace.slug).map((goal) => ({ ...goal })),
    };
  }

  /** Admin only (native guard metadata); validation errors return through the session. */
  @Post('goals')
  @Roles(['admin'])
  createGoal(@Req() request: SessionRequest, @Body() body: unknown) {
    const access = this.directory.require(request);
    const title = field(body, 'title');
    const target = Number(field(body, 'target'));
    const errors: Record<string, string> = {};
    if (title.length < 3 || title.length > 80)
      errors['title'] = 'Use a goal title of 3 to 80 characters.';
    if (!Number.isInteger(target) || target < 1 || target > 100)
      errors['target'] = 'The target must be a whole percentage from 1 to 100.';
    if (Object.keys(errors).length)
      throw new InertiaValidationException(errors);
    this.data.addGoal(access.workspace.slug, title, target);
    this.inertia.flash(request, 'success', `Goal “${title}” added.`);
    return redirect('/insights/goals');
  }
}
