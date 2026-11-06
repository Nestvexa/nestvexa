import { Inject, Injectable } from '@nestjs/common';
import { cloneState, freezeJson } from './protocol.js';
import type { JsonValue } from './protocol.js';
import { LIVE_OPTIONS } from './runtime.js';
import type { RuntimeOptions } from './runtime.js';

/** Realtime message field that marks a server-pushed Live domain event. */
export const LIVE_DOMAIN_EVENT_FIELD = 'nvEvent';
const channelPattern = /^[a-z0-9][a-z0-9:._-]{0,127}$/;
const eventPattern = /^[a-z][a-z0-9:.-]{0,63}$/;
const maxPayloadBytes = 16_384;

/** The published realtime data: `{ nvEvent: name, payload }`. */
export interface LiveDomainEventMessage {
  readonly nvEvent: string;
  readonly payload: JsonValue;
}

/** Validate and build the realtime data for a domain event. */
export function liveDomainEvent(
  name: string,
  payload: JsonValue = null,
): LiveDomainEventMessage {
  if (typeof name !== 'string' || !eventPattern.test(name))
    throw new Error(
      'Event names use lowercase letters, digits, ".", ":" and "-"',
    );
  const detached = freezeJson(cloneState({ payload }))['payload'] ?? null;
  if (Buffer.byteLength(JSON.stringify(detached)) > maxPayloadBytes)
    throw new Error('Live event payload exceeds 16 KiB');
  return Object.freeze({ [LIVE_DOMAIN_EVENT_FIELD]: name, payload: detached });
}

/**
 * Server-side publisher for `@OnEvent` domain events. `publish(channel, name,
 * payload)` sends `{ nvEvent, payload }` on a realtime channel through the
 * host's structural publisher (`events`, or `realtime` when it can publish).
 * Browsers holding a subscription token for that channel (issued only to
 * identities the realtime policy authorizes) deliver the event to each
 * subscribed component's `@OnEvent(name)` actions, which run through admission,
 * host authorization, guards and pipes like any action. Subscribed components
 * without a listener refresh through `$sync`. The payload is public and, when
 * it returns as action input, untrusted: send identifiers and re-read
 * authoritative data in the listener.
 */
@Injectable()
export class LiveEvents {
  constructor(@Inject(LIVE_OPTIONS) private readonly options: RuntimeOptions) {}

  /** Whether a publisher is configured. */
  get enabled(): boolean {
    return this.publisher() !== undefined;
  }

  async publish(
    channel: string,
    name: string,
    payload: JsonValue = null,
  ): Promise<void> {
    if (typeof channel !== 'string' || !channelPattern.test(channel))
      throw new Error('Invalid realtime channel for a Live event');
    const message = liveDomainEvent(name, payload);
    const publisher = this.publisher();
    if (!publisher)
      throw new Error(
        'Live events need an events (or realtime) publisher such as RealtimeService',
      );
    await publisher.publish(channel, { ...message });
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
