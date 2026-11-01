import {
  BadRequestException,
  Inject,
  Injectable,
  Module,
  UnauthorizedException,
} from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
  Action,
  ActionInput,
  Computed,
  DateSynthesizer,
  LiveComponent,
  OnEvent,
  Reactive,
  State,
  Url,
  dispatchLiveEvent,
  downloadLive,
  flashLive,
  paginate,
  redirectLive,
} from 'nestvexa';

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly status: 'planned' | 'active' | 'done';
  readonly starred: boolean;
}
const seed: readonly Project[] = [
  'Atlas',
  'Beacon',
  'Cobalt',
  'Delta',
  'Ember',
  'Fjord',
  'Granite',
].map((name, index) => ({
  id: name.toLowerCase(),
  name,
  status: (['planned', 'active', 'done'] as const)[index % 3] ?? 'planned',
  starred: false,
}));

/**
 * Demonstration repository: per guest session, in process memory. A real host
 * uses its database and resource-level authorization here.
 */
@Injectable()
export class ProjectRepository {
  readonly #projects = new Map<string, Project[]>();
  list(owner: string): readonly Project[] {
    let projects = this.#projects.get(owner);
    if (!projects) {
      if (this.#projects.size >= 1000) this.#projects.clear();
      projects = seed.map((project) => ({ ...project }));
      this.#projects.set(owner, projects);
    }
    return projects;
  }
  add(owner: string, name: string, status: Project['status']): Project {
    const projects = [...this.list(owner)];
    if (projects.length >= 50)
      throw new BadRequestException('Project limit reached');
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 24);
    let id = base || 'project';
    for (let suffix = 2; projects.some((item) => item.id === id); suffix++)
      id = `${base}-${suffix}`;
    const project: Project = { id, name, status, starred: false };
    this.#projects.set(owner, [...projects, project]);
    return project;
  }
  update(
    owner: string,
    id: string,
    change: Partial<Omit<Project, 'id'>>,
  ): void {
    this.#projects.set(
      owner,
      this.list(owner).map((item) =>
        item.id === id ? { ...item, ...change } : item,
      ),
    );
  }
  remove(owner: string, id: string): boolean {
    const before = this.list(owner);
    const after = before.filter((item) => item.id !== id);
    this.#projects.set(owner, after);
    return after.length !== before.length;
  }
}
/** Host-owned provider module imported by the Live registration. */
@Module({ providers: [ProjectRepository], exports: [ProjectRepository] })
export class ProjectsModule {}
function owner(request: unknown): string {
  const id: unknown =
    request && typeof request === 'object'
      ? Reflect.get(request, 'sessionID')
      : undefined;
  if (typeof id !== 'string' || !id) throw new UnauthorizedException();
  return id;
}

interface ProjectReference {
  readonly id: string;
}
class ProjectReferencePipe implements PipeTransform<unknown, ProjectReference> {
  transform(value: unknown): ProjectReference {
    const id: unknown =
      value && typeof value === 'object' && !Array.isArray(value)
        ? Reflect.get(value, 'id')
        : undefined;
    if (
      Object.keys(value ?? {}).length !== 1 ||
      typeof id !== 'string' ||
      !/^[a-z0-9-]{1,32}$/.test(id)
    )
      throw new BadRequestException('Expected a project reference');
    return { id };
  }
}

/** One row. The board owns name/status; the row owns its star toggle. */
@LiveComponent({ name: 'project-row', view: 'project-row' })
export class ProjectRow {
  constructor(
    @Inject(ProjectRepository) private readonly projects: ProjectRepository,
    @Inject(REQUEST) private readonly request: unknown,
  ) {}
  @Reactive() @State() projectId = '';
  @Reactive() @State() name = '';
  @Reactive() @State() status = '';
  @State() starred = false;
  mount(): void {
    this.starred =
      this.projects
        .list(owner(this.request))
        .find((item) => item.id === this.projectId)?.starred ?? false;
  }
  @Action() toggleStar(): void {
    this.starred = !this.starred;
    this.projects.update(owner(this.request), this.projectId, {
      starred: this.starred,
    });
  }
  @Action() remove(): void {
    if (!this.projects.remove(owner(this.request), this.projectId))
      throw new BadRequestException('Unknown project');
    dispatchLiveEvent(this, 'project.removed', { id: this.projectId });
    dispatchLiveEvent(this, 'toast', `${this.name} was deleted`);
  }
}

/** Polite status region updated by events from any component. */
@LiveComponent({ name: 'project-toast', view: 'project-toast' })
export class ProjectToast {
  @State() message = '';
  @Action()
  @OnEvent('toast')
  show(
    @ActionInput({
      transform(value: unknown): string {
        if (typeof value !== 'string' || value.length > 120)
          throw new BadRequestException('Invalid toast');
        return value;
      },
    })
    message: string,
  ): void {
    this.message = message;
  }
}

const statuses = ['planned', 'active', 'done'] as const;
@LiveComponent({
  name: 'project-board',
  view: 'project-board',
  children: { row: ProjectRow, toast: ProjectToast },
})
export class ProjectBoard {
  constructor(
    @Inject(ProjectRepository) private readonly projects: ProjectRepository,
    @Inject(REQUEST) private readonly request: unknown,
  ) {}
  @Url({ key: 'q', history: 'replace', except: '' })
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 40,
  })
  query = '';
  @Url({ key: 'sort', history: 'replace', except: 'name' })
  @State({
    writable: true,
    validate: (value) => value === 'name' || value === 'status',
  })
  sort = 'name';
  @Url({ key: 'page', history: 'push', except: 1 })
  @State({
    writable: true,
    validate: (value) =>
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 1 &&
      value <= 1000,
  })
  page = 1;
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 80,
  })
  draftName = '';
  @State({
    writable: true,
    validate: (value) =>
      typeof value === 'string' &&
      (statuses as readonly string[]).includes(value),
  })
  draftStatus = 'planned';
  @State() errors: Record<string, string> = {};
  @State({ synthesizer: DateSynthesizer }) updatedAt = new Date(
    '2026-11-01T00:00:00.000Z',
  );
  @State() revision = 0;

  private visible(): Project[] {
    const query = this.query.trim().toLowerCase();
    return this.projects
      .list(owner(this.request))
      .filter((project) => !query || project.name.toLowerCase().includes(query))
      .sort((left, right) =>
        this.sort === 'status'
          ? left.status.localeCompare(right.status) ||
            left.name.localeCompare(right.name)
          : left.name.localeCompare(right.name),
      );
  }
  @Computed() get pagination() {
    return paginate({
      page: this.page,
      perPage: 4,
      total: this.visible().length,
    });
  }
  @Computed() get rows(): Project[] {
    const page = this.pagination;
    return this.visible().slice(page.offset, page.offset + page.perPage);
  }
  /** Server-built query strings keep links working without JavaScript. */
  @Computed() get pageLinks() {
    return this.pagination.links.map((link) => {
      if (link.gap) return { gap: true, href: '', label: '…', current: false };
      const query = new URLSearchParams();
      if (this.query) query.set('q', this.query);
      if (this.sort !== 'name') query.set('sort', this.sort);
      if (link.page > 1) query.set('page', String(link.page));
      const search = query.toString();
      return {
        gap: false,
        href: '/projects' + (search ? '?' + search : ''),
        label: String(link.page),
        current: link.current,
      };
    });
  }
  @Computed() get updatedLabel(): string {
    return this.updatedAt.toISOString().slice(0, 10);
  }
  private touch(): void {
    this.updatedAt = new Date();
    this.revision++;
  }
  @Action() sortByName(): void {
    this.sort = 'name';
    this.page = 1;
  }
  @Action() sortByStatus(): void {
    this.sort = 'status';
    this.page = 1;
  }
  @Action() search(): void {
    this.page = 1;
  }
  @Action() create(): void {
    const name = this.draftName.trim();
    const errors: Record<string, string> = {};
    if (name.length < 2) errors['name'] = 'Enter at least 2 characters.';
    else if (
      this.projects
        .list(owner(this.request))
        .some((item) => item.name.toLowerCase() === name.toLowerCase())
    )
      errors['name'] = 'A project with this name already exists.';
    this.errors = errors;
    if (Object.keys(errors).length) return;
    const status =
      statuses.find((item) => item === this.draftStatus) ?? 'planned';
    this.projects.add(owner(this.request), name, status);
    this.draftName = '';
    this.draftStatus = 'planned';
    this.touch();
    dispatchLiveEvent(this, 'toast', `${name} was created`);
  }
  @Action()
  @OnEvent('project.removed')
  removed(@ActionInput(ProjectReferencePipe) input: ProjectReference): void {
    // Event payloads are untrusted: only react if the project is really gone.
    if (
      this.projects
        .list(owner(this.request))
        .some((project) => project.id === input.id)
    )
      return;
    this.page = this.pagination.page;
    this.touch();
  }
  @Action() exportCsv(): void {
    const cell = (value: string) =>
      /^[=+\-@]/.test(value) ? `'${value}` : value.replaceAll('"', '""');
    const lines = this.visible().map(
      (project) =>
        `"${cell(project.name)}","${project.status}","${project.starred}"`,
    );
    downloadLive(this, {
      filename: 'projects.csv',
      contentType: 'text/csv; charset=utf-8',
      body: ['"name","status","starred"', ...lines].join('\r\n') + '\r\n',
    });
  }
  @Action() archiveDone(): void {
    const done = this.projects
      .list(owner(this.request))
      .filter((item) => item.status === 'done');
    for (const project of done)
      this.projects.remove(owner(this.request), project.id);
    flashLive(this, `Archived ${done.length} completed projects.`);
    redirectLive(this, '/projects');
  }
}
