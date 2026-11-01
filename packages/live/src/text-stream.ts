import { HttpException, StreamableFile } from '@nestjs/common';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { JsonValue } from './protocol.js';

const protocol = 'nestvexa-stream/1';
const recordLimit = 8192;
const byteLimit = 1_048_576;
const chunkLimit = 4096;
export interface TextStreamRequest {
  readonly protocol: 'nestvexa-stream/1';
  readonly requestId: string;
  readonly snapshot: string;
  readonly revision: number;
}
/** Runtime-issued authorization for one explicit host component and stream ID. */
export interface TextStreamAuthorization {
  readonly scope: object;
  readonly componentId: string;
  readonly revision: number;
  readonly state: Readonly<Record<string, JsonValue>>;
  revalidate(): Promise<void>;
}
export interface TextStreamProducerContext {
  readonly signal: AbortSignal;
  readonly state: Readonly<Record<string, JsonValue>>;
}
export interface TextStreamOptions {
  readonly request: object;
  readonly response: object;
  readonly authorization: TextStreamAuthorization;
  readonly produce: (
    context: TextStreamProducerContext,
  ) => AsyncIterable<string>;
}
function fail(status: number, code: string): never {
  throw new HttpException({ statusCode: status, code }, status);
}
/** Strict read-only request envelope. Identities, stream IDs and producer classes are never supplied here. */
export function parseTextStreamRequest(value: unknown): TextStreamRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail(400, 'STREAM_REQUEST');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    return fail(400, 'STREAM_REQUEST');
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 4 ||
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        !['protocol', 'requestId', 'snapshot', 'revision'].includes(key),
    )
  )
    return fail(400, 'STREAM_REQUEST');
  const field = (key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor))
      return fail(400, 'STREAM_REQUEST');
    return descriptor.value;
  };
  const requestId = field('requestId');
  const snapshot = field('snapshot');
  const revision = field('revision');
  if (
    field('protocol') !== protocol ||
    typeof requestId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(requestId) ||
    typeof snapshot !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(snapshot) ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  )
    return fail(400, 'STREAM_REQUEST');
  return Object.freeze({ protocol, requestId, snapshot, revision });
}
interface Capacity {
  active: number;
  closing: boolean;
  readonly cancellations: Set<() => void>;
  readonly components: Map<string, number>;
}
const capacities = new WeakMap<object, Capacity>();
function reserve(authorization: TextStreamAuthorization): () => void {
  let capacity = capacities.get(authorization.scope);
  if (!capacity) {
    capacity = {
      active: 0,
      closing: false,
      cancellations: new Set(),
      components: new Map(),
    };
    capacities.set(authorization.scope, capacity);
  }
  const count = capacity.components.get(authorization.componentId) ?? 0;
  if (capacity.closing) return fail(503, 'STREAM_SHUTDOWN');
  if (capacity.active >= 8 || count >= 2) return fail(429, 'STREAM_CAPACITY');
  capacity.active += 1;
  capacity.components.set(authorization.componentId, count + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    capacity.active -= 1;
    const remaining =
      (capacity.components.get(authorization.componentId) ?? 1) - 1;
    if (remaining)
      capacity.components.set(authorization.componentId, remaining);
    else capacity.components.delete(authorization.componentId);
  };
}
/** Internal application lifecycle bridge: stop network streams before Nest closes its HTTP adapter. */
export function closeTextStreams(scope: object): void {
  let capacity = capacities.get(scope);
  if (!capacity) {
    capacity = {
      active: 0,
      closing: true,
      cancellations: new Set(),
      components: new Map(),
    };
    capacities.set(scope, capacity);
  }
  capacity.closing = true;
  for (const cancel of [...capacity.cancellations]) cancel();
}
function rawRequest(value: object): IncomingMessage {
  const raw: unknown = Reflect.get(value, 'raw');
  if (value instanceof IncomingMessage) return value;
  if (raw instanceof IncomingMessage) return raw;
  return fail(500, 'STREAM_HTTP_ADAPTER');
}
function rawResponse(value: object): ServerResponse {
  const raw: unknown = Reflect.get(value, 'raw');
  if (value instanceof ServerResponse) return value;
  if (raw instanceof ServerResponse) return raw;
  return fail(500, 'STREAM_HTTP_ADAPTER');
}
class StreamFailure extends Error {
  constructor(
    readonly code: 'STREAM_FAILED' | 'STREAM_EXPIRED' | 'STREAM_LIMIT',
  ) {
    super(code);
  }
}
/**
 * Return from an ordinary guarded Nest controller using @Res({ passthrough:true }).
 * Read-only producers must honor AbortSignal. No Live transaction is held while streaming.
 */
export async function createTextStreamResponse(
  options: TextStreamOptions,
): Promise<StreamableFile> {
  const body = parseTextStreamRequest(Reflect.get(options.request, 'body'));
  const request = rawRequest(options.request);
  const response = rawResponse(options.response);
  const authorization = options.authorization;
  if (
    !authorization ||
    typeof authorization.scope !== 'object' ||
    authorization.scope === null ||
    typeof authorization.componentId !== 'string' ||
    authorization.revision !== body.revision ||
    typeof authorization.revalidate !== 'function' ||
    typeof options.produce !== 'function'
  )
    return fail(500, 'STREAM_AUTHORIZATION');
  await authorization.revalidate();
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Accel-Buffering', 'no');
  const release = reserve(authorization);
  const abort = new AbortController();
  let cancelled = false;
  let completed = false;
  let nextPending: Promise<IteratorResult<string>> | undefined;
  let iterator: AsyncIterator<string> | undefined;
  let stop: (error: Error) => void = () => undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    stop = reject;
  });
  // Always attach a rejection consumer even before the response is pulled.
  void stopped.catch(() => undefined);
  function cancel(): void {
    if (completed || cancelled) return;
    cancelled = true;
    abort.abort();
    stop(new StreamFailure('STREAM_FAILED'));
    source.destroy();
  }
  const disconnected = () => cancel();
  const source = Readable.from(generate(), {
    objectMode: false,
    highWaterMark: 16_384,
  });
  source.on('error', () => {
    /* StreamableFile's adapters own response failures; never emit private producer errors. */
  });
  const capacity = capacities.get(authorization.scope);
  capacity?.cancellations.add(cancel);
  request.once('aborted', disconnected);
  response.once('close', disconnected);
  response.once('error', disconnected);
  const totalTimer = setTimeout(() => {
    abort.abort();
    stop(new StreamFailure('STREAM_LIMIT'));
    source.destroy();
  }, 30_000);
  totalTimer.unref();
  let cleaned = false;
  function cleanup(): void {
    if (cleaned) return;
    cleaned = true;
    capacity?.cancellations.delete(cancel);
    if (totalTimer) clearTimeout(totalTimer);
    request.off('aborted', disconnected);
    response.off('close', disconnected);
    response.off('error', disconnected);
    abort.abort();
    // A producer ignoring cancellation keeps its capacity lease until its
    // outstanding next()/return() settles. It cannot create unbounded orphan work.
    const pending = nextPending;
    const close = async (): Promise<void> => {
      if (pending) await pending.catch(() => undefined);
      if (iterator?.return) await iterator.return().catch(() => undefined);
    };
    // A custom iterator may throw synchronously from return(), including its
    // property getter. Cleanup failures must not become unhandled rejections.
    void close()
      .catch(() => undefined)
      .finally(release);
  }
  source.once('close', cleanup);
  async function* generate(): AsyncGenerator<Buffer> {
    let sequence = 0;
    let bytes = 0;
    const line = (message: object): Buffer =>
      Buffer.from(
        `${JSON.stringify({ protocol, requestId: body.requestId, seq: sequence++, ...message })}\n`,
      );
    try {
      const iterable = options.produce({
        signal: abort.signal,
        state: authorization.state,
      });
      iterator = iterable[Symbol.asyncIterator]();
      for (let chunks = 0; ;) {
        // Every produced chunk is separately authorized against current host
        // identity, session/tenant binding, permissions, expiry and revision.
        try {
          await Promise.race([authorization.revalidate(), stopped]);
        } catch (error) {
          throw error instanceof StreamFailure
            ? error
            : new StreamFailure('STREAM_EXPIRED');
        }
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          nextPending = Promise.resolve(iterator.next());
          const idle = new Promise<never>((_resolve, reject) => {
            idleTimer = setTimeout(
              () => reject(new StreamFailure('STREAM_LIMIT')),
              10_000,
            );
            idleTimer.unref();
          });
          const item = await Promise.race([nextPending, idle, stopped]);
          nextPending = undefined;
          try {
            await Promise.race([authorization.revalidate(), stopped]);
          } catch (error) {
            throw error instanceof StreamFailure
              ? error
              : new StreamFailure('STREAM_EXPIRED');
          }
          if (item.done) {
            const done = line({ type: 'done' });
            if (bytes + done.byteLength > byteLimit)
              throw new StreamFailure('STREAM_LIMIT');
            yield done;
            completed = true;
            return;
          }
          if (typeof item.value !== 'string' || ++chunks > chunkLimit)
            throw new StreamFailure('STREAM_LIMIT');
          const chunk = line({ type: 'text', text: item.value });
          // Reserve enough bytes for the final safe terminal record.
          if (
            chunk.byteLength > recordLimit ||
            bytes + chunk.byteLength > byteLimit - 256
          )
            throw new StreamFailure('STREAM_LIMIT');
          bytes += chunk.byteLength;
          yield chunk;
        } finally {
          if (idleTimer) clearTimeout(idleTimer);
        }
      }
    } catch (error) {
      if (!cancelled) {
        const code =
          error instanceof StreamFailure ? error.code : 'STREAM_FAILED';
        yield line({ type: 'error', code });
      }
    } finally {
      cleanup();
    }
  }
  return new StreamableFile(source, {
    type: 'application/x-ndjson; charset=utf-8',
    disposition: 'inline',
  });
}
