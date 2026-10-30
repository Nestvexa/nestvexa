import { Action, LiveComponent, State } from 'nestvexa';

/** Public seed content; real hosts inject an authorized request-scoped service. */
@LiveComponent({ name: 'startup-panel', view: 'startup-panel' })
export class StartupPanel {
  @State() loaded = false;
  @State() loads = 0;
  @State() refreshes = 0;
  @State() message = 'Waiting for the authorized initialization request';
  @Action() load(): void {
    this.loaded = true;
    this.loads++;
    this.message = 'Public sample content loaded';
  }
  @Action() refresh(): void {
    this.refreshes++;
  }
}

/** Negative policy fixture: the host permits mounting and refresh, but denies load. */
@LiveComponent({ name: 'startup-denied', view: 'startup-panel' })
export class DeniedStartupPanel extends StartupPanel {}
