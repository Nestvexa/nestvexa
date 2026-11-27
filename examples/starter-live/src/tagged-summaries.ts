import { Inject, Injectable, Module } from '@nestjs/common';
import {
  Action,
  Computed,
  DependsOn,
  LiveComponent,
  LiveTags,
  State,
} from 'nestvexa';

/**
 * REAL-010 demonstration: two read models with declared data dependencies.
 * `@DependsOn('orders')` subscribes the order summary to `tag:orders` only;
 * `LiveTags.invalidate(['orders'])` after a write refreshes it (read-only)
 * in every browser, while the stock summary, which depends on `inventory`,
 * is not refreshed. No dependency is inferred: the tags are explicit.
 */
export const orderTag = 'orders';
export const inventoryTag = 'inventory';

/** Shared demonstration data (bounded counters, in memory). */
@Injectable()
export class Warehouse {
  #orders = 0;
  #stock = 10;
  get orders(): number {
    return this.#orders;
  }
  get stock(): number {
    return this.#stock;
  }
  placeOrder(): void {
    if (this.#orders < 1_000_000) this.#orders++;
  }
  restock(): void {
    this.#stock = Math.min(this.#stock + 5, 1_000_000);
  }
}
@Module({ providers: [Warehouse], exports: [Warehouse] })
export class WarehouseModule {}

@DependsOn(orderTag)
@LiveComponent({ name: 'order-summary', view: 'order-summary' })
export class OrderSummary {
  constructor(@Inject(Warehouse) private readonly warehouse: Warehouse) {}
  /** Read on every render, so a tag refresh shows current data. */
  @Computed() get orders(): number {
    return this.warehouse.orders;
  }
}

/**
 * Its own transport (REAL-004): the stock summary long-polls while the rest
 * of the page uses the page default (`auto`, negotiated with the server).
 */
@DependsOn(inventoryTag)
@LiveComponent({
  name: 'stock-summary',
  view: 'stock-summary',
  realtime: { transport: 'polling' },
})
export class StockSummary {
  constructor(@Inject(Warehouse) private readonly warehouse: Warehouse) {}
  @Computed() get stock(): number {
    return this.warehouse.stock;
  }
}

/** The write side: each action changes data and invalidates exactly the tag it touched. */
@LiveComponent({ name: 'warehouse-controls', view: 'warehouse-controls' })
export class WarehouseControls {
  constructor(
    @Inject(Warehouse) private readonly warehouse: Warehouse,
    @Inject(LiveTags) private readonly tags: LiveTags,
  ) {}
  @State() writes = 0;
  @Action() async placeOrder(): Promise<void> {
    this.warehouse.placeOrder();
    this.writes++;
    await this.tags.invalidate([orderTag]);
  }
  @Action() async restock(): Promise<void> {
    this.warehouse.restock();
    this.writes++;
    await this.tags.invalidate([inventoryTag]);
  }
}
