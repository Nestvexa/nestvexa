import { BadRequestException } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import {
  Action,
  ActionInput,
  LiveComponent,
  Session,
  State,
  Url,
} from 'nestvexa';

export interface ActivityOrder {
  readonly ids: readonly string[];
}
/** Structural validation runs in Nest's normal generated action route. */
export class ActivityOrderPipe implements PipeTransform<
  unknown,
  ActivityOrder
> {
  transform(value: unknown): ActivityOrder {
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      !Object.hasOwn(value, 'ids')
    )
      throw new BadRequestException('Expected an item order');
    const ids: unknown = Reflect.get(value, 'ids');
    if (
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > 200 ||
      ids.some(
        (id: unknown) =>
          typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(id),
      ) ||
      new Set(ids).size !== ids.length
    )
      throw new BadRequestException('Invalid item identifiers');
    return {
      ids: ids.map((id: unknown) => {
        if (typeof id !== 'string')
          throw new BadRequestException('Invalid item identifier');
        return id;
      }),
    };
  }
}

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
  @State() likes = 0;
  @State() appearances = 0;
  @State() taskOrderSaved = false;
  @State({ writable: true }) panelVisible = true;
  @State() tasks = [
    { id: 'forms', title: 'Build accessible forms' },
    { id: 'security', title: 'Review security boundaries' },
    { id: 'docs', title: 'Write release documentation' },
  ];

  @Action() reorder(
    @ActionInput(ActivityOrderPipe) input: ActivityOrder,
  ): void {
    // Browser identifiers are proposals. Only this authorized component's exact set is accepted.
    if (
      input.ids.length !== this.tasks.length ||
      input.ids.some((id) => !this.tasks.some((task) => task.id === id))
    )
      throw new BadRequestException(
        'Order must contain every authorized item exactly once',
      );
    this.tasks = input.ids.map((id) => {
      const task = this.tasks.find((entry) => entry.id === id);
      if (!task) throw new BadRequestException('Unknown task');
      return task;
    });
    this.taskOrderSaved = true;
  }

  /** Acknowledged with state only; bound `nv:text` values update without an HTML morph. */
  @Action({ renderless: true }) like(): void {
    this.likes++;
  }

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
