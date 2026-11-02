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
import type {
  ComputedOptions,
  UrlOptions,
  SessionOptions,
  LiveRenderContext,
} from 'nestvexa';
import {
  Action,
  ActionInput,
  Computed,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  State,
  Url,
  Session,
} from '@nestvexa/live';
import {
  createLiveClient,
  parseDirective,
  parseLoadingDirective,
  parseLoadingTarget,
} from '@nestvexa/client';
import {
  ActionContext as ServerActionContext,
  ActionGroup,
  ActionInput as ServerActionInput,
  ActionsModule,
  ServerAction,
} from '@nestvexa/actions';
import { createActionsClient } from '@nestvexa/actions/client';
import { generateActionClient } from '@nestvexa/actions/codegen';
import type {
  LiveDirective,
  LoadingDirective,
  ReplacementDirective,
} from '@nestvexa/client';

// Importing a browser entry in Node must not initialize a document or a global runtime.
assert.equal(typeof createLiveClient, 'function');
const replacement: LiveDirective = parseDirective('nv:replace.self', '');
assert.deepEqual(replacement, {
  kind: 'replace',
  self: true,
} satisfies ReplacementDirective);
const loading: LoadingDirective = parseLoadingDirective(
  'nv:loading.attr',
  'disabled',
);
assert.deepEqual(loading, {
  kind: 'loading',
  mode: 'attr',
  remove: false,
  attribute: 'disabled',
});
assert.deepEqual(parseLoadingTarget('increment, $sync'), [
  'increment',
  '$sync',
]);
assert.throws(() => parseLoadingDirective('nv:loading.attr', 'onclick'));
assert.deepEqual(parseDirective('nv:poll.2s', 'refresh'), {
  kind: 'poll',
  value: 'refresh',
  intervalMs: 2000,
});
assert.deepEqual(parseDirective('nv:init.visible', 'load'), {
  kind: 'init',
  value: 'load',
  timing: 'visible',
});
assert.equal(typeof Url({ key: 'q' } satisfies UrlOptions), 'function');
assert.equal(
  typeof Session({ ttl: 1000 } satisfies SessionOptions),
  'function',
);
const renderedContexts: string[] = [];

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
    actionGuardCalls++;
    return (
      context.switchToHttp().getRequest<{ headers: Record<string, string> }>()
        .headers['x-pack-allow'] === 'yes'
    );
  }
}
let actionGuardCalls = 0;
let componentGuardCalls = 0;
let syncAllowed = true;
const computedOptions: ComputedOptions = {
  async: true,
  dependencies: ['count'],
  ttl: 100,
};
@Injectable()
class ComponentGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    componentGuardCalls++;
    return (
      context.switchToHttp().getRequest<{ headers: Record<string, string> }>()
        .headers['x-pack-block'] !== 'yes'
    );
  }
}
@Module({ providers: [CounterService], exports: [CounterService] })
class ServicesModule {}
@LiveComponent({ name: 'packed-counter', view: 'counter' })
@UseGuards(ComponentGuard)
class Counter {
  // No explicit @Inject: external tsc must emit usable Nest constructor metadata.
  constructor(private readonly service: CounterService) {}
  @State() count = 0;
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 16,
  })
  label = '';
  afterRender(context: LiveRenderContext): void {
    renderedContexts.push(context.html);
  }
  @Computed(computedOptions)
  async doubled(): Promise<number> {
    return this.count * 2;
  }
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
        ['$mount', '$sync', 'increment', 'set'].includes(action) &&
        (action !== '$sync' || syncAllowed),
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
  assert.ok(html.includes('<b>0</b>'));
  assert.equal(renderedContexts.length, 1);
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
  assert.equal(result['html'], '<output>2</output><b>4</b>');
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
  const syncBody = {
    ...body,
    requestId: randomUUID(),
    revision: 2,
    updates: { label: 'too long for the declared validator' },
  };
  const syncUrl = `${base}/_nestvexa/live/packed-counter/_sync`;
  const beforePolicyDenial = componentGuardCalls;
  syncAllowed = false;
  const policyDenied = await fetch(syncUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(syncBody),
  });
  assert.equal(policyDenied.status, 403);
  assert.equal(componentGuardCalls, beforePolicyDenial);
  syncAllowed = true;
  const classDenied = await fetch(syncUrl, {
    method: 'POST',
    headers: { ...headers, 'x-pack-block': 'yes' },
    body: JSON.stringify(syncBody),
  });
  assert.equal(classDenied.status, 403);
  assert.equal(componentGuardCalls, beforePolicyDenial + 1);
  const invalid = await fetch(syncUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(syncBody),
  });
  assert.equal(invalid.status, 422);
  assert.equal(record(await invalid.json())['code'], 'STATE_INVALID');
  const actionGuardsBeforeSync = actionGuardCalls;
  const synchronized = await fetch(syncUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...syncBody,
      requestId: randomUUID(),
      updates: { label: '<safe>' },
    }),
  });
  assert.equal(synchronized.status, 201);
  assert.equal(synchronized.headers.get('cache-control'), 'no-store');
  const synchronizedResult = record(await synchronized.json());
  assert.equal(record(synchronizedResult['state'])['label'], '<safe>');
  assert.equal(record(synchronizedResult['state'])['count'], 7);
  assert.equal(record(synchronizedResult['component'])['revision'], 3);
  assert.equal(synchronizedResult['snapshot'], snapshot);
  assert.equal(componentGuardCalls, beforePolicyDenial + 3);
  assert.equal(actionGuardCalls, actionGuardsBeforeSync);
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
    'Packed strict-TS consumer passed: MVC, Live, DI metadata, guards, pipe, recoverable sync validation, policy, replay and Node-safe client import.',
  );
} finally {
  await app.close();
  await renderer.dispose();
}

// Universal server actions from the packed tarball: real Nest route, typed
// client generation from this very file and the browser-safe client in Node.
@ActionGroup('pack')
class PackActions {
  @ServerAction({ id: 'echo', idempotent: true })
  echo(
    @ServerActionInput() input: { text: string },
    @ServerActionContext() context: ServerActionContext,
  ) {
    return {
      text: String(input.text),
      subject: context.identity.subject,
      at: new Date(0),
    };
  }
}
@Module({
  imports: [
    ActionsModule.register({
      groups: [PackActions],
      origin,
      resolveIdentity: () => ({ subject: 'packed-user', csrfToken: csrf }),
      authorize: (_identity, action) => action.group === 'pack',
    }),
  ],
})
class ActionsApp {}
const generated = await generateActionClient({
  files: ['consumer.ts'],
  outDir: 'generated',
  write: false,
});
assert.ok(generated.ok, JSON.stringify(generated.diagnostics));
assert.ok(
  generated.files[1]?.contents.includes(
    'readonly echo: ActionMethod<{ text: string }, { text: string; subject: string; at: string }>;',
  ),
);
const actionsApp = await NestFactory.create(ActionsApp, { logger: false });
try {
  await actionsApp.listen(0, '127.0.0.1');
  const client = createActionsClient({
    baseUrl: await actionsApp.getUrl(),
    csrf,
    headers: { origin },
  });
  const bound = client.bind({
    pack: {
      echo: { group: 'pack', action: 'echo', version: null, idempotent: true },
    },
  });
  assert.deepEqual(await bound['pack']?.['echo']?.({ text: 'hi' }), {
    text: 'hi',
    subject: 'packed-user',
    at: '1970-01-01T00:00:00.000Z',
  });
  await assert.rejects(
    client.call(
      { group: 'pack', action: 'echo', version: null, idempotent: false },
      { text: 'no idempotency key' },
    ),
    (error: unknown) =>
      error instanceof Error && Reflect.get(error, 'code') === 'VALIDATION',
  );
  console.log(
    'Packed actions consumer passed: explicit group route, generated types from the tarball and typed client.',
  );
} finally {
  await actionsApp.close();
}
