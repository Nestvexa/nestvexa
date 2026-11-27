import { createHash, randomUUID } from 'node:crypto';
import type { RealtimeIdentity } from './hub.js';

/** What host code sends to one recipient. */
export interface NotificationInput {
  /** 1–200 characters of plain text (rendered escaped by the host). */
  readonly title: string;
  /** Up to 2000 characters of plain text. */
  readonly body?: string;
  /** Host-defined category, for example `mention` (`[a-z][a-z0-9-]{0,31}`). */
  readonly kind?: string;
  /** Public JSON for the recipient's page, at most 4 KiB. */
  readonly data?: unknown;
}
/** A stored notification as its recipient sees it. */
export interface RealtimeNotification {
  readonly id: string;
  readonly title: string;
  readonly body?: string;
  readonly kind?: string;
  readonly data: unknown;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  readonly read: boolean;
}
export interface NotificationsSnapshot {
  /** Unread notifications of the recipient (all stored, not only `items`). */
  readonly unread: number;
  /** Stored notifications of the recipient. */
  readonly total: number;
  /** Newest first, at most the requested limit. */
  readonly items: readonly RealtimeNotification[];
}
/** The event published on a recipient's channel after every change. */
export interface NotificationEvent {
  readonly nvNotifications: {
    readonly unread: number;
    /** The notification just sent, when the change is a new one. */
    readonly latest?: RealtimeNotification;
  };
}
/**
 * Storage of notifications per recipient key (an opaque SHA-256 digest; the
 * store never sees user ids). Every method may be synchronous or return a
 * promise. `MemoryNotificationStore` is the process-local default; a shared
 * store lets every replica list and mark the same notifications.
 */
export interface NotificationStore {
  /** Append and keep only the newest `limit` for the recipient. */
  append(
    recipient: string,
    notification: RealtimeNotification,
    limit: number,
  ): Promise<void> | void;
  /** Newest first. */
  list(
    recipient: string,
  ): Promise<readonly RealtimeNotification[]> | readonly RealtimeNotification[];
  /** Mark the given ids (all when undefined) as read; returns how many changed. */
  markRead(
    recipient: string,
    ids: readonly string[] | undefined,
  ): Promise<number> | number;
  clear(recipient: string): Promise<void> | void;
  close?(): Promise<void> | void;
}
export interface RealtimeNotificationsOptions {
  /** Publishes change events (`RealtimeService` fits). */
  readonly publisher: {
    publish(channel: string, data?: unknown): Promise<unknown>;
  };
  /**
   * Stable recipient of an identity, for example the user id, so every
   * session of a user shares one inbox. Default: the kernel principal id
   * scoped to its tenant when realtime's `kernelIdentity` is configured,
   * otherwise the identity binding (one inbox per session). Return
   * undefined for identities that have no inbox (they are refused).
   */
  readonly recipient?: (identity: RealtimeIdentity) => string | undefined;
  readonly store?: NotificationStore;
  /** Notifications kept per recipient, newest first (default 100, 1–1000). */
  readonly maxPerRecipient?: number;
  readonly now?: () => number;
}

const kindPattern = /^[a-z][a-z0-9-]{0,31}$/;
const channelPattern = /^notify:[0-9a-f]{40}$/;
const idPattern = /^[0-9a-f-]{36}$/;
function text(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || value.length > max)
    throw new Error(`Notification ${label} must be text of at most ${max}`);
  return value;
}
function publicJson(value: unknown): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value ?? null);
  } catch {
    throw new Error('Notification data must be JSON serializable');
  }
  if (serialized === undefined || Buffer.byteLength(serialized) > 4096)
    throw new Error('Notification data must be JSON of at most 4 KiB');
  return JSON.parse(serialized) as unknown;
}
/** Re-validate a stored record (a shared store's contents are untrusted). */
function stored(value: unknown): RealtimeNotification | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const get = (name: string): unknown => Reflect.get(value, name);
  const id = get('id');
  const title = get('title');
  const body = get('body');
  const kind = get('kind');
  const createdAt = get('createdAt');
  const read = get('read');
  if (
    typeof id !== 'string' ||
    !idPattern.test(id) ||
    typeof title !== 'string' ||
    !title ||
    title.length > 200 ||
    (body !== undefined && (typeof body !== 'string' || body.length > 2000)) ||
    (kind !== undefined &&
      (typeof kind !== 'string' || !kindPattern.test(kind))) ||
    !Number.isSafeInteger(createdAt) ||
    typeof read !== 'boolean'
  )
    return undefined;
  let data: unknown;
  try {
    data = publicJson(get('data'));
  } catch {
    return undefined;
  }
  return Object.freeze({
    id,
    title,
    ...(body === undefined ? {} : { body }),
    ...(kind === undefined ? {} : { kind }),
    data,
    createdAt: createdAt as number,
    read,
  });
}

/**
 * Process-local `NotificationStore` for one replica, tests and development.
 * Keeps at most `maxRecipients` inboxes (least recently changed evicted).
 */
export class MemoryNotificationStore implements NotificationStore {
  readonly #inboxes = new Map<string, RealtimeNotification[]>();
  readonly #maxRecipients: number;
  constructor(options: { readonly maxRecipients?: number } = {}) {
    this.#maxRecipients = options.maxRecipients ?? 10_000;
    if (!Number.isSafeInteger(this.#maxRecipients) || this.#maxRecipients < 1)
      throw new Error('Invalid notification maxRecipients');
  }
  #touch(recipient: string, inbox: RealtimeNotification[]): void {
    this.#inboxes.delete(recipient);
    this.#inboxes.set(recipient, inbox);
    while (this.#inboxes.size > this.#maxRecipients) {
      const oldest = this.#inboxes.keys().next().value;
      if (oldest === undefined) break;
      this.#inboxes.delete(oldest);
    }
  }
  append(
    recipient: string,
    notification: RealtimeNotification,
    limit: number,
  ): void {
    const inbox = [notification, ...(this.#inboxes.get(recipient) ?? [])];
    this.#touch(recipient, inbox.slice(0, limit));
  }
  list(recipient: string): readonly RealtimeNotification[] {
    return [...(this.#inboxes.get(recipient) ?? [])];
  }
  markRead(recipient: string, ids: readonly string[] | undefined): number {
    const inbox = this.#inboxes.get(recipient);
    if (!inbox) return 0;
    const wanted = ids === undefined ? undefined : new Set(ids);
    let changed = 0;
    const next = inbox.map((item) => {
      if (item.read || (wanted && !wanted.has(item.id))) return item;
      changed++;
      return Object.freeze({ ...item, read: true });
    });
    if (changed) this.#touch(recipient, next);
    return changed;
  }
  clear(recipient: string): void {
    this.#inboxes.delete(recipient);
  }
}

/**
 * User-scoped notifications with an unread count, delivered over realtime.
 * Each recipient has one private channel, `notify:<digest>`, derived from the
 * recipient key (no user id appears in channels, tokens or URLs). Use
 * `authorize` in `RealtimeModule({ authorizeChannel })` so only the
 * recipient's own identities may subscribe; every change publishes
 * `{ nvNotifications: { unread, latest? } }` on that channel. Reads and
 * writes through an identity only ever reach that identity's inbox.
 */
export class RealtimeNotifications {
  readonly #publisher: RealtimeNotificationsOptions['publisher'];
  readonly #recipient: (identity: RealtimeIdentity) => string | undefined;
  readonly #store: NotificationStore;
  readonly #limit: number;
  readonly #now: () => number;
  constructor(options: RealtimeNotificationsOptions) {
    if (typeof options?.publisher?.publish !== 'function')
      throw new Error('RealtimeNotifications requires a publisher');
    this.#publisher = options.publisher;
    this.#recipient =
      options.recipient ??
      ((identity) =>
        identity.principal
          ? `${identity.tenant ?? ''}\u0000${identity.principal.id}`
          : identity.binding);
    this.#store = options.store ?? new MemoryNotificationStore();
    this.#limit = options.maxPerRecipient ?? 100;
    if (
      !Number.isSafeInteger(this.#limit) ||
      this.#limit < 1 ||
      this.#limit > 1000
    )
      throw new Error('Notification maxPerRecipient must be 1–1000');
    this.#now = options.now ?? Date.now;
  }
  /** Opaque store key of a recipient. */
  static #key(recipient: string): string {
    if (typeof recipient !== 'string' || !recipient || recipient.length > 1024)
      throw new Error('Invalid notification recipient');
    return createHash('sha256')
      .update(`nestvexa-notifications\u0000${recipient}`)
      .digest('hex')
      .slice(0, 40);
  }
  /** The private channel of a recipient key (server-side use). */
  static channelFor(recipient: string): string {
    return `notify:${RealtimeNotifications.#key(recipient)}`;
  }
  #keyOf(identity: RealtimeIdentity): string | undefined {
    let recipient: string | undefined;
    try {
      recipient = this.#recipient(identity);
    } catch {
      return undefined;
    }
    return recipient === undefined
      ? undefined
      : RealtimeNotifications.#key(recipient);
  }
  #require(identity: RealtimeIdentity): string {
    const key = this.#keyOf(identity);
    if (key === undefined) throw new Error('This identity has no inbox');
    return key;
  }
  /** The identity's own channel (subscribe a Live component to it). */
  channel(identity: RealtimeIdentity): string {
    return `notify:${this.#require(identity)}`;
  }
  /**
   * Channel policy: true only for `notify:` channels that belong to this
   * identity. Combine it with the host's other rules in `authorizeChannel`.
   */
  authorize(identity: RealtimeIdentity, channel: string): boolean {
    if (typeof channel !== 'string' || !channelPattern.test(channel))
      return false;
    const key = this.#keyOf(identity);
    return key !== undefined && channel === `notify:${key}`;
  }
  /** Send one notification to a recipient key (for example a user id). */
  async notify(
    recipient: string,
    input: NotificationInput,
  ): Promise<RealtimeNotification> {
    const key = RealtimeNotifications.#key(recipient);
    const title = text(input?.title, 200, 'title');
    if (!title) throw new Error('Notification title is required');
    const body =
      input.body === undefined ? undefined : text(input.body, 2000, 'body');
    if (
      input.kind !== undefined &&
      (typeof input.kind !== 'string' || !kindPattern.test(input.kind))
    )
      throw new Error('Notification kind must be [a-z][a-z0-9-]{0,31}');
    const notification: RealtimeNotification = Object.freeze({
      id: randomUUID(),
      title,
      ...(body === undefined ? {} : { body }),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      data: publicJson(input.data),
      createdAt: this.#now(),
      read: false,
    });
    await this.#store.append(key, notification, this.#limit);
    await this.#changed(key, notification);
    return notification;
  }
  /** Send to the inbox of an identity (for example the acting user). */
  async notifyIdentity(
    identity: RealtimeIdentity,
    input: NotificationInput,
  ): Promise<RealtimeNotification> {
    const recipient = this.#recipient(identity);
    if (recipient === undefined) throw new Error('This identity has no inbox');
    return this.notify(recipient, input);
  }
  async #items(key: string): Promise<RealtimeNotification[]> {
    const items = await this.#store.list(key);
    return (Array.isArray(items) ? items : [])
      .slice(0, this.#limit)
      .flatMap((item: unknown) => stored(item) ?? []);
  }
  async #changed(key: string, latest?: RealtimeNotification): Promise<void> {
    const unread = (await this.#items(key)).filter((item) => !item.read).length;
    const event: NotificationEvent = {
      nvNotifications: latest === undefined ? { unread } : { unread, latest },
    };
    // Delivery is best effort; the inbox is the source of truth.
    await this.#publisher
      .publish(`notify:${key}`, event)
      .catch(() => undefined);
  }
  /** The identity's own notifications, newest first, with the unread count. */
  async list(
    identity: RealtimeIdentity,
    options: { readonly limit?: number; readonly unreadOnly?: boolean } = {},
  ): Promise<NotificationsSnapshot> {
    const limit = options.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new Error('Notification list limit must be 1–1000');
    const items = await this.#items(this.#require(identity));
    const unread = items.filter((item) => !item.read).length;
    const visible = options.unreadOnly
      ? items.filter((item) => !item.read)
      : items;
    return Object.freeze({
      unread,
      total: items.length,
      items: Object.freeze(visible.slice(0, limit)),
    });
  }
  /** Unread notifications of the identity's own inbox. */
  async unread(identity: RealtimeIdentity): Promise<number> {
    return (await this.list(identity, { limit: 1 })).unread;
  }
  /**
   * Mark the identity's own notifications read (all when `ids` is omitted).
   * Unknown or foreign ids change nothing. Returns how many changed.
   */
  async markRead(
    identity: RealtimeIdentity,
    ids?: readonly string[],
  ): Promise<number> {
    if (
      ids !== undefined &&
      (!Array.isArray(ids) ||
        ids.length > 1000 ||
        ids.some((id) => typeof id !== 'string' || !idPattern.test(id)))
    )
      throw new Error('Invalid notification ids');
    const key = this.#require(identity);
    const changed = await this.#store.markRead(key, ids);
    if (changed) await this.#changed(key);
    return changed;
  }
  /** Remove every notification of the identity's own inbox. */
  async clear(identity: RealtimeIdentity): Promise<void> {
    const key = this.#require(identity);
    await this.#store.clear(key);
    await this.#changed(key);
  }
  async close(): Promise<void> {
    await this.#store.close?.();
  }
}
