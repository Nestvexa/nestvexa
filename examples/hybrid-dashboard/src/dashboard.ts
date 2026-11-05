import { Inject, Injectable, Module } from '@nestjs/common';
import {
  ActionContext,
  ActionError,
  ActionGroup,
  ActionInput,
  ServerAction,
  acceptJob,
} from '@nestvexa/actions';
import { IslandError } from '@nestvexa/islands';
import type { IslandRegistry } from '@nestvexa/islands';

export const ISLANDS = Symbol('islands');

export type DashboardEventKind =
  'chart.selected' | 'note.added' | 'status.toggled';
export interface RecordEventInput {
  kind: DashboardEventKind;
  label: string;
}
export interface ActivitySummary {
  total: number;
  recent: string[];
}
export interface SetStatusInput {
  online: boolean;
  /** Signed island props (`island.signed`) proving which workspace the widget shows. */
  props: string;
  token: string;
}
export interface StatusResult {
  online: boolean;
  workspace: string;
}
export interface ReportFile {
  rows: number;
  url: string;
}

/** Business service: per-subject activity, bounded and process-local (demo storage). */
@Injectable()
export class ActivityService {
  readonly #events = new Map<string, string[]>();
  record(owner: string, entry: string): ActivitySummary {
    let list = this.#events.get(owner);
    if (!list) {
      if (this.#events.size >= 1000) throw ActionError.rateLimited();
      list = [];
      this.#events.set(owner, list);
    }
    list.unshift(entry);
    list.length = Math.min(list.length, 50);
    return { total: list.length, recent: list.slice(0, 5) };
  }
}

@Module({ providers: [ActivityService], exports: [ActivityService] })
export class DashboardModule {}

const kinds: readonly DashboardEventKind[] = [
  'chart.selected',
  'note.added',
  'status.toggled',
];

/** Typed actions used from the React, Vue and Svelte islands. */
@ActionGroup('dashboard')
export class DashboardActions {
  constructor(
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(ISLANDS) private readonly islands: IslandRegistry,
  ) {}

  @ServerAction({ id: 'record-event' })
  record(
    @ActionInput() input: RecordEventInput,
    @ActionContext() context: ActionContext,
  ): ActivitySummary {
    if (
      typeof input !== 'object' ||
      input === null ||
      !kinds.includes(input.kind) ||
      typeof input.label !== 'string' ||
      input.label.trim().length === 0 ||
      input.label.length > 80
    )
      throw ActionError.validation(undefined, [
        { path: ['label'], message: 'Enter 1-80 characters' },
      ]);
    return this.activity.record(
      context.identity.subject,
      `${input.kind}: ${input.label.trim()}`,
    );
  }

  /** Verifies the widget's signed props before trusting the workspace they name. */
  @ServerAction({ id: 'set-status' })
  setStatus(@ActionInput() input: SetStatusInput): StatusResult {
    let props: Record<string, unknown>;
    try {
      props = this.islands.verifyProps(
        'status-widget',
        String(input?.props),
        String(input?.token),
      );
    } catch (error) {
      if (error instanceof IslandError)
        throw ActionError.validation('The widget props were tampered with.', [
          { path: ['token'], message: error.message },
        ]);
      throw error;
    }
    return {
      online: input.online === true,
      workspace: String(props['workspace']),
    };
  }

  /** Long-running work: 202 + job ticket; the island polls with progress. */
  @ServerAction({ id: 'export-report', job: true })
  exportReport(@ActionInput() input: { rows: number }) {
    const rows = Math.max(1, Math.min(1000, Math.trunc(Number(input?.rows))));
    return acceptJob(
      'export-report',
      async ({ progress, signal }): Promise<ReportFile> => {
        for (let step = 1; step <= 4; step++) {
          await new Promise((resolve) => setTimeout(resolve, 60));
          if (signal.aborted) throw new Error('cancelled');
          progress(step * 25);
        }
        return { rows, url: `/reports/activity-${rows}.csv` };
      },
    );
  }
}
