/**
 * Circuit breakers and timeouts for the optional server-side services
 * (QA-018): Redis (Live store, job queue, presence through `RespConnection`),
 * S3 storage, the clamd scanner, AI providers and mail transports. Each
 * dependency is a real local socket or HTTP server that fails on demand; the
 * suites prove that a downed dependency fails fast (no network call while the
 * circuit is open), that a single probe after the cooldown closes the circuit
 * again, and that ordinary refusals never open it.
 */
import { createServer as createHttpServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import type { Server as TcpServer, Socket } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import * as redisBreaker from '../packages/realtime-redis/dist/circuit-breaker.js';
import * as uploadsBreaker from '../packages/uploads/dist/circuit-breaker.js';
import * as aiBreaker from '../packages/ai/dist/circuit-breaker.js';
import * as mailBreaker from '../packages/mail/dist/circuit-breaker.js';
import {
  CircuitOpenError,
  RedisLiveStore,
  RespConnection,
} from '../packages/realtime-redis/dist/index.js';
import { ClamdScanner, S3Storage } from '../packages/uploads/dist/index.js';
import { AiAssistant, MemoryAuditSink } from '../packages/ai/dist/index.js';
import type { ChatEvent, ChatProvider } from '../packages/ai/dist/index.js';
import { Mailer, MemoryMailTransport } from '../packages/mail/dist/index.js';
import type {
  MailDeliveryEvent,
  MailTransport,
  NormalizedMailMessage,
} from '../packages/mail/dist/index.js';
import { respDouble } from './support/resp-double.js';
import './support/no-unhandled-rejections.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A clock tests advance by hand. */
function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe('package-local breaker copies', () => {
  it('are byte-identical in every optional package', async () => {
    const read = (name: string) =>
      readFile(
        new URL(`../packages/${name}/src/circuit-breaker.ts`, import.meta.url),
        'utf8',
      );
    const reference = await read('realtime-redis');
    for (const name of ['uploads', 'ai', 'mail'])
      expect(await read(name), name).toBe(reference);
  });
});

describe.each([
  ['realtime-redis', redisBreaker],
  ['uploads', uploadsBreaker],
  ['ai', aiBreaker],
  ['mail', mailBreaker],
] as const)('CircuitBreaker (%s copy)', (_name, module) => {
  const failing = () => Promise.reject(new Error('down'));
  const opened = async (
    breaker: InstanceType<typeof module.CircuitBreaker>,
    times: number,
  ) => {
    for (let index = 0; index < times; index++)
      await expect(breaker.run(failing)).rejects.toThrow('down');
  };

  it('opens after the threshold, fails fast, then admits exactly one probe', async () => {
    const time = clock();
    const breaker = new module.CircuitBreaker('dependency', {
      failureThreshold: 3,
      cooldownMs: 1_000,
      now: time.now,
    });
    await opened(breaker, 2);
    expect(breaker.state).toBe('closed');
    expect(breaker.failures).toBe(2);
    await opened(breaker, 1);
    expect(breaker.state).toBe('open');
    let calls = 0;
    const counted = async () => {
      calls++;
      return 'ok';
    };
    const fast = breaker.run(counted);
    await expect(fast).rejects.toBeInstanceOf(module.CircuitOpenError);
    await expect(fast).rejects.toMatchObject({
      service: 'dependency',
      retryAfterMs: 1_000,
    });
    time.advance(400);
    await expect(breaker.run(counted)).rejects.toMatchObject({
      retryAfterMs: 600,
    });
    expect(calls).toBe(0);
    time.advance(600);
    expect(breaker.state).toBe('half-open');
    // One probe runs; concurrent callers still fail fast while it is out.
    let release: (value: string) => void = () => undefined;
    const probe = breaker.run(
      () =>
        new Promise<string>((resolve) => {
          calls++;
          release = resolve;
        }),
    );
    await expect(breaker.run(counted)).rejects.toMatchObject({
      retryAfterMs: 0,
    });
    release('ok');
    await expect(probe).resolves.toBe('ok');
    expect(breaker.state).toBe('closed');
    expect(breaker.failures).toBe(0);
    await expect(breaker.run(counted)).resolves.toBe('ok');
    expect(calls).toBe(2);
  });

  it('reopens for a full cooldown when the probe fails', async () => {
    const time = clock();
    const breaker = new module.CircuitBreaker('dependency', {
      failureThreshold: 1,
      cooldownMs: 500,
      now: time.now,
    });
    await opened(breaker, 1);
    time.advance(500);
    await expect(breaker.run(failing)).rejects.toThrow('down');
    expect(breaker.state).toBe('open');
    await expect(breaker.run(failing)).rejects.toMatchObject({
      retryAfterMs: 500,
    });
  });

  it('never counts refusals the caller classifies as answers', async () => {
    const breaker = new module.CircuitBreaker('dependency', {
      failureThreshold: 2,
    });
    const refusal = new Error('not found');
    await opened(breaker, 1);
    // A refusal proves the dependency answered: it resets the count.
    await expect(
      breaker.run(
        () => Promise.reject(refusal),
        (error) => error !== refusal,
      ),
    ).rejects.toBe(refusal);
    expect(breaker.failures).toBe(0);
    await opened(breaker, 1);
    expect(breaker.state).toBe('closed');
  });

  it('settles manual calls once, and a released probe frees its slot', () => {
    const time = clock();
    const breaker = new module.CircuitBreaker('dependency', {
      failureThreshold: 1,
      cooldownMs: 100,
      now: time.now,
    });
    const first = breaker.attempt();
    first.fail();
    first.succeed();
    expect(breaker.state).toBe('open');
    time.advance(100);
    const probe = breaker.attempt();
    expect(() => breaker.attempt()).toThrow(module.CircuitOpenError);
    probe.release();
    expect(breaker.state).toBe('half-open');
    breaker.attempt().succeed();
    expect(breaker.state).toBe('closed');
  });

  it('rejects out-of-range options', () => {
    for (const options of [
      { failureThreshold: 0 },
      { failureThreshold: 1.5 },
      { failureThreshold: 1001 },
      { cooldownMs: 99 },
      { cooldownMs: 600_001 },
    ])
      expect(() => new module.CircuitBreaker('x', options)).toThrow(
        /Invalid circuit breaker/,
      );
  });
});

/** A TCP server whose behaviour tests switch at runtime. */
async function tcpServer(
  handle: (socket: Socket) => void,
): Promise<{ server: TcpServer; port: number; accepted: () => number }> {
  let accepted = 0;
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    accepted++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    handle(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return { server, port: address.port, accepted: () => accepted };
}

describe('Redis (RespConnection)', () => {
  it('fails fast after consecutive failures and recovers through one probe', async () => {
    // A Redis that accepts connections and resets them: every command fails.
    let healthy = false;
    const redis = await respDouble();
    cleanups.push(() => redis.close());
    const proxy = await tcpServer((socket) => {
      if (!healthy) {
        socket.destroy();
        return;
      }
      const upstream = connect(redis.port, '127.0.0.1');
      upstream.on('error', () => socket.destroy());
      socket.pipe(upstream).pipe(socket);
    });
    const connection = new RespConnection({
      port: proxy.port,
      commandTimeoutMs: 500,
      circuitBreaker: { failureThreshold: 3, cooldownMs: 300 },
    });
    cleanups.push(() => connection.close());
    for (let attempt = 0; attempt < 3; attempt++)
      await expect(connection.command('PING')).rejects.toThrow(
        /Redis connection/,
      );
    expect(connection.circuit).toBe('open');
    const before = proxy.accepted();
    const started = performance.now();
    await expect(connection.command('PING')).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
    expect(performance.now() - started).toBeLessThan(50);
    // No connection was attempted while the circuit was open.
    expect(proxy.accepted()).toBe(before);
    healthy = true;
    await new Promise((resolve) => setTimeout(resolve, 320));
    await expect(connection.command('PING')).resolves.toBe('PONG');
    expect(connection.circuit).toBe('closed');
  });

  it('bounds a server that never answers with the command timeout', async () => {
    // Accepts and reads, never replies (a hung or partitioned Redis).
    const silent = await tcpServer((socket) => socket.resume());
    const connection = new RespConnection({
      port: silent.port,
      commandTimeoutMs: 100,
      circuitBreaker: { failureThreshold: 2, cooldownMs: 10_000 },
    });
    cleanups.push(() => connection.close());
    const started = performance.now();
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(connection.command('GET', 'k')).rejects.toThrow(/closed/);
    expect(performance.now() - started).toBeLessThan(2_000);
    await expect(connection.command('GET', 'k')).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
  });

  it('error replies never open the circuit', async () => {
    const redis = await respDouble();
    cleanups.push(() => redis.close());
    const connection = new RespConnection({
      port: redis.port,
      circuitBreaker: { failureThreshold: 1 },
    });
    cleanups.push(() => connection.close());
    for (let attempt = 0; attempt < 3; attempt++)
      expect(await connection.command('NOSUCHCOMMAND')).toBeInstanceOf(Error);
    expect(connection.circuit).toBe('closed');
    await expect(connection.command('PING')).resolves.toBe('PONG');
  });

  it('a Live store over a downed Redis fails fast instead of queueing requests', async () => {
    const down = await tcpServer((socket) => socket.destroy());
    const store = new RedisLiveStore({
      port: down.port,
      circuitBreaker: { failureThreshold: 2, cooldownMs: 10_000 },
    });
    cleanups.push(() => store.close());
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(store.peek('A'.repeat(43), 'binding')).rejects.toThrow();
    const before = down.accepted();
    const refusal: unknown = await store
      .peek('A'.repeat(43), 'binding')
      .catch((error: unknown) => error);
    // The Live runtime still sees the retryable 503, now without a network
    // round trip; the open circuit is the cause.
    expect(refusal).toMatchObject({ status: 503, code: 'STORE_UNAVAILABLE' });
    expect(Reflect.get(Object(refusal), 'cause')).toBeInstanceOf(
      CircuitOpenError,
    );
    expect(down.accepted()).toBe(before);
  });

  it('can be disabled', async () => {
    const down = await tcpServer((socket) => socket.destroy());
    const connection = new RespConnection({
      port: down.port,
      circuitBreaker: false,
    });
    cleanups.push(() => connection.close());
    for (let attempt = 0; attempt < 8; attempt++)
      await expect(connection.command('PING')).rejects.toThrow(
        /Redis connection/,
      );
    expect(connection.circuit).toBe('closed');
    expect(down.accepted()).toBe(8);
  });
});

/** An HTTP server answering with a status tests switch at runtime. */
async function httpServer(): Promise<{
  readonly url: string;
  requests: () => number;
  respond: (status: number | 'hang') => void;
}> {
  let status: number | 'hang' = 200;
  let requests = 0;
  const server: HttpServer = createHttpServer((request, response) => {
    requests++;
    request.resume();
    if (status === 'hang') return;
    const code = status;
    request.on('end', () => {
      response.writeHead(code, { 'content-length': '0' });
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests: () => requests,
    respond: (next) => {
      status = next;
    },
  };
}

describe('S3 storage', () => {
  const credentials = {
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  };
  const key = `ab/${'k'.repeat(43)}`;

  it('opens on 5xx and timeouts, fails fast with 502, and recovers', async () => {
    const s3 = await httpServer();
    const storage = new S3Storage({
      endpoint: s3.url,
      region: 'us-test-1',
      bucket: 'breaker-bucket',
      credentials,
      requestTimeoutMs: 100,
      circuitBreaker: { failureThreshold: 3, cooldownMs: 300 },
    });
    s3.respond(503);
    await expect(storage.stat(key)).rejects.toMatchObject({
      status: 502,
      code: 'STORAGE_FAILED',
    });
    await expect(storage.delete(key)).rejects.toMatchObject({ status: 502 });
    s3.respond('hang');
    await expect(storage.open(key)).rejects.toMatchObject({ status: 502 });
    expect(storage.circuit).toBe('open');
    const before = s3.requests();
    const started = performance.now();
    await expect(storage.stat(key)).rejects.toMatchObject({
      status: 502,
      code: 'STORAGE_FAILED',
    });
    expect(performance.now() - started).toBeLessThan(50);
    expect(s3.requests()).toBe(before);
    s3.respond(404);
    await new Promise((resolve) => setTimeout(resolve, 320));
    // The probe reaches S3; a 404 is an answer and closes the circuit.
    await expect(storage.stat(key)).resolves.toBeUndefined();
    expect(storage.circuit).toBe('closed');
    expect(s3.requests()).toBe(before + 1);
  });

  it('4xx replies never open the circuit and an unsent upload stream is closed', async () => {
    const s3 = await httpServer();
    const storage = new S3Storage({
      endpoint: s3.url,
      region: 'us-test-1',
      bucket: 'breaker-bucket',
      credentials,
      circuitBreaker: { failureThreshold: 1, cooldownMs: 10_000 },
    });
    s3.respond(404);
    for (let attempt = 0; attempt < 3; attempt++)
      await expect(storage.open(key)).rejects.toMatchObject({
        status: 404,
        code: 'UPLOAD_NOT_FOUND',
      });
    expect(storage.circuit).toBe('closed');
    s3.respond(500);
    const directory = await mkdtemp(join(tmpdir(), 'nestvexa-breaker-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'upload.bin');
    const bytes = Buffer.from('payload');
    await writeFile(path, bytes);
    const source = {
      path,
      size: bytes.length,
      contentType: 'application/octet-stream',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    await expect(storage.put(key, source)).rejects.toMatchObject({
      status: 502,
    });
    expect(storage.circuit).toBe('open');
    const before = s3.requests();
    await expect(storage.put(key, source)).rejects.toMatchObject({
      status: 502,
    });
    expect(s3.requests()).toBe(before);
    // The file handle of the refused upload is released (Windows would
    // refuse to delete an open file).
    await rm(path);
  });
});

describe('clamd scanner', () => {
  const file = (opened: { count: number }) => ({
    name: 'a.txt',
    contentType: 'text/plain',
    size: 5,
    sha256: '0'.repeat(64),
    open: () => {
      opened.count++;
      return Promise.resolve(Readable.from([Buffer.from('hello')]));
    },
  });

  it('returns "unavailable" without connecting while clamd is down, then recovers', async () => {
    let healthy = false;
    const clamd = await tcpServer((socket) => {
      if (!healthy) {
        socket.destroy();
        return;
      }
      let received = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        // INSTREAM ends with a zero-length chunk.
        if (received.subarray(-4).equals(Buffer.alloc(4)))
          socket.end('stream: OK\u0000');
      });
    });
    const scanner = new ClamdScanner({
      port: clamd.port,
      timeoutMs: 500,
      circuitBreaker: { failureThreshold: 2, cooldownMs: 300 },
    });
    const opened = { count: 0 };
    const signal = new AbortController().signal;
    for (let attempt = 0; attempt < 2; attempt++)
      expect((await scanner.scan(file(opened), signal)).status).toBe('error');
    expect(scanner.circuit).toBe('open');
    const before = clamd.accepted();
    expect(await scanner.scan(file(opened), signal)).toEqual({
      status: 'error',
      reason: 'unavailable',
    });
    // Fail-fast neither connects nor opens the stored file.
    expect(clamd.accepted()).toBe(before);
    expect(opened.count).toBe(2);
    healthy = true;
    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(await scanner.scan(file(opened), signal)).toEqual({
      status: 'clean',
    });
    expect(scanner.circuit).toBe('closed');
  });

  it('cancelled scans never count against clamd', async () => {
    const clamd = await tcpServer((socket) => socket.resume());
    const scanner = new ClamdScanner({
      port: clamd.port,
      circuitBreaker: { failureThreshold: 1 },
    });
    const controller = new AbortController();
    controller.abort();
    expect(
      await scanner.scan(file({ count: 0 }), controller.signal),
    ).toMatchObject({ reason: 'aborted' });
    expect(scanner.circuit).toBe('closed');
  });
});

describe('AI provider', () => {
  async function turn(assistant: AiAssistant): Promise<void> {
    const conversation = assistant.open('alice');
    assistant.ask('alice', conversation, 'hello');
    try {
      for await (const chunk of assistant.stream('alice', conversation, {
        signal: new AbortController().signal,
      }))
        void chunk;
    } catch {
      // A failed turn ends the stream with AiError('BUSY').
    }
  }

  it('fails turns fast while the provider is down and recovers', async () => {
    const time = clock();
    let healthy = false;
    let calls = 0;
    const provider: ChatProvider = {
      id: 'flaky',
      kind: 'model',
      label: 'Flaky test provider',
      async *stream(): AsyncIterable<ChatEvent> {
        calls++;
        await Promise.resolve();
        if (!healthy) throw new Error('provider down');
        yield { type: 'text', text: 'hi' };
        yield { type: 'done' };
      },
    };
    const audit = new MemoryAuditSink();
    const assistant = new AiAssistant({
      provider,
      audit,
      circuitBreaker: { failureThreshold: 2, cooldownMs: 1_000, now: time.now },
    });
    await turn(assistant);
    await turn(assistant);
    expect(assistant.circuit).toBe('open');
    await turn(assistant);
    expect(calls).toBe(2);
    const failed = audit.events.filter((event) => event.type === 'turn.failed');
    expect(failed.map((event) => event.detail)).toEqual([
      'PROVIDER',
      'PROVIDER',
      'UNAVAILABLE',
    ]);
    healthy = true;
    time.advance(1_000);
    await turn(assistant);
    expect(calls).toBe(3);
    expect(assistant.circuit).toBe('closed');
    expect(audit.events.at(-1)?.type).toBe('turn.completed');
  });

  it('turn timeouts count; cancellations do not', async () => {
    let calls = 0;
    const provider: ChatProvider = {
      id: 'slow',
      kind: 'model',
      label: 'Slow test provider',
      async *stream(_messages, options): AsyncIterable<ChatEvent> {
        calls++;
        await new Promise((resolve) =>
          options.signal.addEventListener('abort', resolve, { once: true }),
        );
        yield { type: 'done' };
      },
    };
    const assistant = new AiAssistant({
      provider,
      timeoutMs: 20,
      circuitBreaker: { failureThreshold: 2 },
    });
    // A cancelled turn says nothing about the provider.
    const conversation = assistant.open('bob');
    assistant.ask('bob', conversation, 'hello');
    const controller = new AbortController();
    const pending = (async () => {
      try {
        for await (const chunk of assistant.stream('bob', conversation, {
          signal: controller.signal,
        }))
          void chunk;
      } catch {
        // Cancelled.
      }
    })();
    controller.abort();
    await pending;
    expect(assistant.circuit).toBe('closed');
    await turn(assistant);
    await turn(assistant);
    expect(assistant.circuit).toBe('open');
    expect(calls).toBe(3);
  });
});

describe('mail transport', () => {
  const message = {
    from: 'app@example.com',
    to: 'user@example.com',
    subject: 'Hello',
    text: 'Body',
  };

  it('bounds a hung transport, fails fast while it is down and recovers', async () => {
    let mode: 'hang' | 'fail' | 'ok' = 'hang';
    let calls = 0;
    const memory = new MemoryMailTransport();
    const transport: MailTransport = {
      name: 'flaky-smtp',
      send(normalized: NormalizedMailMessage) {
        calls++;
        if (mode === 'hang') return new Promise(() => undefined);
        if (mode === 'fail') return Promise.reject(new Error('smtp down'));
        return memory.send(normalized);
      },
    };
    const events: MailDeliveryEvent[] = [];
    const mailer = new Mailer({
      transport,
      sendTimeoutMs: 100,
      circuitBreaker: { failureThreshold: 2, cooldownMs: 300 },
      onDelivery: (event) => events.push(event),
    });
    const started = performance.now();
    await expect(mailer.send(message)).rejects.toMatchObject({
      code: 'TRANSPORT_FAILED',
    });
    expect(performance.now() - started).toBeLessThan(1_000);
    mode = 'fail';
    await expect(mailer.send(message)).rejects.toMatchObject({
      code: 'TRANSPORT_FAILED',
    });
    expect(mailer.circuit).toBe('open');
    await expect(mailer.send(message)).rejects.toMatchObject({
      code: 'TRANSPORT_FAILED',
    });
    expect(calls).toBe(2);
    expect(events.map((event) => event.error)).toEqual([
      'TRANSPORT_TIMEOUT',
      'TRANSPORT_FAILED',
      'CIRCUIT_OPEN',
    ]);
    // No recipient or body text reaches the event stream.
    expect(JSON.stringify(events)).not.toContain('user@example.com');
    mode = 'ok';
    await new Promise((resolve) => setTimeout(resolve, 320));
    await expect(mailer.send(message)).resolves.toMatchObject({
      transport: 'flaky-smtp',
    });
    expect(mailer.circuit).toBe('closed');
    expect(memory.messages).toHaveLength(1);
  });

  it('rejects an invalid send timeout', () => {
    for (const sendTimeoutMs of [99, 600_001, 1.5])
      expect(
        () =>
          new Mailer({ transport: new MemoryMailTransport(), sendTimeoutMs }),
      ).toThrow(/sendTimeoutMs/);
  });
});
