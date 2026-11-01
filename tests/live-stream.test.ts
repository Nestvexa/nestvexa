import 'reflect-metadata';
import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Module,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import {
  LiveComponent,
  LiveModule,
  LiveRuntime,
  State,
} from '../packages/live/dist/index.js';
import {
  createTextStreamResponse,
  parseTextStreamRequest,
} from '../packages/live/dist/text-stream.js';

const csrf = 'stream-fixture-csrf-0123456789abcdef0123456789';
const origin = 'http://localhost:3100';
const envelope = {
  protocol: 'nestvexa-stream/1',
  requestId: 'test-request',
  snapshot: 'A'.repeat(43),
  revision: 0,
};
describe('text stream envelope', () => {
  it('accepts and freezes the exact request', () => {
    expect(parseTextStreamRequest(envelope)).toEqual(envelope);
    expect(Object.isFrozen(parseTextStreamRequest(envelope))).toBe(true);
  });
  it('rejects getters without reading them and refuses non-JSON object shapes', () => {
    let reads = 0;
    const getter = Object.defineProperty({ ...envelope }, 'snapshot', {
      enumerable: true,
      get() {
        reads++;
        return envelope.snapshot;
      },
    });
    expect(() => parseTextStreamRequest(getter)).toThrow();
    expect(reads).toBe(0);
    expect(() =>
      parseTextStreamRequest(
        Object.assign(Object.create({ inherited: true }), envelope),
      ),
    ).toThrow();
    expect(() =>
      parseTextStreamRequest({ ...envelope, [Symbol('hidden')]: true }),
    ).toThrow();
  });
  it.each([
    null,
    [],
    {},
    { ...envelope, userId: 'forged' },
    { ...envelope, protocol: 'future' },
    { ...envelope, revision: -1 },
    { ...envelope, revision: 0.5 },
    { ...envelope, snapshot: 'x' },
    { ...envelope, requestId: 'unsafe\nheader' },
    { ...envelope, requestId: 'x'.repeat(129) },
  ])('rejects malformed or identity-bearing request %j', (body) => {
    expect(() => parseTextStreamRequest(body)).toThrow();
  });
});
interface HostRequest {
  readonly headers: Record<string, string | undefined>;
  readonly body: unknown;
}
interface Mounted {
  readonly snapshot: string;
  readonly revision: number;
}
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !check(); attempt += 1)
    await delay(10);
  expect(check()).toBe(true);
}

for (const platform of ['express', 'fastify'] as const)
  describe(`real Nest ${platform} text streams`, () => {
    let app: INestApplication;
    let engine: HbsEngine;
    let directory: string;
    let base: string;
    let revoked = false;
    let aborted = 0;
    let produced = 0;
    let cleanupThrows = 0;
    let releaseGate: (() => void) | undefined;
    const orphanReleases: (() => void)[] = [];
    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'nestvexa-text-stream-'));
      await writeFile(join(directory, 'report.hbs'), '<p>{{title}}</p>');
      engine = new HbsEngine({ root: directory });
      await engine.initialize();
      @LiveComponent({ name: 'report', view: 'report' })
      class Report {
        @State() title = 'A report';
      }
      class HostGuard implements CanActivate {
        canActivate(context: ExecutionContext): boolean {
          if (
            context.switchToHttp().getRequest<HostRequest>().headers['x-deny']
          )
            throw new ForbiddenException();
          return true;
        }
      }
      @Controller()
      class HostController {
        constructor(@Inject(LiveRuntime) readonly runtime: LiveRuntime) {}
        @Get('mount') async mount(@Req() request: HostRequest) {
          return { html: (await this.runtime.mount(Report, request)).value };
        }
        @Post('report-stream')
        @HttpCode(200)
        @UseGuards(HostGuard)
        async stream(
          @Req() request: HostRequest,
          @Res({ passthrough: true }) response: object,
        ) {
          const input = parseTextStreamRequest(request.body);
          const authorization = await this.runtime.authorizeStream(
            request,
            Report,
            'report',
            { snapshot: input.snapshot, revision: input.revision },
          );
          return createTextStreamResponse({
            request,
            response,
            authorization,
            produce: ({ signal, state }) => {
              const mode = request.headers['x-mode'];
              if (mode === 'throw-return' || mode === 'getter-return') {
                return {
                  [Symbol.asyncIterator](): AsyncIterator<string> {
                    const iterator: AsyncIterator<string> = {
                      next: async () => ({ done: true, value: undefined }),
                    };
                    const failCleanup = (): never => {
                      cleanupThrows++;
                      throw new Error('PRIVATE-CLEANUP-DETAIL');
                    };
                    if (mode === 'throw-return') iterator.return = failCleanup;
                    else
                      Object.defineProperty(iterator, 'return', {
                        get: failCleanup,
                      });
                    return iterator;
                  },
                };
              }
              return (async function* () {
                produced += 1;
                try {
                  if (mode === 'throw')
                    throw new Error('PRIVATE-PRODUCER-DETAIL');
                  if (mode === 'huge') {
                    yield 'x'.repeat(8192);
                    return;
                  }
                  if (mode === 'flood') {
                    for (let index = 0; index < 4100; index += 1) yield '';
                    return;
                  }
                  yield `${String(state.title)} مرحبا <script>alert(1)</script>`;
                  if (mode === 'hold' || mode === 'revoke')
                    await new Promise<void>((resolve) => {
                      releaseGate = resolve;
                      signal.addEventListener(
                        'abort',
                        () => {
                          aborted += 1;
                          resolve();
                        },
                        { once: true },
                      );
                    });
                  if (mode === 'orphan')
                    await new Promise<void>((resolve) =>
                      orphanReleases.push(resolve),
                    );
                  if (!signal.aborted) yield 'second';
                } finally {
                  if (signal.aborted) aborted += 1;
                }
              })();
            },
          });
        }
      }
      @Module({
        imports: [
          LiveModule.register({
            components: [Report],
            renderer: engine,
            origin,
            maxRequestsPerMinute: 1000,
            resolveIdentity: (request) => {
              const headers: unknown = Reflect.get(request, 'headers');
              const session: unknown =
                headers && typeof headers === 'object'
                  ? Reflect.get(headers, 'x-session')
                  : undefined;
              if (
                typeof session !== 'string' ||
                !['alice', 'bob', 'denied'].includes(session)
              )
                throw new ForbiddenException();
              return {
                binding: `tenant-${session}/session-${session}/principal-${session}`,
                csrfToken: csrf,
              };
            },
            authorize: (identity, _component, action) =>
              action === '$mount' ||
              (action === '$stream:report' &&
                !revoked &&
                !identity.binding.includes('denied')),
          }),
        ],
        controllers: [HostController],
        providers: [HostGuard],
      })
      class HostModule {}
      const compiled = await Test.createTestingModule({
        imports: [HostModule],
      }).compile();
      app =
        platform === 'fastify'
          ? compiled.createNestApplication(new FastifyAdapter(), {
              logger: false,
            })
          : compiled.createNestApplication({ logger: false });
      await app.listen(0, '127.0.0.1');
      base = await app.getUrl();
    });
    afterAll(async () => {
      releaseGate?.();
      orphanReleases.splice(0).forEach((release) => release());
      await app?.close();
      await engine?.dispose();
      if (directory) await rm(directory, { recursive: true, force: true });
    });
    async function mount(session = 'alice'): Promise<Mounted> {
      const response = await fetch(`${base}/mount`, {
        headers: { 'x-session': session, connection: 'close' },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { html: string };
      const snapshot = /data-nv-snapshot="([^"]+)"/.exec(body.html)?.[1];
      if (!snapshot) throw new Error('Missing mounted snapshot');
      return { snapshot, revision: 0 };
    }
    async function post(
      mounted: Mounted,
      overrides: Record<string, string> = {},
      body: unknown = {
        protocol: 'nestvexa-stream/1',
        requestId: 'test-request',
        ...mounted,
      },
      signal?: AbortSignal,
    ) {
      return fetch(`${base}/report-stream`, {
        method: 'POST',
        headers: {
          // Abort/reconnect tests otherwise leave Undici speculative TCP sockets
          // with zero request bytes; Fastify correctly cannot classify them as idle HTTP.
          // Disable pooling in this fixture instead of force-closing server streams.
          connection: 'close',
          'content-type': 'application/json',
          origin,
          'x-session': 'alice',
          'x-nestvexa-csrf': csrf,
          ...overrides,
        },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    }
    it('delivers a first chunk before the producer finishes and a terminal record after release', async () => {
      const mounted = await mount();
      const response = await post(mounted, { 'x-mode': 'hold' });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain(
        'application/x-ndjson',
      );
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Missing response body');
      const first = await reader.read();
      const text = new TextDecoder().decode(first.value);
      expect(text).toContain('مرحبا <script>alert(1)</script>');
      expect(text).not.toContain('"done"');
      releaseGate?.();
      let rest = '';
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        rest += new TextDecoder().decode(next.value);
      }
      expect(rest).toContain('second');
      expect(rest).toContain('"type":"done"');
    });
    it.each([
      { headers: { 'x-session': 'guest' }, code: 403 },
      { headers: { 'x-session': 'bob' }, code: 410 },
      { headers: { 'x-nestvexa-csrf': 'forged' }, code: 403 },
      { headers: { origin: 'https://foreign.invalid' }, code: 403 },
      { headers: { 'x-deny': '1' }, code: 403 },
    ])(
      'rejects unauthorized streaming before producing bytes: %j',
      async ({ headers, code }) => {
        const mounted = await mount();
        const before = produced;
        const response = await post(mounted, headers);
        expect(response.status).toBe(code);
        await response.arrayBuffer();
        expect(produced).toBe(before);
      },
    );
    it('rejects stale revisions and explicit policy denial without invoking the producer', async () => {
      const before = produced;
      const stale = await post({ ...(await mount()), revision: 1 });
      expect(stale.status).toBe(409);
      await stale.arrayBuffer();
      const denied = await post(await mount('denied'), {
        'x-session': 'denied',
      });
      expect(denied.status).toBe(403);
      await denied.arrayBuffer();
      expect(produced).toBe(before);
    });
    it('rechecks policy after an awaited producer chunk and sends only a safe terminal error', async () => {
      const response = await post(await mount(), { 'x-mode': 'revoke' });
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Missing reader');
      await reader.read();
      revoked = true;
      releaseGate?.();
      let text = '';
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        text += new TextDecoder().decode(next.value);
      }
      revoked = false;
      expect(text).toContain('STREAM_EXPIRED');
      expect(text).not.toContain('second');
    });
    it.each([
      { mode: 'throw', code: 'STREAM_FAILED' },
      { mode: 'huge', code: 'STREAM_LIMIT' },
      { mode: 'flood', code: 'STREAM_LIMIT' },
    ])(
      'bounds $mode producers and redacts their errors',
      async ({ mode, code }) => {
        const response = await post(await mount(), { 'x-mode': mode });
        const text = await response.text();
        expect(text).toContain(code);
        expect(text).not.toContain('PRIVATE-PRODUCER-DETAIL');
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1_048_576);
      },
    );
    it('aborts the producer when the browser disconnects', async () => {
      const before = aborted;
      const controller = new AbortController();
      const response = await post(
        await mount(),
        { 'x-mode': 'hold' },
        undefined,
        controller.signal,
      );
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Missing reader');
      await reader.read();
      controller.abort();
      await reader.cancel().catch(() => undefined);
      await eventually(() => aborted > before);
    });
    it('enforces per-component active stream caps and releases capacity on cancellation', async () => {
      const mounted = await mount();
      const controllers = [new AbortController(), new AbortController()];
      const responses = await Promise.all(
        controllers.map((controller) =>
          post(mounted, { 'x-mode': 'hold' }, undefined, controller.signal),
        ),
      );
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      const rejected = await post(mounted);
      expect(rejected.status).toBe(429);
      await rejected.arrayBuffer();
      controllers.forEach((controller) => controller.abort());
      await Promise.all(
        responses.map((response) =>
          response.body?.cancel().catch(() => undefined),
        ),
      );
      await delay(50);
      const recovered = await post(mounted);
      expect(recovered.status).toBe(200);
      await recovered.text();
    });
    it.each(['throw-return', 'getter-return'])(
      'isolates %s cleanup failure and releases its lease without leaking private errors',
      async (mode) => {
        const mounted = await mount();
        const before = cleanupThrows;
        for (let attempt = 0; attempt < 3; attempt++) {
          const response = await post(mounted, { 'x-mode': mode });
          expect(response.status).toBe(200);
          const body = await response.text();
          expect(body).toContain('"type":"done"');
          expect(body).not.toContain('PRIVATE-CLEANUP-DETAIL');
          await eventually(() => cleanupThrows > before + attempt);
        }
      },
    );
    it('shares the application cap across distinct component instances and releases cancelled streams', async () => {
      const mounted = await Promise.all(
        Array.from({ length: 5 }, () => mount()),
      );
      const controllers = Array.from(
        { length: 8 },
        () => new AbortController(),
      );
      const responses = await Promise.all(
        controllers.map((controller, index) => {
          const instance = mounted[Math.floor(index / 2)];
          if (!instance) throw new Error('Missing component instance');
          return post(
            instance,
            { 'x-mode': 'hold' },
            undefined,
            controller.signal,
          );
        }),
      );
      try {
        expect(responses.every((response) => response.status === 200)).toBe(
          true,
        );
        const fifth = mounted[4];
        if (!fifth) throw new Error('Missing fifth component');
        const rejected = await post(fifth);
        expect(rejected.status).toBe(429);
        await rejected.arrayBuffer();
      } finally {
        controllers.forEach((controller) => controller.abort());
        await Promise.all(
          responses.map((response) =>
            response.body?.cancel().catch(() => undefined),
          ),
        );
      }
      await delay(50);
      const fifth = mounted[4];
      if (!fifth) throw new Error('Missing fifth component');
      const recovered = await post(fifth);
      expect(recovered.status).toBe(200);
      await recovered.text();
    });
    it('retains capacity for producer work that ignores cancellation until it actually settles', async () => {
      const mounted = await mount();
      const responses = await Promise.all([
        post(mounted, { 'x-mode': 'orphan' }),
        post(mounted, { 'x-mode': 'orphan' }),
      ]);
      const bodies = await Promise.all(
        responses.map((response) => response.text()),
      );
      expect(bodies.every((body) => body.includes('STREAM_LIMIT'))).toBe(true);
      const rejected = await post(mounted);
      expect(rejected.status).toBe(429);
      await rejected.arrayBuffer();
      const before = aborted;
      orphanReleases.splice(0).forEach((release) => release());
      await eventually(() => aborted >= before + 2);
    });
    it('aborts an active producer before Nest closes the HTTP adapter', async () => {
      const response = await post(await mount(), { 'x-mode': 'hold' });
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Missing active stream');
      await reader.read();
      const before = aborted;
      await app.close();
      await eventually(() => aborted > before);
      await reader.cancel().catch(() => undefined);
    });
  });
