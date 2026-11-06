import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Module,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
  Action,
  Computed,
  LiveComponent,
  RealtimeChannels,
  State,
} from 'nestvexa';
import { RealtimeService } from '@nestvexa/realtime';
import { bindingOf, isOperatorBinding } from './identity.js';

/** Every session may read the public feed. */
export const publicChannel = 'matrix:public';
/** Only operator sessions may subscribe to alerts (see `authorizeChannel`). */
export const opsChannel = 'matrix:ops';

export function authorizeChannel(
  identity: { binding: string },
  channel: string,
): boolean {
  return (
    channel === publicChannel ||
    (channel === opsChannel && isOperatorBinding(identity.binding))
  );
}

interface Entry {
  readonly id: number;
  readonly text: string;
}
class BoundedList {
  readonly #items: Entry[] = [];
  #next = 1;
  add(text: string): void {
    this.#items.unshift({ id: this.#next++, text });
    this.#items.length = Math.min(this.#items.length, 10);
  }
  list(): Entry[] {
    return this.#items.map((item) => ({ ...item }));
  }
}

/** Shared, bounded, in-memory demonstration data. */
@Injectable()
export class RealtimeStore {
  readonly feed = new BoundedList();
  readonly alerts = new BoundedList();
}
@Module({ providers: [RealtimeStore], exports: [RealtimeStore] })
export class RealtimeStoreModule {}

/** `/realtime`: event-triggered, authorized refreshes over SSE. */
@LiveComponent({ name: 'realtime-panel', view: 'realtime-panel' })
export class RealtimePanel {
  constructor(
    @Inject(RealtimeStore) private readonly store: RealtimeStore,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
    @Inject(REQUEST) private readonly request: object,
  ) {}
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 80,
  })
  draft = '';
  @State() posted = 0;

  /** Requested channels; the realtime signer drops the ones this identity may not read. */
  @RealtimeChannels() channels(): string[] {
    return [publicChannel, opsChannel];
  }
  @Computed() get operator(): boolean {
    return isOperatorBinding(bindingOf(this.request));
  }
  @Computed() get feed(): Entry[] {
    return this.store.feed.list();
  }
  /** Rendered only for operators; guests never receive alert text. */
  @Computed() get alerts(): Entry[] {
    return this.operator ? this.store.alerts.list() : [];
  }
  @Action() async post(): Promise<void> {
    const text = this.draft.trim();
    if (!text) throw new BadRequestException('Write a message first');
    this.store.feed.add(text);
    this.draft = '';
    this.posted++;
    // Subscribers refresh through their own authorized $sync request.
    await this.realtime.publish(publicChannel, null);
  }
  @Action() async raiseAlert(): Promise<void> {
    // Defense in depth: the Live `authorize` policy already refuses guests.
    if (!this.operator) throw new ForbiddenException();
    this.store.alerts.add(`Alert at ${new Date().toISOString().slice(11, 19)}`);
    await this.realtime.publish(opsChannel, null);
  }
}
