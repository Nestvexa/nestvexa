import { Action, LiveComponent, Session, State, Url } from 'nestvexa';

/** Public demonstration data. Real notifications must query an authorized host service. */
@LiveComponent({ name: 'activity-panel', view: 'activity-panel' })
export class ActivityPanel {
  @Url({ key: 'q', history: 'push', except: '' })
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 80,
  })
  query = '';

  @Session({ ttl: 900_000 })
  @State()
  remembered = 0;

  @State() refreshes = 0;
  @State() appearances = 0;
  @State({ writable: true }) panelVisible = true;

  @Action() remember(): void {
    this.remembered++;
  }
  @Action() refresh(): void {
    this.refreshes++;
  }
  @Action() appear(): void {
    this.appearances++;
  }
  @Action() toggle(): void {
    this.panelVisible = !this.panelVisible;
  }
}
