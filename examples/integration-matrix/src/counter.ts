import { Action, Computed, LiveComponent, State } from 'nestvexa';

/** `/counter`: server-owned state, validated writable input and actions. */
@LiveComponent({ name: 'counter', view: 'counter' })
export class Counter {
  @State() count = 0;
  /** Transport bound: the browser may only write a short string here. */
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 8,
  })
  step = '1';
  @State() error = '';

  @Computed() get doubled(): number {
    return this.count * 2;
  }
  /** Business rule checked on the server for every action that uses it. */
  private parsedStep(): number | undefined {
    const step = Number(this.step);
    if (!/^\d+$/.test(this.step) || step < 1 || step > 10) {
      this.error = 'Step must be a whole number from 1 to 10.';
      return undefined;
    }
    this.error = '';
    return step;
  }
  @Action() increment(): void {
    const step = this.parsedStep();
    if (step !== undefined) this.count = Math.min(this.count + step, 1000);
  }
  @Action() decrement(): void {
    const step = this.parsedStep();
    if (step !== undefined) this.count = Math.max(this.count - step, -1000);
  }
  @Action() reset(): void {
    this.count = 0;
    this.error = '';
  }
}
