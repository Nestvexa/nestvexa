// Compile-time fixture for tests/actions-codegen.test.ts. Typechecked by the
// root test project; read by the generator through the TypeScript compiler API.
import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import {
  ActionGroup as Group,
  ActionInput,
  ActionResult,
  ServerAction,
  redirectTo,
} from '../../../packages/actions/dist/index.js';

export type Currency = 'EUR' | 'USD';

export interface Money {
  amount: number;
  currency: Currency;
}

export interface CartLine {
  productId: string;
  quantity: number;
  note?: string;
  price: Money;
}

/** Recursive named type. */
export interface Category {
  name: string;
  children: Category[];
}

export interface AddItemInput {
  productId: string;
  quantity: number;
  giftWrap?: boolean;
  tags: readonly string[];
}

export class CartSummaryDto {
  lines: CartLine[] = [];
  total: Money = { amount: 0, currency: 'EUR' };
  updatedAt: Date = new Date(0);
  coupon: string | null = null;
  private readonly internalSecret = 'never generated';
  describe(): string {
    return this.internalSecret;
  }
}

abstract class AuditedActions {
  @ServerAction({ id: 'history' })
  history(): Promise<{ at: Date; event: string }[]> {
    return Promise.resolve([]);
  }
}

@Injectable()
@Group('cart')
export class CartActions extends AuditedActions {
  @ServerAction({ id: 'add-item' })
  async add(@ActionInput() input: AddItemInput): Promise<CartSummaryDto> {
    const summary = new CartSummaryDto();
    summary.lines.push({
      productId: input.productId,
      quantity: input.quantity,
      price: { amount: 1, currency: 'EUR' },
    });
    return summary;
  }

  @ServerAction({ id: 'add-item', version: 2, idempotent: true })
  addV2(
    @ActionInput()
    input: {
      items: [string, number][];
      meta?: Record<string, string>;
    },
  ): { accepted: number; status: 'queued' | 'done' } {
    return { accepted: input.items.length, status: 'queued' };
  }

  @ServerAction({ id: 'clear' })
  clear(): void {}

  @ServerAction({ id: 'checkout' })
  checkout(
    @ActionInput() input?: { coupon?: string | null },
  ): ActionResult<{ orderId: string }> | ActionResult<null> {
    return input?.coupon
      ? redirectTo('/orders/1', { orderId: '1' })
      : redirectTo('/cart');
  }

  @ServerAction({ id: 'categories' })
  categories(): Category {
    return { name: 'root', children: [] };
  }

  notExposed(): string {
    return 'never generated';
  }
}

@Group('user-profile')
export class ProfileActions {
  @ServerAction({ id: 'rename', idempotent: false })
  rename(@ActionInput() input: { displayName: string }): {
    displayName: string;
    length: number | undefined;
  } {
    return { displayName: input.displayName, length: input.displayName.length };
  }
}
