import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  Mailer,
  NotificationBridge,
  mailChannel,
  realtimeChannel,
} from '@nestvexa/mail';
import type { Notification, NotificationResult } from '@nestvexa/mail';
import { RealtimeService } from '@nestvexa/realtime';
import { origin } from './config.js';
import { ShowcaseData } from './data.js';
import { notificationsChannel } from './identity.js';
import { SharedState } from './metrics.js';
import type { Account } from './seed.js';

/**
 * Fan-out of application events to one account through three channels of
 * `@nestvexa/mail`'s NotificationBridge: templated mail (Mailer, test or
 * console transport here), the in-app inbox (shared state) and a realtime
 * event on the user's private channel, which refreshes their dashboard.
 * Channels fail independently; failures are logged by closed code only.
 */
@Injectable()
export class Notifier {
  readonly #logger = new Logger('Notifier');
  readonly #bridge: NotificationBridge<Account>;
  constructor(
    @Inject(Mailer) mailer: Mailer,
    @Inject(RealtimeService) realtime: RealtimeService,
    @Inject(SharedState) shared: SharedState,
    @Inject(ShowcaseData) data: ShowcaseData,
  ) {
    this.#bridge = new NotificationBridge<Account>([
      mailChannel<Account>(mailer, {
        // The profile preference "never" opts out of mail, not of the inbox.
        address: (user) =>
          data.profile(user.id)?.digest === 'never'
            ? undefined
            : { address: user.email, name: user.name },
        model: (user, notification) => ({
          ...notification.data,
          name: data.profile(user.id)?.displayName ?? user.name,
          origin,
        }),
      }),
      {
        name: 'inbox',
        deliver: async (user: Account, notification: Notification) => {
          const text = notification.data?.['summary'];
          await shared.push(
            user.id,
            typeof text === 'string' ? text : notification.type,
          );
        },
      },
      // Event only (`{ type }`): the browser refreshes and re-reads its inbox.
      realtimeChannel<Account>(realtime, {
        channel: (user) => notificationsChannel(user.id),
      }),
    ]);
  }

  async notify(
    user: Account,
    notification: Notification,
  ): Promise<readonly NotificationResult[]> {
    const results = await this.#bridge.notify(user, notification);
    for (const result of results)
      if (result.status === 'failed')
        this.#logger.warn(
          `${notification.type} via ${result.channel} failed: ${result.error ?? 'unknown'}`,
        );
    return results;
  }
}
