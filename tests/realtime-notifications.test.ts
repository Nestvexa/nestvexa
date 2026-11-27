import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MemoryNotificationStore,
  RealtimeModule,
  RealtimeNotifications,
  RealtimeService,
} from '../packages/realtime/dist/index.js';
import type {
  NotificationStore,
  RealtimeIdentity,
} from '../packages/realtime/dist/index.js';

// REAL-009: user-scoped notifications with an unread count. Each recipient
// has one private `notify:<digest>` channel; the channel policy admits only
// that recipient's identities, every change publishes the unread count, and
// reads and writes through an identity reach only its own inbox.

const secret = 'realtime-notifications-secret-0123456789ab';
const origin = 'http://127.0.0.1:3999';
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
/** Two sessions of user u-alice in tenant acme, one of u-bob. */
const identities: Record<string, RealtimeIdentity> = {
  alice: {
    binding: 'acme/session-1/alice',
    principal: { id: 'u-alice' },
    tenant: 'acme',
  },
  alicePhone: {
    binding: 'acme/session-2/alice',
    principal: { id: 'u-alice' },
    tenant: 'acme',
  },
  bob: {
    binding: 'acme/session-3/bob-x',
    principal: { id: 'u-bob' },
    tenant: 'acme',
  },
  // Same user id in another tenant: a different inbox.
  aliceElsewhere: {
    binding: 'globex/session-4/alice',
    principal: { id: 'u-alice' },
    tenant: 'globex',
  },
};
const of = (name: string): RealtimeIdentity => {
  const identity = identities[name];
  if (!identity) throw new Error(name);
  return identity;
};

function inbox(
  options: Partial<ConstructorParameters<typeof RealtimeNotifications>[0]> = {},
) {
  const published: { channel: string; data: unknown }[] = [];
  const notifications = new RealtimeNotifications({
    publisher: {
      publish: async (channel, data) => {
        published.push({ channel, data });
      },
    },
    // The host's user key: tenant-scoped user id.
    recipient: (identity) =>
      identity.principal && identity.tenant
        ? `${identity.tenant}/${identity.principal.id}`
        : undefined,
    ...options,
  });
  return { notifications, published };
}

describe('RealtimeNotifications', () => {
  it('keeps one inbox per user across sessions, with an unread count', async () => {
    const { notifications, published } = inbox();
    const sent = await notifications.notify('acme/u-alice', {
      title: 'Invoice paid',
      body: 'Invoice 42 was paid.',
      kind: 'billing',
      data: { invoice: 42 },
    });
    await notifications.notify('acme/u-alice', { title: 'New comment' });
    const fromPhone = await notifications.list(of('alicePhone'));
    expect(fromPhone).toMatchObject({ unread: 2, total: 2 });
    expect(fromPhone.items.map((item) => item.title)).toEqual([
      'New comment',
      'Invoice paid',
    ]);
    expect(fromPhone.items[1]).toMatchObject({
      id: sent.id,
      body: 'Invoice 42 was paid.',
      kind: 'billing',
      data: { invoice: 42 },
      read: false,
    });
    // Both sessions of the user share one private channel.
    const channel = notifications.channel(of('alice'));
    expect(channel).toMatch(/^notify:[0-9a-f]{40}$/);
    expect(notifications.channel(of('alicePhone'))).toBe(channel);
    expect(channel).not.toContain('alice');
    expect(published.map((entry) => entry.channel)).toEqual([channel, channel]);
    expect(published[1]?.data).toMatchObject({
      nvNotifications: { unread: 2, latest: { title: 'New comment' } },
    });
    expect(await notifications.markRead(of('alice'), [sent.id])).toBe(1);
    expect(await notifications.unread(of('alicePhone'))).toBe(1);
    expect(published.at(-1)?.data).toEqual({ nvNotifications: { unread: 1 } });
    expect(
      (await notifications.list(of('alice'), { unreadOnly: true })).items,
    ).toHaveLength(1);
    expect(await notifications.markRead(of('alice'))).toBe(1);
    expect(await notifications.markRead(of('alice'))).toBe(0);
    expect(await notifications.unread(of('alice'))).toBe(0);
    await notifications.clear(of('alicePhone'));
    expect(await notifications.list(of('alice'))).toMatchObject({
      unread: 0,
      total: 0,
      items: [],
    });
  });

  it('never lets one identity read, mark or subscribe to another inbox', async () => {
    const { notifications } = inbox();
    const secretNote = await notifications.notify('acme/u-alice', {
      title: 'Private to Alice',
    });
    await notifications.notify('acme/u-bob', { title: 'For Bob' });
    expect(
      (await notifications.list(of('bob'))).items.map((i) => i.title),
    ).toEqual(['For Bob']);
    // Same user id in another tenant is another inbox.
    expect((await notifications.list(of('aliceElsewhere'))).total).toBe(0);
    // Bob cannot mark Alice's notification by id.
    expect(await notifications.markRead(of('bob'), [secretNote.id])).toBe(0);
    expect(await notifications.unread(of('alice'))).toBe(1);
    // Channel policy: only the owner's own channel.
    const aliceChannel = notifications.channel(of('alice'));
    expect(notifications.authorize(of('alice'), aliceChannel)).toBe(true);
    expect(notifications.authorize(of('alicePhone'), aliceChannel)).toBe(true);
    expect(notifications.authorize(of('bob'), aliceChannel)).toBe(false);
    expect(notifications.authorize(of('aliceElsewhere'), aliceChannel)).toBe(
      false,
    );
    for (const channel of ['notify:', 'orders:a', `${aliceChannel}x`, ''])
      expect(notifications.authorize(of('alice'), channel)).toBe(false);
    // Identities without an inbox are refused, not mapped to a shared one.
    const anonymous = { binding: 'anonymous-session-0001' };
    expect(notifications.authorize(anonymous, aliceChannel)).toBe(false);
    expect(() => notifications.channel(anonymous)).toThrow(/no inbox/);
    await expect(notifications.list(anonymous)).rejects.toThrow(/no inbox/);
  });

  it('bounds inboxes, validates input and ignores tampered stored records', async () => {
    const { notifications } = inbox({ maxPerRecipient: 3 });
    for (let index = 0; index < 5; index++)
      await notifications.notify('acme/u-alice', { title: `n${index}` });
    expect(
      (await notifications.list(of('alice'))).items.map((item) => item.title),
    ).toEqual(['n4', 'n3', 'n2']);
    for (const input of [
      { title: '' },
      { title: 'x'.repeat(201) },
      { title: 'ok', body: 'x'.repeat(2001) },
      { title: 'ok', kind: 'Bad Kind' },
      { title: 'ok', data: { blob: 'x'.repeat(5000) } },
      { title: 'ok', data: { loop: 1n } },
    ])
      await expect(notifications.notify('acme/u-alice', input)).rejects.toThrow(
        /Notification/,
      );
    await expect(notifications.notify('', { title: 'x' })).rejects.toThrow(
      /recipient/,
    );
    await expect(
      notifications.markRead(of('alice'), ['not-an-id']),
    ).rejects.toThrow(/ids/);
    await expect(notifications.list(of('alice'), { limit: 0 })).rejects.toThrow(
      /limit/,
    );
    expect(
      () =>
        new RealtimeNotifications({
          publisher: { publish: async () => undefined },
          maxPerRecipient: 0,
        }),
    ).toThrow(/maxPerRecipient/);
    // A shared store's contents are untrusted: invalid records are dropped.
    const memory = new MemoryNotificationStore();
    const tampered: NotificationStore = {
      append: (...args) => memory.append(...args),
      list: () =>
        [
          { id: 'bad', title: 'x', data: null, createdAt: 1, read: false },
          {
            id: '00000000-0000-4000-8000-000000000000',
            title: 'kept',
            data: null,
            createdAt: 1,
            read: false,
          },
          {
            id: '00000000-0000-4000-8000-000000000001',
            title: '<script>',
            read: 'no',
          },
        ] as never,
      markRead: () => 0,
      clear: () => undefined,
    };
    const guarded = inbox({ store: tampered }).notifications;
    expect(
      (await guarded.list(of('alice'))).items.map((item) => item.title),
    ).toEqual(['kept']);
  });

  it('defaults the recipient to the tenant-scoped principal, else the session binding', async () => {
    const notifications = new RealtimeNotifications({
      publisher: { publish: async () => undefined },
    });
    await notifications.notifyIdentity(of('alice'), { title: 'Hi' });
    expect((await notifications.list(of('alicePhone'))).total).toBe(1);
    expect((await notifications.list(of('aliceElsewhere'))).total).toBe(0);
    const guest = { binding: 'guest-session-0001' };
    await notifications.notifyIdentity(guest, { title: 'Guest' });
    expect((await notifications.list(guest)).total).toBe(1);
    expect(
      (await notifications.list({ binding: 'guest-session-0002' })).total,
    ).toBe(0);
  });

  it('caps the number of inboxes kept in memory', async () => {
    const store = new MemoryNotificationStore({ maxRecipients: 2 });
    const notifications = new RealtimeNotifications({
      publisher: { publish: async () => undefined },
      store,
    });
    const user = (id: string): RealtimeIdentity => ({
      binding: `acme/session/${id}-session`,
      principal: { id },
      tenant: 'acme',
    });
    for (const id of ['u1', 'u2', 'u3'])
      await notifications.notifyIdentity(user(id), { title: id });
    const at = (id: string) => notifications.list(user(id));
    // Recipient keys default to tenant + principal; the oldest inbox left.
    expect((await at('u1')).total).toBe(0);
    expect((await at('u3')).total).toBe(1);
    expect(() => new MemoryNotificationStore({ maxRecipients: 0 })).toThrow();
  });
});

function sse(url: string, user: string) {
  return new Promise<{ status: number; read: () => string; close: () => void }>(
    (resolve, reject) => {
      let text = '';
      const request = httpRequest(
        url,
        { headers: { 'x-user': user } },
        (response) => {
          response.on('data', (chunk: Buffer) => (text += chunk.toString()));
          resolve({
            status: response.statusCode ?? 0,
            read: () => text,
            close: () => request.destroy(),
          });
        },
      );
      cleanup.push(() => {
        request.destroy();
      });
      request.on('error', (error) => (text ? undefined : reject(error)));
      request.end();
    },
  );
}
const until = async (check: () => boolean) => {
  for (let index = 0; index < 250 && !check(); index++)
    await new Promise((resolve) => setTimeout(resolve, 20));
};

describe.each(['express', 'fastify'] as const)(
  'notifications over realtime on %s',
  (platform) => {
    it('delivers the unread count to every session of the recipient only', async () => {
      const slot: { notifications?: RealtimeNotifications } = {};
      const module = await Test.createTestingModule({
        imports: [
          RealtimeModule.forRoot({
            secrets: [secret],
            origin,
            resolveIdentity: (request) => {
              const user: unknown = Reflect.get(
                Reflect.get(request, 'headers') as object,
                'x-user',
              );
              const identity =
                typeof user === 'string' ? identities[user] : undefined;
              if (!identity) throw new Error('anonymous');
              return { binding: identity.binding };
            },
            // The policy: each identity may read its own inbox channel only.
            authorizeChannel: (identity, channel) =>
              slot.notifications?.authorize(identity, channel) ?? false,
          }),
        ],
      }).compile();
      const app: INestApplication =
        platform === 'fastify'
          ? module.createNestApplication(new FastifyAdapter(), {
              logger: false,
            })
          : module.createNestApplication({ logger: false });
      await app.listen(0, '127.0.0.1');
      cleanup.push(() => app.close());
      const realtime = app.get(RealtimeService);
      // Without kernel identity the hub sees bindings only: the host maps a
      // binding to its user key.
      const users = new Map(
        Object.values(identities).map((identity) => [
          identity.binding,
          `${identity.tenant ?? ''}/${identity.principal?.id ?? ''}`,
        ]),
      );
      const notifications = new RealtimeNotifications({
        publisher: realtime,
        recipient: (identity) => users.get(identity.binding),
      });
      slot.notifications = notifications;
      const base = `${await app.getUrl()}/_nestvexa/realtime/sse?t=`;
      const subscribe = async (user: string) => {
        const identity = { binding: of(user).binding };
        const token =
          (await realtime.sign(identity, [notifications.channel(identity)])) ??
          '';
        return { token, stream: await sse(base + token, user) };
      };
      const laptop = await subscribe('alice');
      const phone = await subscribe('alicePhone');
      const bob = await subscribe('bob');
      await until(() => realtime.hub.size === 3);
      expect(realtime.hub.size).toBe(3);
      await notifications.notify('acme/u-alice', {
        title: 'Build finished',
        data: { build: 7 },
      });
      for (const { stream } of [laptop, phone]) {
        await until(() => stream.read().includes('nvNotifications'));
        expect(stream.read()).toContain('"unread":1');
        expect(stream.read()).toContain('Build finished');
      }
      await notifications.markRead({ binding: of('alicePhone').binding });
      await until(() => laptop.stream.read().includes('"unread":0'));
      expect(laptop.stream.read()).toContain('"unread":0');
      // Bob's stream carried nothing of Alice's.
      expect(bob.stream.read()).not.toContain('nvNotifications');
      // Bob can neither sign Alice's channel nor use Alice's token.
      expect(
        await realtime.sign({ binding: of('bob').binding }, [
          notifications.channel({ binding: of('alice').binding }),
        ]),
      ).toBeUndefined();
      const stolen = await sse(base + laptop.token, 'bob');
      expect(stolen.status).toBe(403);
    });
  },
);
