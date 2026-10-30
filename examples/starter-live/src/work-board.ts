import { Action, Computed, LiveComponent, State } from 'nestvexa';
import type { LiveLifecycleHooks, LiveUpdateContext } from 'nestvexa';

interface WorkItem {
  id: number;
  title: string;
}

/** Public demonstration data; production hosts inject their own authorized service. */
@LiveComponent({ name: 'work-board', view: 'board' })
export class WorkBoard implements LiveLifecycleHooks {
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 80,
  })
  query = '';
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 80,
  })
  title = '';
  @State() descending = false;
  @State() error = '';
  @State() hasError = false;
  @State() status = 'Ready';
  @State() lastUpdated = 'None';
  afterUpdate(update: LiveUpdateContext): void {
    this.lastUpdated = update.field;
  }
  @State() rows: WorkItem[] = [
    { id: 1, title: 'Build accessible forms' },
    { id: 2, title: 'Review security boundaries' },
    { id: 3, title: 'Write release documentation' },
  ];
  @Computed() get visibleRows(): WorkItem[] {
    const query = this.query.toLocaleLowerCase('en');
    return this.rows
      .filter((row) => row.title.toLocaleLowerCase('en').includes(query))
      .sort(
        (a, b) =>
          (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) *
          (this.descending ? -1 : 1),
      );
  }
  @Computed() get sortLabel(): string {
    return this.descending ? 'descending' : 'ascending';
  }
  @Action() sort(): void {
    this.descending = !this.descending;
  }
  @Action() removeFirst(): void {
    const first = this.visibleRows[0];
    if (!first) {
      this.status = 'No matching work item to remove';
      return;
    }
    this.rows = this.rows.filter((row) => row.id !== first.id);
    this.status = 'Work item removed';
  }
  @Action() add(): void {
    const title = this.title.trim();
    this.error = !title
      ? 'Enter a work item title.'
      : this.rows.length >= 50
        ? 'This demonstration is limited to 50 items.'
        : '';
    this.hasError = this.error !== '';
    if (this.hasError) return;
    this.rows = [
      ...this.rows,
      { id: Math.max(0, ...this.rows.map((row) => row.id)) + 1, title },
    ];
    this.title = '';
    this.status = 'Work item added';
  }
}
