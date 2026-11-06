import { BadRequestException, Injectable } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import {
  ActionContext,
  ActionGroup,
  ActionInput,
  ServerAction,
} from '@nestvexa/actions';
import { IslandRegistry } from '@nestvexa/islands';
import { Action, LiveComponent, State } from 'nestvexa';

/** Server-side island allowlist; the client bundle holds the matching module map. */
export const islands = new IslandRegistry([
  { id: 'revenue-chart', framework: 'react', strategy: 'immediate' },
  { id: 'activity-feed', framework: 'vue', strategy: 'visible' },
  { id: 'status-widget', framework: 'svelte', strategy: 'idle' },
]);

export function hybridIslands() {
  return {
    chart: islands.render(
      'revenue-chart',
      { title: 'Revenue by quarter', values: [12, 19, 7, 15] },
      { label: 'Revenue chart (React)', fallback: 'Loading chart…' },
    ),
    feed: islands.render(
      'activity-feed',
      { items: ['Dashboard opened', '<b>escaped</b> markup stays text'] },
      { label: 'Activity feed (Vue)' },
    ),
    widget: islands.render(
      'status-widget',
      { label: 'Sync' },
      { label: 'Status (Svelte)' },
    ),
  };
}

/** Independent Live widget on the hybrid page; it owns no island. */
@LiveComponent({ name: 'notifications', view: 'notifications' })
export class Notifications {
  @State() count = 0;
  @Action() notify(): void {
    this.count = Math.min(this.count + 1, 99);
  }
}

interface ScoreInput {
  readonly points: number;
}
/** Normal Nest pipe validating the universal action input. */
@Injectable()
export class ScorePipe implements PipeTransform<unknown, ScoreInput> {
  transform(value: unknown): ScoreInput {
    const points =
      typeof value === 'object' && value !== null
        ? Reflect.get(value, 'points')
        : undefined;
    if (
      typeof points !== 'number' ||
      !Number.isInteger(points) ||
      points < 1 ||
      points > 10
    )
      throw new BadRequestException('points must be an integer from 1 to 10');
    return { points };
  }
}

/** Universal server action: per-identity score kept in bounded memory. */
@Injectable()
@ActionGroup('scoreboard')
export class ScoreboardActions {
  readonly #scores = new Map<string, number>();
  @ServerAction({ id: 'add-points' })
  add(
    @ActionInput(ScorePipe) input: ScoreInput,
    @ActionContext() context: ActionContext,
  ): { total: number } {
    // The owner comes from the host-resolved identity, never from the body.
    const owner = context.identity.subject;
    if (!this.#scores.has(owner) && this.#scores.size >= 1000)
      this.#scores.clear();
    const total = Math.min((this.#scores.get(owner) ?? 0) + input.points, 1000);
    this.#scores.set(owner, total);
    return { total };
  }
}
