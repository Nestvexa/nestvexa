import { BadRequestException, Inject } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { errorSummary, formView, zodAdapter } from '@nestvexa/forms';
import { validateLive } from '@nestvexa/forms/live';
import { RealtimeService } from '@nestvexa/realtime';
import {
  UploadError,
  UploadsService,
  parseUploadReferences,
  uploadReferenceField,
} from '@nestvexa/uploads';
import {
  Action,
  ActionInput,
  Computed,
  LiveComponent,
  OnEvent,
  Reactive,
  State,
  Url,
  dispatchLiveEvent,
  paginate,
} from 'nestvexa';
import type { LiveLifecycleHooks, LiveUpdateContext } from 'nestvexa';
import { z } from 'zod';
import { ShowcaseData } from './data.js';
import { Directory, metricsChannel } from './identity.js';
import type { Access } from './identity.js';
import { SharedState } from './metrics.js';
import { Notifier } from './notify.js';
import { priorities } from './seed.js';
import type { Priority, StoredFile, Task } from './seed.js';

/** The browser client names a purpose `<component>.<field>` for `nv:upload`. */
export const attachmentPurpose = 'task-editor.attachment';

/** One schema for create and edit; membership of the assignee is checked after it. */
const taskAdapter = zodAdapter(
  z.object({
    title: z
      .string()
      .trim()
      .min(3, 'Enter at least 3 characters.')
      .max(80, 'Keep the title under 80 characters.'),
    assignee: z.string().max(20),
    priority: z.enum(priorities, { message: 'Choose a priority.' }),
    due: z
      .string()
      .trim()
      .refine(
        (value) =>
          value === '' ||
          (/^\d{4}-\d{2}-\d{2}$/.test(value) &&
            !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
            new Date(`${value}T00:00:00Z`).toISOString().startsWith(value)),
        'Enter a real date as YYYY-MM-DD, or leave it empty.',
      ),
  }),
);
const fields = ['title', 'assignee', 'priority', 'due'] as const;
const labels = {
  title: 'Title',
  assignee: 'Assignee',
  priority: 'Priority',
  due: 'Due date',
  attachment: 'Attachment',
};

interface TaskReference {
  readonly id: string;
}
/** Event payloads cross the browser: accept exactly `{ id }` with a safe id. */
class TaskReferencePipe implements PipeTransform<unknown, TaskReference> {
  transform(value: unknown): TaskReference {
    const id: unknown =
      value && typeof value === 'object' && !Array.isArray(value)
        ? Reflect.get(value, 'id')
        : undefined;
    if (
      Object.keys(value ?? {}).length !== 1 ||
      typeof id !== 'string' ||
      !/^t[a-z0-9]{1,12}$/.test(id)
    )
      throw new BadRequestException('Expected a task reference');
    return { id };
  }
}

const text = (max: number) => (value: unknown) =>
  typeof value === 'string' && value.length <= max;

/** The task change events every board listens to. */
async function announce(
  shared: SharedState,
  realtime: RealtimeService,
  access: Access,
  metric: 'created' | 'completed',
  by: number,
  last: string,
): Promise<void> {
  await shared.increment(access.workspace.slug, metric, by, last);
  await realtime.publish(metricsChannel(access.workspace.slug), null);
}

/**
 * Create/edit dialog rendered by the board (a nested child component). The
 * task id is a parent-owned prop inside the signed snapshot, so the browser
 * cannot point the editor at another task or workspace.
 */
@LiveComponent({ name: 'task-editor', view: 'task-editor' })
export class TaskEditor {
  constructor(
    @Inject(ShowcaseData) private readonly data: ShowcaseData,
    @Inject(Directory) private readonly directory: Directory,
    @Inject(UploadsService) private readonly uploads: UploadsService,
    @Inject(SharedState) private readonly shared: SharedState,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
    @Inject(Notifier) private readonly notifier: Notifier,
    @Inject(REQUEST) private readonly request: object,
  ) {}
  @Reactive() @State() taskId = 'new';
  @State({ writable: true, validate: text(200) }) title = '';
  @State({ writable: true, validate: text(20) }) assignee = '';
  @State({ writable: true, validate: text(20) }) priority = 'medium';
  @State({ writable: true, validate: text(20) }) due = '';
  /** Temporary upload reference set by `nv:upload="attachment"`. */
  @State({ writable: true, validate: uploadReferenceField({ max: 1 }) })
  attachment = '';
  @State() existingAttachment = '';
  @State() errors: Record<string, string[]> = {};

  #access(): Access {
    return this.directory.require(this.request);
  }
  mount(): void {
    if (this.taskId === 'new') return;
    const task = this.data.task(this.#access().workspace.slug, this.taskId);
    if (!task) throw new BadRequestException('Unknown task');
    this.title = task.title;
    this.assignee = task.assignee;
    this.priority = task.priority;
    this.due = task.due;
    this.existingAttachment = task.attachment?.name ?? '';
  }
  @Computed() get creating(): boolean {
    return this.taskId === 'new';
  }
  @Computed() get fields() {
    return formView(this.errors, [...fields, 'attachment'], {
      idPrefix: 'task-',
    });
  }
  @Computed() get summary() {
    return errorSummary(this.errors, {
      idPrefix: 'task-',
      labels,
      order: [...fields, 'attachment'],
    });
  }
  @Computed() get priorityOptions() {
    return priorities.map((value) => ({
      value,
      selected: value === this.priority,
    }));
  }
  @Computed() get assigneeOptions() {
    return [
      { value: '', label: 'Unassigned', selected: this.assignee === '' },
      ...this.directory
        .members(this.#access().workspace.slug)
        .map((member) => ({
          value: member.id,
          label: member.name,
          selected: member.id === this.assignee,
        })),
    ];
  }
  @Action() async save(): Promise<void> {
    const result = await validateLive(this, taskAdapter, [...fields]);
    if (!result.ok) return;
    const access = this.#access();
    const workspace = access.workspace.slug;
    // The assignee must be a member of this workspace: never another tenant's account.
    const assignee = result.value.assignee
      ? this.directory.account(result.value.assignee)
      : undefined;
    if (result.value.assignee && assignee?.workspace !== workspace) {
      this.errors = { assignee: ['Choose a member of this workspace.'] };
      return;
    }
    let attachment: StoredFile | undefined;
    const [token] = parseUploadReferences(this.attachment, 1);
    if (token) {
      try {
        // Re-checks identity, purpose, expiry, size, hash and content type.
        const file = await this.uploads.finalize(this.request, token, {
          purpose: attachmentPurpose,
        });
        attachment = {
          key: file.key,
          name: file.name,
          contentType: file.contentType,
          size: file.size,
          sha256: file.sha256,
        };
      } catch (error) {
        this.attachment = '';
        if (!(error instanceof UploadError)) throw error;
        this.errors = { attachment: [`The file was refused (${error.code}).`] };
        return;
      }
    }
    const input = {
      title: result.value.title,
      assignee: assignee?.id ?? '',
      priority: result.value.priority as Priority,
      due: result.value.due,
      ...(attachment ? { attachment } : {}),
    };
    const previous =
      this.taskId === 'new'
        ? undefined
        : this.data.task(workspace, this.taskId);
    const task =
      this.taskId === 'new'
        ? this.data.addTask(workspace, input)
        : this.data.updateTask(workspace, this.taskId, input);
    this.attachment = '';
    if (!previous)
      await announce(
        this.shared,
        this.realtime,
        access,
        'created',
        1,
        `${access.user.name} created “${task.title}”`,
      );
    // Notify a newly assigned teammate (never the person who assigned it).
    if (
      assignee &&
      assignee.id !== access.user.id &&
      previous?.assignee !== assignee.id
    )
      await this.notifier.notify(assignee, {
        type: 'task.assigned',
        data: {
          summary: `${access.user.name} assigned you “${task.title}”`,
          title: task.title,
          by: access.user.name,
          due: task.due || 'no due date',
        },
      });
    dispatchLiveEvent(
      this,
      'task.saved',
      { id: task.id },
      { to: 'task-board' },
    );
  }
  @Action() cancel(): void {
    dispatchLiveEvent(this, 'task.editor-closed', null, { to: 'task-board' });
  }
}

/**
 * One row. The board owns the displayed fields; the row owns `done`, so the
 * toggle is projected optimistically and rolled back if the action fails.
 */
@LiveComponent({ name: 'task-row', view: 'task-row' })
export class TaskRow {
  constructor(
    @Inject(ShowcaseData) private readonly data: ShowcaseData,
    @Inject(Directory) private readonly directory: Directory,
    @Inject(SharedState) private readonly shared: SharedState,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
    @Inject(REQUEST) private readonly request: object,
  ) {}
  @Reactive() @State() taskId = '';
  @Reactive() @State() title = '';
  @Reactive() @State() assigneeName = '';
  @Reactive() @State() priority = '';
  @Reactive() @State() due = '';
  @Reactive() @State() attachmentName = '';
  @State() done = false;
  @State() admin = false;
  mount(): void {
    const access = this.directory.require(this.request);
    this.done =
      this.data.task(access.workspace.slug, this.taskId)?.done ?? false;
    this.admin = access.role === 'admin';
  }
  @Action() async toggleDone(): Promise<void> {
    const access = this.directory.require(this.request);
    const task = this.data.task(access.workspace.slug, this.taskId);
    if (!task) throw new BadRequestException('Unknown task');
    // A short delay makes the optimistic projection visible in the demo.
    await new Promise((resolve) => setTimeout(resolve, 150));
    this.done = !task.done;
    this.data.updateTask(access.workspace.slug, this.taskId, {
      done: this.done,
    });
    this.data.recordCompletion(access.workspace.slug, this.done ? 1 : -1);
    await announce(
      this.shared,
      this.realtime,
      access,
      'completed',
      this.done ? 1 : -1,
      `${access.user.name} ${this.done ? 'completed' : 'reopened'} “${task.title}”`,
    );
    dispatchLiveEvent(this, 'task.changed', null, { to: 'task-board' });
  }
  @Action() edit(): void {
    dispatchLiveEvent(
      this,
      'task.edit',
      { id: this.taskId },
      { to: 'task-board' },
    );
  }
  /** Admin only: enforced by the Live `authorize` policy from the binding's role. */
  @Action() remove(): void {
    const access = this.directory.require(this.request);
    if (!this.data.removeTask(access.workspace.slug, this.taskId))
      throw new BadRequestException('Unknown task');
    dispatchLiveEvent(
      this,
      'task.removed',
      { id: this.taskId },
      { to: 'task-board' },
    );
  }
}

const sorts = ['title', 'due', 'priority'] as const;
const statuses = ['all', 'open', 'done'] as const;
const priorityRank: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
const oneOf =
  (values: readonly string[]) =>
  (value: unknown): boolean =>
    typeof value === 'string' && values.includes(value);

/** `/app/tasks`: the workspace task board. */
@LiveComponent({
  name: 'task-board',
  view: 'task-board',
  children: { row: TaskRow, editor: TaskEditor },
})
export class TaskBoard implements LiveLifecycleHooks {
  constructor(
    @Inject(ShowcaseData) private readonly data: ShowcaseData,
    @Inject(Directory) private readonly directory: Directory,
    @Inject(REQUEST) private readonly request: object,
  ) {}
  @Url({ key: 'q', history: 'replace', except: '' })
  @State({ writable: true, validate: text(40) })
  query = '';
  @Url({ key: 'status', history: 'replace', except: 'all' })
  @State({ writable: true, validate: oneOf(statuses) })
  status = 'all';
  @Url({ key: 'priority', history: 'replace', except: 'any' })
  @State({ writable: true, validate: oneOf(['any', ...priorities]) })
  priority = 'any';
  @Url({ key: 'sort', history: 'replace', except: 'due' })
  @State({ writable: true, validate: oneOf(sorts) })
  sort = 'due';
  @Url({ key: 'dir', history: 'replace', except: 'asc' })
  @State({ writable: true, validate: oneOf(['asc', 'desc']) })
  dir = 'asc';
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
  /** `''` (closed), `new`, or the id of the task being edited. */
  @State() editing = '';
  @State() notice = '';
  @State() revision = 0;

  #workspace(): string {
    return this.directory.require(this.request).workspace.slug;
  }
  afterUpdate(update: LiveUpdateContext): void {
    if (['query', 'status', 'priority'].includes(update.field)) this.page = 1;
  }
  #name(id: string): string {
    return id ? (this.directory.account(id)?.name ?? '') : '';
  }
  #visible(): Task[] {
    const query = this.query.trim().toLowerCase();
    const direction = this.dir === 'desc' ? -1 : 1;
    const compare = (left: Task, right: Task): number => {
      if (this.sort === 'priority')
        return priorityRank[left.priority] - priorityRank[right.priority];
      if (this.sort === 'due')
        // Tasks without a due date sort last in both directions.
        return (
          (left.due === '' ? 1 : 0) - (right.due === '' ? 1 : 0) ||
          left.due.localeCompare(right.due) * direction
        );
      return left.title.localeCompare(right.title);
    };
    return this.data
      .tasks(this.#workspace())
      .filter(
        (task) =>
          (!query ||
            task.title.toLowerCase().includes(query) ||
            this.#name(task.assignee).toLowerCase().includes(query)) &&
          (this.status === 'all' || task.done === (this.status === 'done')) &&
          (this.priority === 'any' || task.priority === this.priority),
      )
      .sort((left, right) => {
        const primary = compare(left, right);
        const ordered = this.sort === 'due' ? primary : primary * direction;
        return ordered || left.title.localeCompare(right.title);
      });
  }
  @Computed() get pagination() {
    return paginate({
      page: this.page,
      perPage: 5,
      total: this.#visible().length,
    });
  }
  @Computed() get rows() {
    const page = this.pagination;
    return this.#visible()
      .slice(page.offset, page.offset + page.perPage)
      .map((task) => ({
        id: task.id,
        title: task.title,
        assigneeName: this.#name(task.assignee),
        priority: task.priority,
        due: task.due,
        attachmentName: task.attachment?.name ?? '',
      }));
  }
  @Computed() get counts() {
    const all = this.data.tasks(this.#workspace());
    const done = all.filter((task) => task.done).length;
    return { total: all.length, done, open: all.length - done };
  }
  /** Server-built query strings keep page links working without JavaScript. */
  @Computed() get pageLinks() {
    const href = (page: number) => {
      const query = new URLSearchParams();
      if (this.query) query.set('q', this.query);
      if (this.status !== 'all') query.set('status', this.status);
      if (this.priority !== 'any') query.set('priority', this.priority);
      if (this.sort !== 'due') query.set('sort', this.sort);
      if (this.dir !== 'asc') query.set('dir', this.dir);
      if (page > 1) query.set('page', String(page));
      const search = query.toString();
      return '/app/tasks' + (search ? '?' + search : '');
    };
    const pagination = this.pagination;
    return {
      previous: pagination.previous === null ? '' : href(pagination.previous),
      next: pagination.next === null ? '' : href(pagination.next),
      pages: pagination.links.map((link) =>
        link.page === null
          ? { gap: true, href: '', label: '…', current: false }
          : {
              gap: false,
              href: href(link.page),
              label: String(link.page),
              current: link.current,
            },
      ),
    };
  }
  @Computed() get pressed() {
    return Object.fromEntries(
      sorts.map((field) => [field, this.sort === field ? 'true' : 'false']),
    );
  }
  @Computed() get statusOptions() {
    return [
      { value: 'all', label: 'All' },
      { value: 'open', label: 'Open' },
      { value: 'done', label: 'Done' },
    ].map((option) => ({ ...option, selected: option.value === this.status }));
  }
  @Computed() get priorityOptions() {
    return [
      { value: 'any', label: 'Any' },
      { value: 'high', label: 'High' },
      { value: 'medium', label: 'Medium' },
      { value: 'low', label: 'Low' },
    ].map((option) => ({
      ...option,
      selected: option.value === this.priority,
    }));
  }
  #sortBy(field: (typeof sorts)[number]): void {
    this.dir = this.sort === field && this.dir === 'asc' ? 'desc' : 'asc';
    this.sort = field;
    this.page = 1;
  }
  @Action() sortTitle(): void {
    this.#sortBy('title');
  }
  @Action() sortDue(): void {
    this.#sortBy('due');
  }
  @Action() sortPriority(): void {
    this.#sortBy('priority');
  }
  @Action() applyFilters(): void {
    this.page = 1;
  }
  @Action() clearFilters(): void {
    this.query = '';
    this.status = 'all';
    this.priority = 'any';
    this.page = 1;
  }
  @Action() newTask(): void {
    this.editing = 'new';
    this.notice = '';
  }
  @Action()
  @OnEvent('task.edit')
  openEditor(@ActionInput(TaskReferencePipe) input: TaskReference): void {
    if (!this.data.task(this.#workspace(), input.id))
      throw new BadRequestException('Unknown task');
    this.editing = input.id;
    this.notice = '';
  }
  @Action()
  @OnEvent('task.editor-closed')
  editorClosed(): void {
    this.editing = '';
  }
  @Action()
  @OnEvent('task.saved')
  saved(@ActionInput(TaskReferencePipe) input: TaskReference): void {
    // Untrusted payload: announce only what the repository confirms.
    const task = this.data.task(this.#workspace(), input.id);
    if (!task) return;
    this.notice = `${this.editing === 'new' ? 'Created' : 'Saved'} “${task.title}”.`;
    this.editing = '';
    this.revision++;
  }
  @Action()
  @OnEvent('task.removed')
  removed(@ActionInput(TaskReferencePipe) input: TaskReference): void {
    if (this.data.task(this.#workspace(), input.id)) return;
    this.notice = 'Task deleted.';
    this.page = this.pagination.page;
    this.revision++;
  }
  @Action()
  @OnEvent('task.changed')
  changed(): void {
    this.revision++;
  }
}
