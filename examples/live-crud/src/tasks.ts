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
  LiveComponent,
  OnEvent,
  Reactive,
  State,
  Url,
  dispatchLiveEvent,
  paginate,
} from 'nestvexa';
import type { LiveLifecycleHooks, LiveUpdateContext } from 'nestvexa';
import { errorSummary, formView, zodAdapter } from '@nestvexa/forms';
import { validateLive } from '@nestvexa/forms/live';
import { z } from 'zod';

export const priorities = ['low', 'medium', 'high'] as const;
export type Priority = (typeof priorities)[number];
export interface Task {
  readonly id: string;
  readonly title: string;
  readonly assignee: string;
  readonly priority: Priority;
  /** `YYYY-MM-DD` or `''`. */
  readonly due: string;
  readonly done: boolean;
}
export type TaskInput = Omit<Task, 'id' | 'done'>;

const seed: readonly Omit<Task, 'id'>[] = [
  ['Draft the release notes', 'Ada', 'high', '2026-11-10', false],
  ['Review the onboarding flow', 'Grace', 'medium', '2026-11-12', false],
  ['Archive old invoices', 'Linus', 'low', '', true],
  ['Prepare the quarterly demo', 'Ada', 'high', '2026-11-20', false],
  ['Update the support macros', 'Margaret', 'low', '2026-12-01', false],
  ['Fix the flaky export job', 'Linus', 'high', '2026-11-08', true],
  ['Plan the team offsite', 'Grace', 'medium', '2026-12-05', false],
  ['Rotate staging credentials', 'Margaret', 'high', '2026-11-15', false],
  ['Translate the help center', 'Ada', 'medium', '', false],
  ['Clean up feature flags', 'Linus', 'low', '2026-11-30', false],
  ['Interview design candidates', 'Grace', 'medium', '2026-11-18', true],
  ['Write the incident review', 'Margaret', 'medium', '2026-11-09', false],
].map(([title, assignee, priority, due, done]) => ({
  title: String(title),
  assignee: String(assignee),
  priority: priority as Priority,
  due: String(due),
  done: done === true,
}));

/**
 * Demonstration repository: one task list per guest session in process
 * memory. A real host uses its database here and checks ownership the same
 * way: every method takes the owner from the server-side identity.
 */
@Injectable()
export class TaskRepository {
  readonly #tasks = new Map<string, Task[]>();
  #next = 1;
  list(owner: string): readonly Task[] {
    let tasks = this.#tasks.get(owner);
    if (!tasks) {
      if (this.#tasks.size >= 1000) this.#tasks.clear();
      tasks = seed.map((task) => ({ ...task, id: this.#id() }));
      this.#tasks.set(owner, tasks);
    }
    return tasks;
  }
  find(owner: string, id: string): Task | undefined {
    return this.list(owner).find((task) => task.id === id);
  }
  add(owner: string, input: TaskInput): Task {
    const tasks = this.list(owner);
    if (tasks.length >= 200)
      throw new BadRequestException('Task limit reached');
    const task: Task = { ...input, id: this.#id(), done: false };
    this.#tasks.set(owner, [...tasks, task]);
    return task;
  }
  update(owner: string, id: string, change: Partial<Omit<Task, 'id'>>): Task {
    const current = this.find(owner, id);
    if (!current) throw new BadRequestException('Unknown task');
    const next = { ...current, ...change };
    this.#tasks.set(
      owner,
      this.list(owner).map((task) => (task.id === id ? next : task)),
    );
    return next;
  }
  remove(owner: string, id: string): Task | undefined {
    const current = this.find(owner, id);
    if (current)
      this.#tasks.set(
        owner,
        this.list(owner).filter((task) => task.id !== id),
      );
    return current;
  }
  #id(): string {
    return `t${(this.#next++).toString(36)}`;
  }
}
/** Host-owned provider module imported by the Live registration. */
@Module({ providers: [TaskRepository], exports: [TaskRepository] })
export class TasksModule {}

export function ownerOf(request: unknown): string {
  const id: unknown =
    request && typeof request === 'object'
      ? Reflect.get(request, 'sessionID')
      : undefined;
  if (typeof id !== 'string' || !id) throw new UnauthorizedException();
  return `guest-session:${id}`;
}

/** One schema for create and edit; the product rules live here. */
export const taskSchema = z.object({
  title: z
    .string()
    .trim()
    .min(3, 'Enter at least 3 characters.')
    .max(80, 'Keep the title under 80 characters.'),
  assignee: z.string().trim().max(40, 'Keep the assignee under 40 characters.'),
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
});
const taskAdapter = zodAdapter(taskSchema);
const fields = ['title', 'assignee', 'priority', 'due'] as const;
const labels = {
  title: 'Title',
  assignee: 'Assignee',
  priority: 'Priority',
  due: 'Due date',
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

/**
 * Create/edit form rendered as a modal dialog by the board. The task id is a
 * parent-owned prop inside the signed snapshot, so the browser cannot point
 * the editor at another task. `new` means create.
 */
@LiveComponent({ name: 'task-editor', view: 'task-editor' })
export class TaskEditor {
  constructor(
    @Inject(TaskRepository) private readonly tasks: TaskRepository,
    @Inject(REQUEST) private readonly request: unknown,
  ) {}
  @Reactive() @State() taskId = 'new';
  @State({ writable: true, validate: text(200) }) title = '';
  @State({ writable: true, validate: text(200) }) assignee = '';
  @State({ writable: true, validate: text(20) }) priority = 'medium';
  @State({ writable: true, validate: text(20) }) due = '';
  @State() errors: Record<string, string[]> = {};
  mount(): void {
    if (this.taskId === 'new') return;
    const task = this.tasks.find(ownerOf(this.request), this.taskId);
    if (!task) throw new BadRequestException('Unknown task');
    this.title = task.title;
    this.assignee = task.assignee;
    this.priority = task.priority;
    this.due = task.due;
  }
  @Computed() get creating(): boolean {
    return this.taskId === 'new';
  }
  @Computed() get fields() {
    return formView(this.errors, [...fields], { idPrefix: 'task-' });
  }
  @Computed() get summary() {
    return errorSummary(this.errors, {
      idPrefix: 'task-',
      labels,
      order: [...fields],
    });
  }
  @Computed() get priorityOptions() {
    return priorities.map((value) => ({
      value,
      selected: value === this.priority,
    }));
  }
  @Action() async save(): Promise<void> {
    const result = await validateLive(this, taskAdapter, [...fields]);
    if (!result.ok) return;
    const owner = ownerOf(this.request);
    const task =
      this.taskId === 'new'
        ? this.tasks.add(owner, result.value)
        : this.tasks.update(owner, this.taskId, result.value);
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
 * toggle can be projected optimistically and rolled back on failure.
 */
@LiveComponent({ name: 'task-row', view: 'task-row' })
export class TaskRow {
  constructor(
    @Inject(TaskRepository) private readonly tasks: TaskRepository,
    @Inject(REQUEST) private readonly request: unknown,
  ) {}
  @Reactive() @State() taskId = '';
  @Reactive() @State() title = '';
  @Reactive() @State() assignee = '';
  @Reactive() @State() priority = '';
  @Reactive() @State() due = '';
  @State() done = false;
  mount(): void {
    this.done =
      this.tasks.find(ownerOf(this.request), this.taskId)?.done ?? false;
  }
  @Action() async toggleDone(): Promise<void> {
    // A small delay makes the optimistic projection visible in the demo.
    await new Promise((resolve) => setTimeout(resolve, 150));
    this.done = !this.done;
    this.tasks.update(ownerOf(this.request), this.taskId, { done: this.done });
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
  @Action() remove(): void {
    if (!this.tasks.remove(ownerOf(this.request), this.taskId))
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

@LiveComponent({
  name: 'task-board',
  view: 'task-board',
  children: { row: TaskRow, editor: TaskEditor },
})
export class TaskBoard implements LiveLifecycleHooks {
  constructor(
    @Inject(TaskRepository) private readonly tasks: TaskRepository,
    @Inject(REQUEST) private readonly request: unknown,
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

  /** Changing a filter returns to the first page. */
  afterUpdate(update: LiveUpdateContext): void {
    if (['query', 'status', 'priority'].includes(update.field)) this.page = 1;
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
    return this.tasks
      .list(ownerOf(this.request))
      .filter(
        (task) =>
          (!query ||
            task.title.toLowerCase().includes(query) ||
            task.assignee.toLowerCase().includes(query)) &&
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
  @Computed() get rows(): Task[] {
    const page = this.pagination;
    return this.#visible().slice(page.offset, page.offset + page.perPage);
  }
  @Computed() get counts() {
    const all = this.tasks.list(ownerOf(this.request));
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
      return '/tasks' + (search ? '?' + search : '');
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
  /** `aria-pressed` values for the sort buttons. */
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
    if (!this.tasks.find(ownerOf(this.request), input.id))
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
    const task = this.tasks.find(ownerOf(this.request), input.id);
    if (!task) return;
    this.notice = `${this.editing === 'new' ? 'Created' : 'Saved'} “${task.title}”.`;
    this.editing = '';
    this.revision++;
  }
  @Action()
  @OnEvent('task.removed')
  removed(@ActionInput(TaskReferencePipe) input: TaskReference): void {
    if (this.tasks.find(ownerOf(this.request), input.id)) return;
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
