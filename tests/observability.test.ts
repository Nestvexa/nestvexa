import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import {
  Action,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  State,
} from '../packages/live/dist/index.js';
import {
  DevtoolsModule,
  MemoryInstrumentation,
  combineInstrumentation,
  createLogger,
  openTelemetryInstrumentation,
  redact,
} from '../packages/observability/dist/index.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
});

describe('instrumentation adapters', () => {
  it('bridges to an OpenTelemetry-shaped tracer with outcome status only', () => {
    const spans: {
      name: string;
      attributes: Record<string, unknown>;
      status?: number;
      ended: boolean;
    }[] = [];
    const tracer = {
      startSpan(
        name: string,
        options?: { attributes?: Record<string, string | number | boolean> },
      ) {
        const span = {
          name,
          attributes: { ...options?.attributes } as Record<string, unknown>,
          status: undefined as number | undefined,
          ended: false,
        };
        spans.push(span);
        return {
          setAttribute: (key: string, value: unknown) => {
            span.attributes[key] = value;
          },
          setStatus: (status: { code: number }) => {
            span.status = status.code;
          },
          end: () => {
            span.ended = true;
          },
        };
      },
    };
    const instrumentation = openTelemetryInstrumentation(tracer);
    const ok = instrumentation.start('nestvexa.live.render', {
      'nestvexa.component': 'counter',
    });
    ok.end('ok', { 'nestvexa.html_bytes': 42 });
    ok.end('error');
    instrumentation
      .start('nestvexa.live.action', {})
      .end('error', { status: 403 });
    expect(spans).toEqual([
      {
        name: 'nestvexa.live.render',
        attributes: {
          'nestvexa.component': 'counter',
          'nestvexa.html_bytes': 42,
        },
        status: 1,
        ended: true,
      },
      {
        name: 'nestvexa.live.action',
        attributes: { status: 403 },
        status: 2,
        ended: true,
      },
    ]);
  });

  it('summarizes percentiles and fans out to several targets', () => {
    let now = 0;
    const memory = new MemoryInstrumentation(3, () => now);
    const other = new MemoryInstrumentation();
    const combined = combineInstrumentation(memory, other);
    for (const duration of [10, 20, 30, 40]) {
      const span = combined.start('render', {});
      now += duration;
      span.end(duration === 40 ? 'error' : 'ok');
    }
    expect(memory.records).toHaveLength(3);
    expect(memory.summary()).toEqual([
      { name: 'render', count: 3, errors: 1, p50: 30, p95: 40, max: 40 },
    ]);
    expect(other.records).toHaveLength(4);
  });

  it('redacts sensitive keys in structured logs and bounds values', () => {
    expect(
      redact({
        user: 'ada',
        password: 'x',
        nested: { csrfToken: 'y', items: [{ apiKey: 'z' }] },
        note: 'a'.repeat(3000),
      }),
    ).toEqual({
      user: 'ada',
      password: '[redacted]',
      nested: { csrfToken: '[redacted]', items: [{ apiKey: '[redacted]' }] },
      note: 'a'.repeat(2048) + '…',
    });
    const lines: string[] = [];
    createLogger((line) => lines.push(line)).warn('login failed', {
      sessionId: 'abc',
      attempts: 3,
    });
    const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: 'warn',
      message: 'login failed',
      sessionId: '[redacted]',
      attempts: 3,
    });
  });
});

async function liveApp(instrumentation: MemoryInstrumentation) {
  const root = await mkdtemp(join(tmpdir(), 'nestvexa-obs-'));
  await writeFile(
    join(root, 'secretive.hbs'),
    '<p>{{count}} {{privateNote}}</p>',
  );
  const renderer = new HbsEngine({ root });
  await renderer.initialize();
  @LiveComponent({ name: 'secretive', view: 'secretive' })
  class Secretive {
    @State() count = 0;
    @State() privateNote = 'do-not-trace-this-value';
    @Action() bump(): void {
      this.count++;
    }
    @Action() explode(): void {
      throw new Error('internal failure detail');
    }
  }
  const csrf = 'observability-csrf-0123456789012345678901';
  const module = await Test.createTestingModule({
    imports: [
      LiveModule.register({
        components: [Secretive],
        renderer,
        origin: 'http://localhost:3100',
        resolveIdentity: () => ({
          binding: 'tenant/session/alice-binding',
          csrfToken: csrf,
        }),
        authorize: () => true,
        instrumentation,
      }),
    ],
  }).compile();
  const app: INestApplication = module.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  cleanup.push(async () => {
    await app.close();
    await renderer.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const html = (await app.get(LiveRuntime).mount(Secretive, { headers: {} }))
    .value;
  const snapshot = /data-nv-snapshot="([^"]+)"/.exec(html)?.[1] ?? '';
  const base = await app.getUrl();
  const post = (action: string, revision: number) =>
    fetch(`${base}/_nestvexa/live/secretive/${action}`, {
      method: 'POST',
      headers: {
        origin: 'http://localhost:3100',
        'content-type': 'application/json',
        'x-nestvexa-csrf': csrf,
      },
      body: JSON.stringify({
        protocol: 'nestvexa-live/1',
        requestId: randomUUID(),
        snapshot,
        revision,
        updates: {},
        input: null,
      }),
    });
  return { post };
}

describe('Live runtime spans', () => {
  it('traces mount, action and render with names and sizes but no state, identity or errors', async () => {
    const memory = new MemoryInstrumentation();
    const f = await liveApp(memory);
    expect((await f.post('bump', 0)).status).toBe(201);
    expect((await f.post('explode', 1)).status).toBe(500);
    const names = memory.records.map(
      (record) => `${record.name}:${record.outcome}`,
    );
    expect(names).toEqual([
      'nestvexa.live.render:ok',
      'nestvexa.live.mount:ok',
      'nestvexa.live.render:ok',
      'nestvexa.live.action:ok',
      'nestvexa.live.action:error',
    ]);
    expect(memory.records[3]?.attributes).toEqual({
      'nestvexa.component': 'secretive',
      'nestvexa.action': 'bump',
      'nestvexa.revision': 0,
    });
    expect(
      memory.records[0]?.attributes['nestvexa.html_bytes'],
    ).toBeGreaterThan(0);
    const serialized = JSON.stringify(memory.records);
    for (const secret of [
      'do-not-trace-this-value',
      'alice-binding',
      'csrf',
      'internal failure detail',
    ])
      expect(serialized).not.toContain(secret);
  });

  it('never lets a failing instrumentation hook break requests', async () => {
    const broken = new MemoryInstrumentation();
    broken.start = () => {
      throw new Error('collector down');
    };
    const f = await liveApp(broken);
    expect((await f.post('bump', 0)).status).toBe(201);
  });
});

describe('devtools panel', () => {
  it('refuses production registration and requires host authorization', async () => {
    const memory = new MemoryInstrumentation();
    expect(() =>
      DevtoolsModule.register({
        instrumentation: memory,
        authorize: () => true,
        environment: 'production',
      }),
    ).toThrow(/must not be registered in production/);
    let allowed = false;
    memory
      .start('nestvexa.live.render', {
        'nestvexa.component': '<script>x</script>',
      })
      .end('ok');
    const module = await Test.createTestingModule({
      imports: [
        DevtoolsModule.register({
          instrumentation: memory,
          authorize: () => allowed,
          environment: 'development',
        }),
      ],
    }).compile();
    const app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    cleanup.push(() => app.close());
    const base = await app.getUrl();
    expect((await fetch(`${base}/_nestvexa/devtools`)).status).toBe(403);
    allowed = true;
    const page = await fetch(`${base}/_nestvexa/devtools`);
    const html = await page.text();
    expect(page.headers.get('content-security-policy')).toContain(
      "default-src 'none'",
    );
    expect(html).toContain('nestvexa.live.render');
    expect(html).not.toContain('<script>x</script>');
    const json = (await (
      await fetch(`${base}/_nestvexa/devtools/spans.json`)
    ).json()) as { summary: { count: number }[] };
    expect(json.summary[0]?.count).toBe(1);
  });
});
