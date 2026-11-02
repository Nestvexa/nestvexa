import {
  MAX_MESSAGE_LENGTH,
  MAX_NOTIFICATIONS,
  isSafeRedirect,
} from './shared/protocol.js';
import type {
  ActionNotification,
  ActionNotificationLevel,
  ActionRedirect,
} from './shared/protocol.js';

const LEVELS: ReadonlySet<string> = new Set<ActionNotificationLevel>([
  'info',
  'success',
  'warning',
  'error',
]);

export interface ActionEffects {
  /** Same-origin absolute path (`/cart`), never a scheme-relative or external URL. */
  readonly redirect?: string;
  readonly notifications?: readonly ActionNotification[];
}

/**
 * Explicit result wrapper carrying client effects next to the JSON data.
 * The generated client unwraps it to `T`; redirect and notifications are
 * delivered through client hooks.
 */
export class ActionResult<T> {
  readonly data: T;
  readonly redirect: ActionRedirect | undefined;
  readonly notifications: readonly ActionNotification[];

  private constructor(data: T, effects: ActionEffects) {
    if (effects.redirect !== undefined && !isSafeRedirect(effects.redirect))
      throw new TypeError(
        'Action redirects must be same-origin absolute paths such as /cart',
      );
    const notifications = effects.notifications ?? [];
    if (
      !Array.isArray(notifications) ||
      notifications.length > MAX_NOTIFICATIONS
    )
      throw new TypeError(
        `Action notifications must be an array of at most ${MAX_NOTIFICATIONS} entries`,
      );
    this.data = data;
    this.redirect =
      effects.redirect === undefined
        ? undefined
        : Object.freeze({ location: effects.redirect });
    this.notifications = Object.freeze(
      notifications.map((notification: ActionNotification) => {
        if (
          typeof notification !== 'object' ||
          notification === null ||
          !LEVELS.has(notification.level) ||
          typeof notification.message !== 'string' ||
          notification.message.length === 0 ||
          notification.message.length > MAX_MESSAGE_LENGTH
        )
          throw new TypeError('Invalid action notification');
        return Object.freeze({
          level: notification.level,
          message: notification.message,
        });
      }),
    );
    Object.freeze(this);
  }

  static of<T>(data: T, effects: ActionEffects = {}): ActionResult<T> {
    return new ActionResult(data, effects);
  }

  /** Same effects with replaced data, used after output schema parsing. */
  withData<U>(data: U): ActionResult<U> {
    return new ActionResult(data, {
      ...(this.redirect === undefined
        ? {}
        : { redirect: this.redirect.location }),
      notifications: this.notifications,
    });
  }
}

/** `return redirectTo('/orders/42')` navigates the browser after success. */
export function redirectTo(location: string): ActionResult<null>;
export function redirectTo<T>(location: string, data: T): ActionResult<T>;
export function redirectTo(location: string, data: unknown = null) {
  return ActionResult.of(data, { redirect: location });
}

/** Attach user-visible notifications to a result. */
export function withNotifications<T>(
  data: T,
  ...notifications: ActionNotification[]
): ActionResult<T> {
  return ActionResult.of(data, { notifications });
}
