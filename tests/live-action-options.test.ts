import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import {
  Action,
  ActionInput,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  State,
  enumSynthesizer,
  liveAbortSignal,
  nullableSynthesizer,
} from '../packages/live/dist/index.js';
import {
  application,
  cleanup,
  deferred,
  envelope,
  marker,
  platforms,
  policies,
  renderer,
  send,
  until,
} from './support/live-fixture.js';

const record = {
  charges: 0,
  tips: 0,
  entered: 0,
  aborted: 0,
  gate: deferred(),
};
beforeEach(() => {
  record.charges = 0;
  record.tips = 0;
  record.entered = 0;
  record.aborted = 0;
  record.gate = deferred();
});
afterEach(cleanup);

function waitForAbort(component: object): Promise<void> {
  const signal = liveAbortSignal(component);
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    signal.addEventListener('abort', () => {
      record.aborted++;
      resolve();
    });
  });
}

@LiveComponent({ name: 'checkout', view: 'checkout' })
class Checkout {
  @State() charged = 0;
  @State({ writable: true, synthesizer: nullableSynthesizer('string') })
  coupon: string | null = null;
  @State({
    writable: true,
    serializer: enumSynthesizer(['card', 'invoice'] as const),
  })
  method: 'card' | 'invoice' = 'card';
  @State({ default: () => ['welcome'] }) notes!: string[];

  @Action({ idempotent: true })
  pay(@ActionInput() input: unknown): void {
    if (typeof input !== 'number') throw new Error('amount');
    record.charges++;
    this.charged += input;
  }
  @Action()
  tip(): void {
    record.tips++;
    this.charged++;
  }
  @Action({ concurrency: 'identity' })
  async settle(): Promise<void> {
    record.entered++;
    await record.gate.wait;
  }
  @Action()
  async linger(): Promise<void> {
    record.entered++;
    await waitForAbort(this);
  }
  @Action({ renderless: true })
  touch(): void {
    this.charged += 0;
  }
}

@LiveComponent({ name: 'deadline', view: 'plain', timeoutMs: 150 })
class Deadline {
  @State() value = 0;
  @Action()
  async hang(): Promise<void> {
    await waitForAbort(this);
    // The deadline already failed the request; this late write is never committed.
    this.value = 99;
  }
}

@LiveComponent({ name: 'slow-mount', view: 'plain', timeoutMs: 100 })
class SlowMount {
  @State() value = 0;
  async mount(): Promise<void> {
    await waitForAbort(this);
  }
}

@Controller()
class Pages {
  constructor(@Inject(LiveRuntime) private readonly live: LiveRuntime) {}
  @Get('checkout')
  async checkout(@Req() req: object) {
    return { html: (await this.live.mount(Checkout, req)).value };
  }
  @Get('deadline')
  async deadline(@Req() req: object) {
    return { html: (await this.live.mount(Deadline, req)).value };
  }
  @Get('slow-mount')
  async slowMount(@Req() req: object) {
    return { html: (await this.live.mount(SlowMount, req)).value };
  }
}

async function boot(platform: (typeof platforms)[number]) {
  const env = await renderer({
    checkout:
      '<p>{{charged}}|{{coupon}}|{{method}}|{{#each notes}}{{this}}{{/each}}</p>',
    plain: '<p>{{value}}</p>',
  });
  const app = await application(
    platform,
    [
      LiveModule.registerAsync({
        components: [Checkout, Deadline, SlowMount],
        imports: [env.module],
        useFactory: () => policies(env.engine),
      }),
    ],
    [Pages],
    env.resource,
  );
  return { app, env };
}
async function mounted(app: INestApplication, path = '/checkout') {
  const page = await send(app, path);
  expect(page.status).toBe(200);
  const html = page.json()['html'];
  if (typeof html !== 'string') throw new Error('Missing mount HTML');
  return { html, reference: marker(html) };
}
const route = (component: string, action: string) =>
  `/_nestvexa/live/${component}/${action}`;

describe.each(platforms)('Live action options on %s', (platform) => {
  it('replays an identical idempotent retry without executing twice and rejects a reused ID with another payload', async () => {
    const { app } = await boot(platform);
    const { reference } = await mounted(app);
    const body = envelope(reference, { input: 25 });
    const first = await send(app, route('checkout', 'pay'), body);
    expect(first.status).toBe(201);
    expect(first.json()).toMatchObject({ state: { charged: 25 } });
    expect(first.json()['replayed']).toBeUndefined();
    const retry = await send(app, route('checkout', 'pay'), body);
    expect(retry.status).toBe(201);
    expect(retry.json()).toMatchObject({
      replayed: true,
      requestId: body.requestId,
      component: { revision: 1 },
      state: { charged: 25 },
    });
    expect(record.charges).toBe(1);
    const tampered = await send(app, route('checkout', 'pay'), {
      ...body,
      input: 2500,
    });
    expect(tampered.status).toBe(422);
    expect(tampered.json()).toEqual({
      statusCode: 422,
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(record.charges).toBe(1);
    // The committed state is unaffected and continues from revision 1.
    const next = await send(
      app,
      route('checkout', 'pay'),
      envelope({ snapshot: reference.snapshot, revision: 1 }, { input: 5 }),
    );
    expect(next.json()).toMatchObject({ state: { charged: 30 } });
  });

  it('never silently duplicates a non-idempotent action replay', async () => {
    const { app } = await boot(platform);
    const { reference } = await mounted(app);
    const body = envelope(reference);
    expect((await send(app, route('checkout', 'tip'), body)).status).toBe(201);
    const duplicate = await send(app, route('checkout', 'tip'), body);
    expect(duplicate.status).toBe(409);
    expect(duplicate.json()).toEqual({
      statusCode: 409,
      code: 'STALE_REVISION',
    });
    expect(record.tips).toBe(1);
  });

  it('rejects an overlapping identity-scoped action from another tab without consuming its state', async () => {
    const { app } = await boot(platform);
    const tabOne = await mounted(app);
    const tabTwo = await mounted(app);
    const running = send(
      app,
      route('checkout', 'settle'),
      envelope(tabOne.reference),
    );
    await until(() => record.entered === 1, 'first settle');
    const blocked = await send(
      app,
      route('checkout', 'settle'),
      envelope(tabTwo.reference),
    );
    expect(blocked.status).toBe(409);
    expect(blocked.json()).toEqual({ statusCode: 409, code: 'ACTION_BUSY' });
    // Component-scoped actions on the other tab still run concurrently.
    expect(
      (await send(app, route('checkout', 'tip'), envelope(tabTwo.reference)))
        .status,
    ).toBe(201);
    record.gate.release();
    expect((await running).status).toBe(201);
    // The rejected tab kept its revision-1 state and may settle now.
    const retried = await send(
      app,
      route('checkout', 'settle'),
      envelope({ snapshot: tabTwo.reference.snapshot, revision: 1 }),
    );
    expect(retried.status).toBe(201);
    expect(record.entered).toBe(2);
  });

  it('negotiates capabilities and rejects malformed headers before running guards or actions', async () => {
    const { app } = await boot(platform);
    const { reference } = await mounted(app);
    const malformed = await send(
      app,
      route('checkout', 'touch'),
      envelope(reference),
      { 'x-nestvexa-capabilities': 'renderless-v1;evil' },
    );
    expect(malformed.status).toBe(400);
    expect(malformed.json()).toEqual({
      statusCode: 400,
      code: 'INVALID_CAPABILITIES',
    });
    const negotiated = await send(
      app,
      route('checkout', 'touch'),
      envelope(reference),
      { 'x-nestvexa-capabilities': 'future-v3, renderless-v1' },
    );
    expect(negotiated.status).toBe(201);
    expect(negotiated.json()).toMatchObject({ renderless: true, html: '' });
    const plain = await send(
      app,
      route('checkout', 'touch'),
      envelope({ snapshot: reference.snapshot, revision: 1 }),
      { 'x-nestvexa-capabilities': 'future-v3' },
    );
    expect(plain.json()['renderless']).toBeUndefined();
    expect(plain.json()['html']).toContain('<p>');
  });

  it('applies state defaults and lets synthesizers own nullable and enum client updates', async () => {
    const { app } = await boot(platform);
    const { html, reference } = await mounted(app);
    expect(html).toContain('<p>0||card|welcome</p>');
    const coupon = await send(
      app,
      route('checkout', '_sync'),
      envelope(reference, { updates: { coupon: 'SAVE10', method: 'invoice' } }),
    );
    expect(coupon.status).toBe(201);
    expect(coupon.json()).toMatchObject({
      state: { coupon: 'SAVE10', method: 'invoice', notes: ['welcome'] },
    });
    const cleared = await send(
      app,
      route('checkout', '_sync'),
      envelope(
        { snapshot: reference.snapshot, revision: 1 },
        {
          updates: { coupon: null },
        },
      ),
    );
    expect(cleared.json()).toMatchObject({ state: { coupon: null } });
    for (const updates of [{ method: 'cash' }, { coupon: 7 }, { notes: [] }]) {
      const rejected = await send(
        app,
        route('checkout', '_sync'),
        envelope({ snapshot: reference.snapshot, revision: 2 }, { updates }),
      );
      expect(rejected.status).toBe(422);
      expect(['STATE_TYPE', 'STATE_LOCKED']).toContain(rejected.json()['code']);
    }
  });

  it('enforces component deadlines, aborts the operation signal and invalidates uncertain state', async () => {
    const { app } = await boot(platform);
    const { reference } = await mounted(app, '/deadline');
    const timedOut = await send(
      app,
      route('deadline', 'hang'),
      envelope(reference),
    );
    expect(timedOut.status).toBe(504);
    expect(timedOut.json()).toEqual({
      statusCode: 504,
      code: 'ACTION_TIMEOUT',
    });
    expect(record.aborted).toBe(1);
    const after = await send(
      app,
      route('deadline', 'hang'),
      envelope(reference),
    );
    expect(after.status).toBe(410);
    const mount = await send(app, '/slow-mount');
    expect(mount.status).toBe(504);
    expect(mount.json()).toEqual({ statusCode: 504, code: 'HOOK_TIMEOUT' });
  });

  it('drains in-flight actions on shutdown: their signal aborts and they answer 503', async () => {
    const { app, env } = await boot(platform);
    const { reference } = await mounted(app);
    const pending = send(app, route('checkout', 'linger'), envelope(reference));
    await until(() => record.entered === 1, 'lingering action');
    const closing = app.close();
    delete env.resource.app;
    const reply = await pending;
    expect(reply.status).toBe(503);
    expect(reply.json()).toEqual({ statusCode: 503, code: 'LIVE_SHUTDOWN' });
    expect(record.aborted).toBe(1);
    await closing;
  });
});
