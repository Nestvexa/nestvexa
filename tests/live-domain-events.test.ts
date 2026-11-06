/**
 * LIVE-012 server-pushed domain events: `LiveEvents.publish` validates and
 * sends `{ nvEvent, payload }` through a structural publisher (no realtime
 * import); delivery back into `@OnEvent` actions keeps admission, host
 * authorization and pipes.
 */
import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Action,
  ActionInput,
  LIVE_DOMAIN_EVENT_FIELD,
  LiveComponent,
  LiveEvents,
  LiveModule,
  LiveRuntime,
  OnEvent,
  RealtimeChannels,
  State,
  liveDomainEvent,
} from '../packages/live/dist/index.js';
import type {
  JsonValue,
  LiveRuntimeFactoryOptions,
} from '../packages/live/dist/index.js';
import {
  application,
  cleanup,
  envelope,
  marker,
  platforms,
  policies,
  renderer,
  send,
} from './support/live-fixture.js';
import type { Platform } from './support/live-fixture.js';

afterEach(cleanup);

class MessageReference implements PipeTransform {
  transform(value: unknown): { id: string } {
    const id: unknown =
      value && typeof value === 'object' ? Reflect.get(value, 'id') : undefined;
    if (typeof id !== 'string' || !/^m[0-9]{1,6}$/.test(id))
      throw new BadRequestException('Invalid message reference');
    return { id };
  }
}

@LiveComponent({ name: 'inbox', view: 'inbox' })
class Inbox {
  @State() items: string[] = [];
  @RealtimeChannels() channels(): string[] {
    return ['team:alpha'];
  }
  @Action()
  @OnEvent('message.posted')
  posted(@ActionInput(new MessageReference()) input: { id: string }): void {
    this.items.push(input.id);
  }
}

interface Published {
  readonly channel: string;
  readonly data: JsonValue;
}

async function fixture(
  platform: Platform,
  extra: (published: Published[]) => Partial<LiveRuntimeFactoryOptions>,
  allow: (component: string, action: string) => boolean = () => true,
) {
  const published: Published[] = [];
  const { engine, module, resource } = await renderer({
    inbox: '<ul>{{#each items}}<li>{{this}}</li>{{/each}}</ul>',
  });
  const app = await application(
    platform,
    [
      LiveModule.registerAsync({
        components: [Inbox],
        imports: [module],
        useFactory: () => ({ ...policies(engine, allow), ...extra(published) }),
      }),
    ],
    [],
    resource,
  );
  return { app, published, events: app.get(LiveEvents) };
}

describe('liveDomainEvent message', () => {
  it('builds a frozen, detached, bounded message', () => {
    const payload = { id: 'm1', nested: { ok: true } };
    const message = liveDomainEvent('message.posted', payload);
    payload.nested.ok = false;
    expect(message).toEqual({
      [LIVE_DOMAIN_EVENT_FIELD]: 'message.posted',
      payload: { id: 'm1', nested: { ok: true } },
    });
    expect(Object.isFrozen(message)).toBe(true);
    expect(liveDomainEvent('ping').payload).toBeNull();
    for (const name of ['Bad', '1x', 'a b', '', 'x'.repeat(65)])
      expect(() => liveDomainEvent(name)).toThrow(/Event names/);
    expect(() => liveDomainEvent('big', 'x'.repeat(16_385))).toThrow(/16 KiB/);
    expect(() =>
      liveDomainEvent('proto', JSON.parse('{"__proto__":{"polluted":true}}')),
    ).toThrow();
  });
});

describe.each(platforms)('server-pushed domain events: %s', (platform) => {
  it('publishes through the structural events publisher with strict validation', async () => {
    const f = await fixture(platform, (published) => ({
      events: {
        publish: (channel: string, data: JsonValue) => {
          published.push({ channel, data });
        },
      },
    }));
    expect(f.events.enabled).toBe(true);
    await f.events.publish('team:alpha', 'message.posted', { id: 'm7' });
    expect(f.published).toEqual([
      {
        channel: 'team:alpha',
        data: { nvEvent: 'message.posted', payload: { id: 'm7' } },
      },
    ]);
    for (const channel of ['Team', '../x', '', 'a b'])
      await expect(f.events.publish(channel, 'message.posted')).rejects.toThrow(
        /channel/,
      );
    await expect(f.events.publish('team:alpha', 'NOPE')).rejects.toThrow(
      /Event names/,
    );
    expect(f.published).toHaveLength(1);
  });

  it('falls back to a realtime signer that can publish, and fails clearly without one', async () => {
    const withRealtime = await fixture(platform, (published) => ({
      realtime: {
        sign: () => undefined,
        publish(channel: string, data: JsonValue) {
          published.push({ channel, data });
          return Promise.resolve();
        },
      },
    }));
    await withRealtime.events.publish('team:alpha', 'message.posted', null);
    expect(withRealtime.published).toHaveLength(1);
    const without = await fixture(platform, () => ({}));
    expect(without.events.enabled).toBe(false);
    await expect(
      without.events.publish('team:alpha', 'message.posted'),
    ).rejects.toThrow(/publisher/);
  });

  it('delivers the payload to @OnEvent actions as untrusted, authorized input', async () => {
    const f = await fixture(platform, () => ({}));
    const html = (await f.app.get(LiveRuntime).mount(Inbox, { headers: {} }))
      .value;
    // The listener map tells the browser which action receives the event.
    expect(html).toContain(
      `data-nv-listeners="${JSON.stringify({ 'message.posted': ['posted'] }).replaceAll('"', '&quot;')}"`,
    );
    const reference = marker(html);
    const delivered = await send(
      f.app,
      '/_nestvexa/live/inbox/posted',
      envelope(reference, { input: { id: 'm1' } }),
    );
    expect(delivered.status).toBe(201);
    expect(delivered.json()['state']).toEqual({ items: ['m1'] });
    // A forged payload is just bad input: the pipe rejects it.
    const forged = await send(
      f.app,
      '/_nestvexa/live/inbox/posted',
      envelope({ ...reference, revision: 1 }, { input: { id: '<script>' } }),
    );
    expect(forged.status).toBe(400);
  });

  it('denies delivery when the host does not authorize the listener action', async () => {
    const f = await fixture(
      platform,
      () => ({}),
      (component, action) => !(component === 'inbox' && action === 'posted'),
    );
    const html = (await f.app.get(LiveRuntime).mount(Inbox, { headers: {} }))
      .value;
    const denied = await send(
      f.app,
      '/_nestvexa/live/inbox/posted',
      envelope(marker(html), { input: { id: 'm1' } }),
    );
    expect(denied.status).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'ACTION_FORBIDDEN' });
  });
});

describe('events option validation', () => {
  it('rejects a publisher without publish()', async () => {
    const { engine } = await renderer({ inbox: '' });
    expect(() =>
      LiveModule.register({
        ...policies(engine),
        components: [Inbox],
        events: {} as unknown as {
          publish(channel: string, data: JsonValue): unknown;
        },
      }),
    ).toThrow(/publish/);
  });
});
