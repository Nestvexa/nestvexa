import { Inject } from '@nestjs/common';
import { Action, Computed, LiveComponent, State } from 'nestvexa';
import { TaskService } from './task.service.js';

@LiveComponent({ name: 'task-table', view: 'components/task-table' })
export class TaskTableComponent {
  constructor(@Inject(TaskService) private readonly task: TaskService) {}
  @State({ writable: true, validate: (value) => typeof value === 'string' && value.length <= 80 })
  draft = '';
  @State() error = '';
  @Computed() get rows() {
    return this.task.list().map((item) => ({ ...item }));
  }
  @Action() create(): void {
    const name = this.draft.trim();
    this.error = name.length < 2 ? 'Enter at least 2 characters.' : '';
    if (this.error) return;
    this.task.create(name);
    this.draft = '';
  }
}
