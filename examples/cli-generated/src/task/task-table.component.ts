import { Inject } from '@nestjs/common';
import { Action, Computed, LiveComponent, State } from 'nestvexa';
import type { LiveUpdateContext } from 'nestvexa';
import { createTaskAdapter } from './task.dto.js';
import type { TaskPage } from './task.repository.js';
import { TaskService } from './task.service.js';

const pageSize = 10;
const text = (max: number) => ({
  writable: true as const,
  validate: (value: unknown) =>
    typeof value === 'string' && value.length <= max,
});

/** Live CRUD table: search, pages and a validated create form over TaskService. */
@LiveComponent({ name: 'task-table', view: 'components/task-table' })
export class TaskTableComponent {
  constructor(@Inject(TaskService) private readonly task: TaskService) {}
  @State(text(80)) draft = '';
  @State(text(80)) search = '';
  @State() page = 1;
  @State() error = '';
  #result: TaskPage = { items: [], total: 0, page: 1, size: pageSize };

  /** Loads the visible page before every render (the rows are not part of the client state). */
  async beforeRender(): Promise<void> {
    const q = this.search.trim();
    this.#result = await this.task.list({
      ...(q ? { q } : {}),
      page: this.page,
      size: pageSize,
    });
  }
  afterUpdate(update: LiveUpdateContext): void {
    if (update.field === 'search') this.page = 1;
  }
  @Computed() get rows() {
    return this.#result.items.map((item) => ({ ...item }));
  }
  @Computed() get summary() {
    const { total, page } = this.#result;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    return { total, page, pages, previous: page > 1, next: page < pages };
  }
  @Action() async create(): Promise<void> {
    const result = await createTaskAdapter.validate({ name: this.draft });
    if (!result.ok) {
      this.error = result.errors['name']?.[0] ?? 'Check the name.';
      return;
    }
    await this.task.create(result.value);
    this.draft = '';
    this.error = '';
  }
  @Action() previous(): void {
    this.page = Math.max(1, this.page - 1);
  }
  @Action() next(): void {
    this.page += 1;
  }
}
