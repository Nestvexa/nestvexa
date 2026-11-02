// Second compile-time fixture: a distinct `Money` type exercises deterministic
// name-collision handling independent of root file order.
import 'reflect-metadata';
import {
  ActionGroup,
  ActionInput,
  ServerAction,
} from '../../../packages/actions/dist/index.js';

export interface Money {
  cents: number;
}

export enum OrderState {
  Open = 'open',
  Shipped = 'shipped',
}

@ActionGroup('orders')
export class OrderActions {
  @ServerAction({ id: 'get', version: 3 })
  get(@ActionInput() input: { id: string }): {
    id: string;
    state: OrderState;
    total: Money;
    flags: { express: boolean };
  } {
    return {
      id: input.id,
      state: OrderState.Open,
      total: { cents: 1 },
      flags: { express: false },
    };
  }
}
