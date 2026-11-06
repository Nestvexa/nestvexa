import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import {
  Action,
  ActionInput,
  LIVE_CAPABILITIES,
  LIVE_PROTOCOL,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  State,
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

afterEach(cleanup);

@LiveComponent({ name: 'wallet', view: 'wallet' })
class Wallet {
  @State() balance = 0;
  @Action({ idempotent: true })
  deposit(@ActionInput() amount: unknown): void {
    if (typeof amount !== 'number') throw new Error('amount');
    this.balance += amount;
  }
  @Action({ id: 'refund-all', idempotent: true })
  refundAll(): void {
    this.balance = 0;
  }
  @Action()
  tip(): void {
    this.balance++;
  }
}
@LiveComponent({ name: 'plain-counter', view: 'wallet' })
class Plain {
  @State() balance = 0;
  @Action()
  tip(): void {
    this.balance++;
  }
}

@Controller()
class Pages {
  constructor(@Inject(LiveRuntime) private readonly live: LiveRuntime) {}
  @Get('wallet')
  async wallet(@Req() req: object) {
    return { html: (await this.live.mount(Wallet, req)).value };
  }
  @Get('plain')
  async plain(@Req() req: object) {
    return { html: (await this.live.mount(Plain, req)).value };
  }
}

async function boot(platform: (typeof platforms)[number]) {
  const env = await renderer({ wallet: '<p>{{balance}}</p>' });
  return application(
    platform,
    [
      LiveModule.registerAsync({
        components: [Wallet, Plain],
        imports: [env.module],
        useFactory: () => policies(env.engine),
      }),
    ],
    [Pages],
    env.resource,
  );
}
async function page(app: INestApplication, path: string) {
  const reply = await send(app, path);
  const html = reply.json()['html'];
  if (typeof html !== 'string') throw new Error('Missing mount HTML');
  return html;
}

describe.each(platforms)('client negotiation over %s', (platform) => {
  it('marks idempotent actions for safe browser retries, and only those', async () => {
    const app = await boot(platform);
    const wallet = await page(app, '/wallet');
    expect(wallet).toContain(
      'data-nv-idempotent="[&quot;deposit&quot;,&quot;refund-all&quot;]"',
    );
    expect(await page(app, '/plain')).not.toContain('data-nv-idempotent');
  }, 60_000);

  it('advertises the protocol major and capabilities on action and $sync replies', async () => {
    const app = await boot(platform);
    const ref = marker(await page(app, '/wallet'));
    const acted = await send(app, '/_nestvexa/live/wallet/tip', envelope(ref));
    expect(acted.status).toBe(201);
    expect(acted.headers['x-nestvexa-protocol']).toBe(LIVE_PROTOCOL);
    expect(acted.headers['x-nestvexa-capabilities']).toBe(
      LIVE_CAPABILITIES.join(','),
    );
    expect(acted.headers['cache-control']).toBe('no-store');
    const next = {
      snapshot: String(acted.json()['snapshot']),
      revision: ref.revision + 1,
    };
    const synced = await send(
      app,
      '/_nestvexa/live/wallet/_sync',
      envelope(next),
    );
    expect(synced.status).toBe(201);
    expect(synced.headers['x-nestvexa-protocol']).toBe(LIVE_PROTOCOL);
  });

  it('answers another protocol major with 426 for the browser reload path', async () => {
    const app = await boot(platform);
    const ref = marker(await page(app, '/wallet'));
    const reply = await send(app, '/_nestvexa/live/wallet/tip', {
      ...envelope(ref),
      protocol: 'nestvexa-live/2',
    });
    expect(reply.status).toBe(426);
    expect(reply.json()['code']).toBe('UNSUPPORTED_PROTOCOL');
  });

  it('replays an identical idempotent retry instead of executing it twice', async () => {
    const app = await boot(platform);
    const ref = marker(await page(app, '/wallet'));
    const body = envelope(ref, { input: 5 });
    const first = await send(app, '/_nestvexa/live/wallet/deposit', body);
    const retry = await send(app, '/_nestvexa/live/wallet/deposit', body);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.json()['replayed']).toBe(true);
    expect(retry.json()['state']).toEqual({ balance: 5 });
  });
});
