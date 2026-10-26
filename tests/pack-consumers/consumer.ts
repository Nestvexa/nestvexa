import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  Controller,
  Get,
  Injectable,
  Module,
  ParseIntPipe,
  Render,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HbsEngine, NestvexaModule, configureNestvexa } from 'nestvexa';
import {
  Action,
  ActionInput,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  State,
} from '@nestvexa/live';
import { createLiveClient } from '@nestvexa/client';

// Importing a browser entry in Node must not initialize a document or a global runtime.
assert.equal(typeof createLiveClient, 'function');

@Injectable()
class CounterService {
  readonly privateValue = 'fixture-service-data-not-public';
  step(): number {
    return 2;
  }
}
@Injectable()
class ActionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    return (
      context.switchToHttp().getRequest<{ headers: Record<string, string> }>()
        .headers['x-pack-allow'] === 'yes'
    );
  }
}
@Module({ providers: [CounterService], exports: [CounterService] })
class ServicesModule {}
@LiveComponent({ name: 'packed-counter', view: 'counter' })
class Counter {
  // No explicit @Inject: external tsc must emit usable Nest constructor metadata.
  constructor(private readonly service: CounterService) {}
  @State() count = 0;
  @Action()
  @UseGuards(ActionGuard)
  increment(): void {
    this.count += this.service.step();
  }
  @Action()
  set(@ActionInput(new ParseIntPipe()) value: number): void {
    this.count = value;
  }
}
const origin = 'http://localhost';
const csrf = 'packed-consumer-host-csrf-0123456789abcdef';
const renderer = new HbsEngine({ root: 'views' });
@Controller()
class Home {
  constructor(private readonly live: LiveRuntime) {}
  @Get()
  @Render('home')
  async index(@Req() request: object) {
    return {
      message: '<safe>',
      widget: await this.live.mount(Counter, request),
    };
  }
}
@Module({
  imports: [
    NestvexaModule.forRoot({ views: { root: 'views' } }),
    LiveModule.register({
      components: [Counter],
      imports: [ServicesModule],
      renderer,
      origin,
      // This hermetic packaging fixture uses a fixed host identity; cookie/session security has separate tests.
      resolveIdentity: () => ({
        binding: 'packed-consumer/session/principal',
        csrfToken: csrf,
      }),
      authorize: (_identity, component, action) =>
        component === 'packed-counter' &&
        ['$mount', 'increment', 'set'].includes(action),
    }),
  ],
  controllers: [Home],
})
class App {}
function record(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}
const app = await NestFactory.create(App, { logger: false });
try {
  await configureNestvexa(app);
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const response = await fetch(base);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.ok(html.startsWith('<h1>&lt;safe&gt;</h1>'));
  assert.ok(html.includes('<output>0</output>'));
  assert.ok(!html.includes('fixture-service-data-not-public'));
  const snapshot = /data-nv-snapshot="([^"]+)"/.exec(html)?.[1];
  assert.ok(snapshot);
  const headers = {
    'content-type': 'application/json',
    origin,
    'x-nestvexa-csrf': csrf,
  };
  const body = {
    protocol: 'nestvexa-live/1',
    requestId: randomUUID(),
    snapshot,
    revision: 0,
    updates: {},
    input: null,
  };
  const denied = await fetch(
    `${base}/_nestvexa/live/packed-counter/increment`,
    { method: 'POST', headers, body: JSON.stringify(body) },
  );
  assert.equal(denied.status, 403);
  const allowed = await fetch(
    `${base}/_nestvexa/live/packed-counter/increment`,
    {
      method: 'POST',
      headers: { ...headers, 'x-pack-allow': 'yes' },
      body: JSON.stringify(body),
    },
  );
  assert.ok(allowed.ok);
  const result = record(await allowed.json());
  assert.equal(record(result['state'])['count'], 2);
  assert.equal(record(result['component'])['revision'], 1);
  assert.equal(result['html'], '<output>2</output>');
  const updated = await fetch(`${base}/_nestvexa/live/packed-counter/set`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...body,
      requestId: randomUUID(),
      revision: 1,
      input: '7',
    }),
  });
  assert.ok(updated.ok);
  assert.equal(record(record(await updated.json())['state'])['count'], 7);
  const replay = await fetch(
    `${base}/_nestvexa/live/packed-counter/increment`,
    {
      method: 'POST',
      headers: { ...headers, 'x-pack-allow': 'yes' },
      body: JSON.stringify(body),
    },
  );
  assert.equal(replay.status, 409);
  console.log(
    'Packed strict-TS consumer passed: MVC, Live, DI metadata, guard, pipe, replay and Node-safe client import.',
  );
} finally {
  await app.close();
  await renderer.dispose();
}
