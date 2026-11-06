import { MailError } from './errors.js';
import type { MailAddress } from './message.js';
import type { Mailer } from './mailer.js';

/** A typed application event addressed to one recipient (user, team, ...). */
export interface Notification {
  /** Lowercase dotted id such as `invoice.paid`; selects templates and events. */
  readonly type: string;
  /** Public data for templates and realtime payloads. Never put secrets here. */
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface NotificationChannel<Recipient> {
  readonly name: string;
  /** Return false to skip this recipient (for example no address or opted out). */
  accepts?(recipient: Recipient, notification: Notification): boolean;
  deliver(recipient: Recipient, notification: Notification): Promise<void>;
}

export interface NotificationResult {
  readonly channel: string;
  readonly status: 'delivered' | 'skipped' | 'failed';
  /** Closed code for failures (`MailError` codes, else `DELIVERY_FAILED`). */
  readonly error?: string;
}

const notificationType = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/;
const channelName = /^[a-z][a-z0-9_-]{0,63}$/;

export interface MailChannelOptions<Recipient> {
  /** Recipient address; undefined skips the channel. */
  readonly address: (recipient: Recipient) => MailAddress | undefined;
  /** Template per notification. Default: the type with dots as slashes (`invoice/paid`). */
  readonly template?: (notification: Notification) => string;
  readonly locale?: (recipient: Recipient) => string | undefined;
  /** Template model. Default `{ ...notification.data }`. */
  readonly model?: (
    recipient: Recipient,
    notification: Notification,
  ) => Readonly<Record<string, unknown>>;
}
/** Sends a notification as templated mail through `Mailer.sendTemplate`. */
export function mailChannel<Recipient>(
  mailer: Pick<Mailer, 'sendTemplate'>,
  options: MailChannelOptions<Recipient>,
): NotificationChannel<Recipient> {
  return Object.freeze({
    name: 'mail',
    accepts: (recipient: Recipient) => options.address(recipient) !== undefined,
    async deliver(
      recipient: Recipient,
      notification: Notification,
    ): Promise<void> {
      const to = options.address(recipient);
      if (to === undefined) return;
      const locale = options.locale?.(recipient);
      await mailer.sendTemplate(
        options.template?.(notification) ??
          notification.type.replaceAll('.', '/'),
        {
          to,
          model: options.model?.(recipient, notification) ?? {
            ...notification.data,
          },
          ...(locale === undefined ? {} : { locale }),
        },
      );
    },
  });
}

/** Structural `RealtimeService` / `RealtimeBroker` from `@nestvexa/realtime`. */
export interface RealtimePublisher {
  publish(channel: string, data?: unknown): Promise<unknown>;
}
export interface RealtimeChannelOptions<Recipient> {
  /** Realtime channel of the recipient, for example `user:42:notifications`. */
  readonly channel: (recipient: Recipient) => string | undefined;
  /**
   * Public payload. Default `{ type }` only: realtime data reaches every
   * authorized subscriber of the channel, so include fields deliberately.
   */
  readonly payload?: (notification: Notification) => unknown;
}
/**
 * Publishes a notification to the recipient's realtime channel (Live
 * components subscribed with `@RealtimeChannels` refresh, e.g. a badge).
 * Channel authorization stays in the realtime module's `authorizeChannel`.
 */
export function realtimeChannel<Recipient>(
  publisher: RealtimePublisher,
  options: RealtimeChannelOptions<Recipient>,
): NotificationChannel<Recipient> {
  return Object.freeze({
    name: 'realtime',
    accepts: (recipient: Recipient) => options.channel(recipient) !== undefined,
    async deliver(
      recipient: Recipient,
      notification: Notification,
    ): Promise<void> {
      const channel = options.channel(recipient);
      if (channel === undefined) return;
      await publisher.publish(
        channel,
        options.payload?.(notification) ?? { type: notification.type },
      );
    },
  });
}

/**
 * Fans one notification out to channels. Channels run independently: a
 * failing channel is reported, not thrown, so mail outages do not drop the
 * realtime update and vice versa.
 */
export class NotificationBridge<Recipient> {
  readonly #channels: ReadonlyMap<string, NotificationChannel<Recipient>>;
  constructor(channels: readonly NotificationChannel<Recipient>[]) {
    const map = new Map<string, NotificationChannel<Recipient>>();
    for (const channel of channels) {
      if (
        !channelName.test(channel?.name) ||
        typeof channel.deliver !== 'function'
      )
        throw new MailError('INVALID_MESSAGE', 'Invalid notification channel');
      if (map.has(channel.name))
        throw new MailError(
          'INVALID_MESSAGE',
          `Duplicate notification channel ${channel.name}`,
        );
      map.set(channel.name, channel);
    }
    this.#channels = map;
  }

  async notify(
    recipient: Recipient,
    notification: Notification,
    options: { readonly channels?: readonly string[] } = {},
  ): Promise<readonly NotificationResult[]> {
    if (
      typeof notification?.type !== 'string' ||
      !notificationType.test(notification.type)
    )
      throw new MailError('INVALID_MESSAGE', 'Invalid notification type');
    const names = options.channels ?? [...this.#channels.keys()];
    const selected = names.map((name) => {
      const channel = this.#channels.get(name);
      if (!channel)
        throw new MailError(
          'INVALID_MESSAGE',
          `Unknown notification channel ${name}`,
        );
      return channel;
    });
    return Promise.all(
      selected.map(async (channel): Promise<NotificationResult> => {
        try {
          if (channel.accepts && !channel.accepts(recipient, notification))
            return { channel: channel.name, status: 'skipped' };
          await channel.deliver(recipient, notification);
          return { channel: channel.name, status: 'delivered' };
        } catch (error) {
          return {
            channel: channel.name,
            status: 'failed',
            error: error instanceof MailError ? error.code : 'DELIVERY_FAILED',
          };
        }
      }),
    );
  }
}
