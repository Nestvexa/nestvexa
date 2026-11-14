import { Inject, Injectable } from '@nestjs/common';
import { liveTagChannel } from './metadata.js';
import type { JsonValue } from './protocol.js';
import { LIVE_OPTIONS } from './runtime.js';
import type { RuntimeOptions } from './runtime.js';

/**
 * Structural shape of a tag-invalidation listener, for example the
 * `onInvalidate` callback of a @nestvexa/cache `Cache`. Live never imports the
 * cache package; anything that reports invalidated tags can call it.
 */
export type LiveTagListener = (tags: readonly string[]) => Promise<void>;

/**
 * Publishes data-tag invalidations to the components that declared those
 * tags with `@DependsOn`. `invalidate(tags)` sends one empty realtime event on
 * `tag:<tag>` per distinct tag through the host's structural publisher
 * (`events`, or `realtime` when it can publish). Each browser subscribed to
 * one of those channels refreshes the matching components through their own
 * authorized read-only refresh; components that declared no matching tag are
 * not refreshed. The event carries no data: the refresh re-reads it.
 *
 * Wire it to a cache: `new Cache(store, Date.now, tags.listener)`.
 */
@Injectable()
export class LiveTags {
  constructor(@Inject(LIVE_OPTIONS) private readonly options: RuntimeOptions) {}

  /** Whether a publisher is configured. */
  get enabled(): boolean {
    return this.publisher() !== undefined;
  }

  /** `invalidate`, bound, for callback slots such as `Cache`'s `onInvalidate`. */
  readonly listener: LiveTagListener = (tags) => this.invalidate(tags);

  async invalidate(tags: readonly string[]): Promise<void> {
    if (!Array.isArray(tags) || tags.length > 256)
      throw new Error('Invalidate 0-256 tags at a time');
    // Validate every tag before publishing any: a bad batch publishes nothing.
    const channels = [...new Set(tags.map((tag) => liveTagChannel(tag)))];
    if (!channels.length) return;
    const publisher = this.publisher();
    if (!publisher)
      throw new Error(
        'Live tag invalidation needs an events (or realtime) publisher such as RealtimeService',
      );
    for (const channel of channels) await publisher.publish(channel, null);
  }

  private publisher():
    { publish(channel: string, data: JsonValue): unknown } | undefined {
    if (this.options.events) return this.options.events;
    const realtime = this.options.realtime;
    if (realtime && typeof realtime.publish === 'function')
      return {
        publish: (channel, data) => realtime.publish?.(channel, data),
      };
    return undefined;
  }
}
