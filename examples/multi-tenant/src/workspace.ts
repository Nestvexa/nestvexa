import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  Injectable,
  Param,
  Post,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import {
  ActionContext,
  ActionError,
  ActionGroup,
  ActionInput,
  ServerAction,
} from '@nestvexa/actions';
import { verifyCsrf } from '@nestvexa/forms';
import { InertiaPage } from '@nestvexa/inertia';
import { UploadsService } from '@nestvexa/uploads';
import { ProjectEvents, SummaryCache } from './events.js';
import { islands } from './islands.js';
import { PageAccessFilter } from './pages.js';
import {
  Directory,
  ProjectRepository,
  TenantGuard,
  projectNameError,
} from './tenancy.js';

/*
 * The other transports of the workspace, each scoped by the same server-side
 * tenant: server actions, an Inertia report page, island props, uploads and a
 * cached JSON summary. None of them reads a tenant id from the request body,
 * query or headers; `/t/:tenant/...` routes are guarded by TenantGuard and
 * everything else uses the tenant the request context verified.
 */

export const ATTACHMENT_PURPOSE = 'project.attachment';

/** Per-tenant attachment records (the files live in the uploads storage). */
@Injectable()
export class AttachmentRepository {
  readonly #rows: {
    tenant: string;
    name: string;
    size: number;
    key: string;
  }[] = [];
  add(tenant: string, file: { name: string; size: number; key: string }) {
    if (this.#rows.length >= 500) throw new ForbiddenException('Storage full');
    this.#rows.push({ tenant, ...file });
  }
  list(tenant: string) {
    return this.#rows
      .filter((row) => row.tenant === tenant)
      .map(({ name, size }) => ({ name, size }));
  }
}

class NamePipe implements PipeTransform<unknown, { name: string }> {
  transform(value: unknown): { name: string } {
    const name: unknown =
      value && typeof value === 'object' ? Reflect.get(value, 'name') : '';
    if (typeof name !== 'string' || name.length > 80)
      throw ActionError.validation('Expected a project name');
    return { name: name.trim() };
  }
}
class SignedPropsPipe implements PipeTransform<
  unknown,
  { props: string; token: string }
> {
  transform(value: unknown): { props: string; token: string } {
    const props: unknown =
      value && typeof value === 'object' ? Reflect.get(value, 'props') : '';
    const token: unknown =
      value && typeof value === 'object' ? Reflect.get(value, 'token') : '';
    if (
      typeof props !== 'string' ||
      typeof token !== 'string' ||
      props.length > 2048 ||
      token.length > 128
    )
      throw ActionError.validation('Expected signed island props');
    return { props, token };
  }
}

/** The tenant of an action call: verified by `actionIdentity`, never input. */
function tenantOf(context: ActionContext): string {
  const tenant = context.identity.tenant;
  if (!tenant) throw ActionError.forbidden('Open a workspace first');
  return tenant;
}

@Injectable()
@ActionGroup('workspace')
export class WorkspaceActions {
  constructor(
    @Inject(ProjectRepository) private readonly projects: ProjectRepository,
    @Inject(ProjectEvents) private readonly events: ProjectEvents,
  ) {}
  @ServerAction({ id: 'projects' })
  list(@ActionContext() context: ActionContext) {
    const tenant = tenantOf(context);
    return {
      tenant,
      projects: this.projects
        .list(tenant)
        .map(({ id, name, status }) => ({ id, name, status })),
    };
  }
  @ServerAction({ id: 'create', concurrency: 'serial' })
  async create(
    @ActionInput(NamePipe) input: { name: string },
    @ActionContext() context: ActionContext,
  ) {
    const tenant = tenantOf(context);
    const error = projectNameError(this.projects, tenant, input.name);
    if (error) throw ActionError.validation(error);
    const project = this.projects.add(tenant, input.name);
    await this.events.changed(tenant);
    return { id: project.id, name: project.name, tenant };
  }
  /**
   * Island round trip: the signature must verify AND the props must describe
   * the caller's own tenant. A valid signature from another tenant's page is
   * refused.
   */
  @ServerAction({ id: 'island-stats' })
  stats(
    @ActionInput(SignedPropsPipe) input: { props: string; token: string },
    @ActionContext() context: ActionContext,
  ) {
    const tenant = tenantOf(context);
    let props: Record<string, unknown>;
    try {
      props = islands.verifyProps('project-stats', input.props, input.token);
    } catch {
      throw ActionError.forbidden('Invalid island props', 'ISLAND_SIGNATURE');
    }
    if (props['tenant'] !== tenant)
      throw ActionError.forbidden('Not your workspace', 'TENANT_MISMATCH');
    const rows = this.projects.list(tenant);
    return { tenant, total: rows.length };
  }
}

/** Inertia report, uploads and the cached summary for one tenant. */
@Controller()
export class WorkspacePages {
  constructor(
    @Inject(Directory) private readonly directory: Directory,
    @Inject(ProjectRepository) private readonly projects: ProjectRepository,
    @Inject(SummaryCache) private readonly summaries: SummaryCache,
    @Inject(UploadsService) private readonly uploads: UploadsService,
    @Inject(AttachmentRepository)
    private readonly attachments: AttachmentRepository,
  ) {}

  /** Inertia page; shared props (user, tenant) come from the request context. */
  @Get('t/:tenant/report')
  @UseGuards(TenantGuard)
  @UseFilters(PageAccessFilter)
  @InertiaPage('Tenant/Report')
  report(@Req() request: object, @Param('tenant') slug: string) {
    const access = this.directory.accessTo(request, String(slug));
    const rows = this.projects.list(access.tenant.slug);
    return {
      tenant: access.tenant.slug,
      projects: rows.map(({ name, status }) => ({ name, status })),
    };
  }

  /** Finalizes an upload token for the tenant named by the guarded route. */
  @Post('t/:tenant/attachments')
  @UseGuards(TenantGuard)
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  async attach(
    @Req() request: object,
    @Param('tenant') slug: string,
    @Body() body: { token?: unknown },
  ) {
    if (!verifyCsrf(request))
      throw new ForbiddenException('Invalid CSRF token');
    const access = this.directory.accessTo(request, String(slug));
    // Upload tokens are bound to the binding that uploaded them, which
    // includes the active tenant: only that tenant's page can finalize them.
    if (
      access.tenant.slug !== this.directory.activeAccess(request)?.tenant.slug
    )
      throw new ForbiddenException('Open this workspace first');
    if (typeof body.token !== 'string')
      throw new ForbiddenException('Missing upload token');
    let file;
    try {
      file = await this.uploads.finalize(request, body.token, {
        purpose: ATTACHMENT_PURPOSE,
      });
    } catch {
      throw new ForbiddenException('This upload cannot be attached here');
    }
    this.attachments.add(access.tenant.slug, file);
    return { name: file.name, size: file.size };
  }

  @Get('api/t/:tenant/attachments')
  @UseGuards(TenantGuard)
  @Header('Cache-Control', 'no-store')
  listAttachments(@Req() request: object, @Param('tenant') slug: string) {
    const access = this.directory.accessTo(request, String(slug));
    return { attachments: this.attachments.list(access.tenant.slug) };
  }

  /** Cached JSON; the guard runs first, so the cache is never consulted cross-tenant. */
  @Get('api/t/:tenant/summary')
  @UseGuards(TenantGuard)
  @Header('Cache-Control', 'no-store')
  async summary(@Req() request: object, @Param('tenant') slug: string) {
    const access = this.directory.accessTo(request, String(slug));
    return {
      summary: await this.summaries.summary(access.tenant.slug),
      metrics: this.summaries.cache.metrics,
    };
  }
}
