import { Action, Computed, LiveComponent, State } from 'nestvexa';

interface WorkItem {
  id: number;
  title: string;
}

/** Public demonstration data; production hosts inject their own authorized service. */
@LiveComponent({ name: 'work-board', view: 'board' })
export class WorkBoard {
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
      { id: Math.max(...this.rows.map((row) => row.id)) + 1, title },
    ];
    this.title = '';
    this.status = 'Work item added';
  }
}
