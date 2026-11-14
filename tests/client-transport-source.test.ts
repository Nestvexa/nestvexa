import { describe, expect, it } from 'vitest';
import { LiveClientError } from '../packages/client/src/grammar.js';
import {
  LiveHttpError,
  requestLive,
  requestTimeout,
} from '../packages/client/src/transport.js';
import type { RequestClock } from '../packages/client/src/transport.js';

// The Live client's fetch boundary in Node: protocol negotiation, HTTP
// failures, content type and byte limits, invalid bodies, timeouts and
// aborts. Browser suites (client-transport-lifecycle, client-runtime-resilience)
// drive the same module through the bundled runtime; this file measures it
// at source level for the coverage gate (docs/testing/coverage.md).

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });

/** A clock whose timers fire only when the test calls `fire()`. */
function manualClock() {
  const timers = new Map<number, () => void>();
  let next = 1;
  const cleared: number[] = [];
  const clock: RequestClock = {
    setTimeout(callback) {
      const id = next++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(timer) {
      cleared.push(timer);
      timers.delete(timer);
    },
  };
  return {
    clock,
    cleared,
    fire() {
      for (const callback of [...timers.values()]) callback();
    },
  };
}

async function failure(promise: Promise<unknown>): Promise<LiveClientError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LiveClientError) return error;
    throw error;
  }
  throw new Error('expected the request to fail');
}

const send = (
  response: Response | (() => Promise<Response>),
  controller = new AbortController(),
  clock = manualClock().clock,
) =>
  requestLive(
    (() =>
      typeof response === 'function'
        ? response()
        : Promise.resolve(response)) as typeof fetch,
    '/live',
    { method: 'POST' },
    controller,
    clock,
    1000,
  );

/** A body stream that yields the given chunks, then closes. */
const stream = (chunks: unknown[]) =>
  new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk as Uint8Array);
    },
  });

describe('requestTimeout', () => {
  it('defaults to 30 seconds and accepts integers from 1 to 300000', () => {
    expect(requestTimeout(undefined)).toBe(30_000);
    expect(requestTimeout(1)).toBe(1);
    expect(requestTimeout(300_000)).toBe(300_000);
  });
  it.each([0, -1, 300_001, 1.5, Number.NaN, '100', null])(
    'rejects %j',
    (value) => {
      expect(() => requestTimeout(value)).toThrow(
        expect.objectContaining({ code: 'DIRECTIVE' }),
      );
    },
  );
});

describe('requestLive responses', () => {
  it('parses a JSON body, passes the abort signal and clears its timer', async () => {
    const timers = manualClock();
    let signal: AbortSignal | null | undefined;
    const result = await requestLive(
      ((_: string, init: RequestInit) => {
        signal = init.signal;
        return Promise.resolve(json({ ok: true }));
      }) as typeof fetch,
      '/live',
      { method: 'POST' },
      new AbortController(),
      timers.clock,
      1000,
    );
    expect(result).toEqual({ ok: true });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(timers.cleared).toEqual([1]);
  });

  it('grows its buffer across many chunks and decodes multi-byte text', async () => {
    const text = JSON.stringify({ value: 'é'.repeat(20_000) });
    const bytes = new TextEncoder().encode(text);
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.length; offset += 7_001)
      chunks.push(bytes.subarray(offset, offset + 7_001));
    const response = new Response(stream(chunks), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
    expect(await send(response)).toEqual({ value: 'é'.repeat(20_000) });
  });

  it.each([
    [426, {}],
    [200, { 'x-nestvexa-protocol': 'nestvexa-live/2' }],
  ])(
    'reports status %i with headers %j as an incompatible protocol',
    async (status, headers) => {
      const error = await failure(send(json({}, { status, headers })));
      expect(error.code).toBe('PROTOCOL');
    },
  );

  it('accepts the current protocol header', async () => {
    expect(
      await send(
        json([1], { headers: { 'x-nestvexa-protocol': 'nestvexa-live/1' } }),
      ),
    ).toEqual([1]);
  });

  it('turns HTTP failures into LiveHttpError with reload and recovery hints', async () => {
    const conflict = await failure(
      send(
        json(
          {},
          {
            status: 409,
            headers: {
              'x-nestvexa-recovery': 'resync',
              'x-nestvexa-reload': 'asset-version',
            },
          },
        ),
      ),
    );
    expect(conflict).toBeInstanceOf(LiveHttpError);
    expect(conflict).toMatchObject({
      code: 'HTTP',
      status: 409,
      reload: true,
      recovery: 'resync',
      name: 'LiveHttpError',
    });
    // Recovery hints only belong to conflicts; the message has no body.
    const server = await failure(
      send(
        new Response('secret stack trace', {
          status: 500,
          headers: { 'x-nestvexa-recovery': 'commit' },
        }),
      ),
    );
    expect(server).toMatchObject({
      status: 500,
      reload: false,
      recovery: null,
    });
    expect(server.message).toBe('Live request failed (500)');
  });

  it.each([
    ['text/html', 'Expected an application/json Live response'],
    ['application/json-seq', 'Expected an application/json Live response'],
  ])('rejects content type %s', async (type, message) => {
    const error = await failure(
      send(new Response('{}', { headers: { 'content-type': type } })),
    );
    expect(error).toMatchObject({ code: 'RESPONSE', message });
  });

  it('rejects a response without a content type', async () => {
    const response = new Response(new Uint8Array([123, 125]));
    response.headers.delete('content-type');
    expect((await failure(send(response))).code).toBe('RESPONSE');
  });

  it('rejects a declared length above 2 MiB before reading the body', async () => {
    const error = await failure(
      send(json({}, { headers: { 'content-length': String(2_097_153) } })),
    );
    expect(error.message).toBe('Live response exceeds byte limit');
  });

  it('rejects a streamed body that grows past 2 MiB', async () => {
    const chunk = new Uint8Array(1_048_576).fill(32);
    const response = new Response(stream([chunk, chunk, chunk]), {
      headers: { 'content-type': 'application/json' },
    });
    const error = await failure(send(response));
    expect(error.message).toBe('Live response exceeds byte limit');
  });

  it.each([
    ['invalid JSON', [new TextEncoder().encode('{"a":')]],
    ['invalid UTF-8', [new Uint8Array([0x7b, 0xff, 0x7d])]],
    ['a non-byte chunk', ['text']],
  ])('reports %s as an invalid response', async (_, chunks) => {
    const response = new Response(stream(chunks), {
      headers: { 'content-type': 'application/json' },
    });
    const error = await failure(send(response));
    expect(error).toMatchObject({
      code: 'RESPONSE',
      message: 'Invalid Live JSON response',
    });
  });

  it('reports a response without a body as invalid', async () => {
    const error = await failure(
      send(
        new Response(null, { headers: { 'content-type': 'application/json' } }),
      ),
    );
    expect(error.code).toBe('RESPONSE');
  });
});

describe('requestLive network, timeout and abort', () => {
  it('maps a rejected fetch to a NETWORK error without its message', async () => {
    const error = await failure(
      send(() => Promise.reject(new Error('ECONNREFUSED 10.0.0.1'))),
    );
    expect(error).toMatchObject({ code: 'NETWORK' });
    expect(error.message).not.toContain('10.0.0.1');
  });

  it('refuses to start when the controller is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const error = await failure(
      send(() => {
        called = true;
        return Promise.resolve(json({}));
      }, controller),
    );
    expect(error.code).toBe('ABORTED');
    expect(called).toBe(false);
  });

  it('times out a transport that ignores the abort signal', async () => {
    const timers = manualClock();
    const pending = send(
      () => new Promise<Response>(() => undefined),
      new AbortController(),
      timers.clock,
    );
    timers.fire();
    const error = await failure(pending);
    expect(error.code).toBe('TIMEOUT');
  });

  it('times out a stalled body and cancels its reader', async () => {
    const timers = manualClock();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"a"'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const pending = send(
      new Response(body, { headers: { 'content-type': 'application/json' } }),
      new AbortController(),
      timers.clock,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    timers.fire();
    expect((await failure(pending)).code).toBe('TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cancelled).toBe(true);
  });

  it('reports ABORTED when aborted while fetch rejects with an AbortError', async () => {
    const controller = new AbortController();
    const pending = send(
      () =>
        new Promise<Response>((_, reject) => {
          controller.signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
      controller,
    );
    controller.abort();
    expect((await failure(pending)).code).toBe('ABORTED');
  });

  it('reports ABORTED when the abort lands after the response arrived', async () => {
    const controller = new AbortController();
    const pending = send(async () => {
      controller.abort();
      return json({});
    }, controller);
    expect((await failure(pending)).code).toBe('ABORTED');
  });
});
