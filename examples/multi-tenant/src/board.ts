import {
  BadRequestException,
  ForbiddenException,
  Inject,
} from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
  Action,
  ActionInput,
  Computed,
  LiveComponent,
  OnEvent,
  Reactive,
  State,
  dispatchLiveEvent,
} from 'nestvexa';
import { Directory, ProjectRepository, projectNameError } from './tenancy.js';
import type { Access } from './tenancy.js';

/**
 * Every component re-resolves tenant access from the server session on every
 * request and passes the tenant to the repository. The tenant never comes from
 * browser state, so a component cannot be pointed at another workspace.
 */
function requireAccess(directory: Directory, request: object): Access {
  const access = directory.activeAccess(request);
  if (!access) throw new ForbiddenException();
  return access;
}

const nameField = (value: unknown) =>
  typeof value === 'string' && value.length <= 80;

/** One project row: members rename and toggle status, admins delete. */
@LiveComponent({ name: 'tenant-project', view: 'tenant-project' })
export class TenantProject {
  constructor(
    @Inject(Directory) private readonly directory: Directory,
    @Inject(ProjectRepository) private readonly projects: ProjectRepository,
    @Inject(REQUEST) private readonly request: object,
  ) {}
  @Reactive() @State() projectId = '';
  @Reactive() @State() name = '';
  @Reactive() @State() status = '';
  @State() editing = false;
  @State({ writable: true, validate: nameField }) draft = '';
  @State() error = '';

  @Computed() get canDelete(): boolean {
    return requireAccess(this.directory, this.request).role === 'admin';
  }
  /** Tenant-scoped lookup: a project of another tenant is simply not found. */
  private project(access: Access) {
    const project = this.projects.find(access.tenant.slug, this.projectId);
    if (!project) throw new BadRequestException('Unknown project');
    return project;
  }
  @Action() startEdit(): void {
    const project = this.project(requireAccess(this.directory, this.request));
    this.editing = true;
    this.draft = project.name;
    this.error = '';
  }
  @Action() cancelEdit(): void {
    this.editing = false;
    this.error = '';
  }
  @Action() saveEdit(): void {
    const access = requireAccess(this.directory, this.request);
    this.project(access);
    const name = this.draft.trim();
    const error = projectNameError(
      this.projects,
      access.tenant.slug,
      name,
      this.projectId,
    );
    this.error = error ?? '';
    if (error) return;
    this.projects.update(access.tenant.slug, this.projectId, { name });
    this.editing = false;
    // `name` and `status` are parent-owned props: the board re-renders them.
    dispatchLiveEvent(this, 'project.changed', { id: this.projectId });
  }
  @Action() toggleStatus(): void {
    const access = requireAccess(this.directory, this.request);
    const project = this.project(access);
    this.projects.update(access.tenant.slug, project.id, {
      status: project.status === 'done' ? 'active' : 'done',
    });
    dispatchLiveEvent(this, 'project.changed', { id: this.projectId });
  }
  @Action() remove(): void {
    const access = requireAccess(this.directory, this.request);
    // Defense in depth: the Live policy already refuses this action for members.
    if (access.role !== 'admin')
      throw new ForbiddenException('Only workspace admins can delete');
    if (!this.projects.remove(access.tenant.slug, this.projectId))
      throw new BadRequestException('Unknown project');
    dispatchLiveEvent(this, 'project.changed', { id: this.projectId });
  }
}

interface ProjectReference {
  readonly id: string;
}
/** Event payloads are untrusted input: accept one bounded identifier only. */
class ProjectReferencePipe implements PipeTransform<unknown, ProjectReference> {
  transform(value: unknown): ProjectReference {
    const id: unknown =
      value && typeof value === 'object' && !Array.isArray(value)
        ? Reflect.get(value, 'id')
        : undefined;
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(id))
      throw new BadRequestException('Expected a project reference');
    return { id };
  }
}

/** The tenant's project board. */
@LiveComponent({
  name: 'tenant-board',
  view: 'tenant-board',
  children: { row: TenantProject },
})
export class TenantBoard {
  constructor(
    @Inject(Directory) private readonly directory: Directory,
    @Inject(ProjectRepository) private readonly projects: ProjectRepository,
    @Inject(REQUEST) private readonly request: object,
  ) {}
  @State({ writable: true, validate: nameField }) draftName = '';
  @State() error = '';
  @State() message = '';
  @State() changes = 0;

  @Computed() get workspace(): { name: string; role: string } {
    const access = requireAccess(this.directory, this.request);
    return { name: access.tenant.name, role: access.role };
  }
  @Computed() get rows() {
    const access = requireAccess(this.directory, this.request);
    return this.projects
      .list(access.tenant.slug)
      .map(({ id, name, status }) => ({ id, name, status }));
  }
  @Action() create(): void {
    const access = requireAccess(this.directory, this.request);
    const name = this.draftName.trim();
    const error = projectNameError(this.projects, access.tenant.slug, name);
    this.error = error ?? '';
    if (error) {
      this.message = '';
      return;
    }
    this.projects.add(access.tenant.slug, name);
    this.draftName = '';
    this.message = `${name} was created.`;
    this.changes++;
  }
  /** A row changed or was deleted: re-render the list from the repository. */
  @Action()
  @OnEvent('project.changed')
  changed(@ActionInput(ProjectReferencePipe) input: ProjectReference): void {
    const access = requireAccess(this.directory, this.request);
    this.message = this.projects.find(access.tenant.slug, input.id)
      ? 'Project updated.'
      : 'Project deleted.';
    this.changes++;
  }
}
