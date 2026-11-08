import { LiveClientError } from './grammar.js';

const maximumResponseBytes = 2_097_152;
/** An HTTP rejection with no response body or server exception included in its message. */
export class LiveHttpError extends LiveClientError {
  constructor(
    readonly status: number,
    /** The server asked for a full page reload (asset version mismatch). */
    readonly reload = false,
    /** The server's recovery hint is a fresh resync (`STALE_REVISION`). */
    readonly resync = false,
  ) {
    super('HTTP', `Live request failed (${status})`);
    this.name = 'LiveHttpError';
  }
}
export interface RequestClock {
  setTimeout(callback: () => void, milliseconds: number): number;
  clearTimeout(timer: number): void;
}
export function requestTimeout(value: unknown): number {
  if (value === undefined) return 30_000;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 300_000
  )
    throw new LiveClientError(
      'DIRECTIVE',
      'requestTimeoutMs must be an integer from 1 through 300000',
    );
  return value;
}
function aborted(): LiveClientError {
  return new LiveClientError('ABORTED', 'Live request was aborted');
}
function responseFailure(): LiveClientError {
  return new LiveClientError('RESPONSE', 'Invalid Live JSON response');
}
function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  // Cancellation is best-effort cleanup, never an extra user-visible request failure.
  if (body && !body.locked) void body.cancel().catch(() => undefined);
}
async function readJson(
  response: Response,
  signal: AbortSignal,
  setReader: (reader: ReadableStreamDefaultReader<Uint8Array> | null) => void,
): Promise<unknown> {
  // A 426 reply or another advertised protocol major means this page was
  // built for a different server version: reloading is the only safe recovery.
  const protocol = response.headers.get('x-nestvexa-protocol');
  if (
    response.status === 426 ||
    (protocol !== null && protocol !== 'nestvexa-live/1')
  )
    throw new LiveClientError(
      'PROTOCOL',
      'Incompatible Live protocol; reload the page',
    );
  if (!response.ok)
    throw new LiveHttpError(
      response.status,
      response.headers.get('x-nestvexa-reload') === 'asset-version',
      response.status === 409 &&
        response.headers.get('x-nestvexa-recovery') === 'resync',
    );
  if (
    response.headers
      .get('content-type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase() !== 'application/json'
  )
    throw new LiveClientError(
      'RESPONSE',
      'Expected an application/json Live response',
    );
  const length = response.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > maximumResponseBytes)
    throw new LiveClientError('RESPONSE', 'Live response exceeds byte limit');
  if (!response.body) throw responseFailure();
  const reader = response.body.getReader();
  setReader(reader);
  // Bounded geometric growth avoids both per-chunk list overhead and a full
  // 2MiB allocation for ordinary small responses.
  let contents = new Uint8Array(16_384);
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (signal.aborted) throw aborted();
      if (chunk.done) break;
      if (!ArrayBuffer.isView(chunk.value)) throw responseFailure();
      if (bytes + chunk.value.byteLength > maximumResponseBytes)
        throw new LiveClientError(
          'RESPONSE',
          'Live response exceeds byte limit',
        );
      if (bytes + chunk.value.byteLength > contents.length) {
        const expanded = new Uint8Array(
          Math.min(
            maximumResponseBytes,
            Math.max(bytes + chunk.value.byteLength, contents.length * 2),
          ),
        );
        expanded.set(contents.subarray(0, bytes));
        contents = expanded;
      }
      contents.set(chunk.value, bytes);
      bytes += chunk.value.byteLength;
    }
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        contents.subarray(0, bytes),
      ),
    ) as unknown;
  } catch (error) {
    if (signal.aborted) throw aborted();
    if (error instanceof LiveClientError) throw error;
    throw responseFailure();
  } finally {
    setReader(null);
    // Do not await an arbitrary underlying source's cancel callback.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
/** Bound fetch and body consumption together, including transports that ignore abort. */
export async function requestLive(
  transport: typeof fetch,
  url: string,
  init: RequestInit,
  controller: AbortController,
  clock: RequestClock,
  timeout: number,
): Promise<unknown> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let timeoutError: LiveClientError | undefined;
  let onAbort = () => {};
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(timeoutError ?? aborted());
      if (reader) void reader.cancel().catch(() => undefined);
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
  });
  const timer = clock.setTimeout(() => {
    timeoutError = new LiveClientError(
      'TIMEOUT',
      'Live request timed out; reconcile server state before further actions',
    );
    controller.abort();
  }, timeout);
  const flight = async (): Promise<unknown> => {
    if (controller.signal.aborted) throw aborted();
    let response: Response;
    try {
      response = await transport(url, { ...init, signal: controller.signal });
    } catch {
      if (controller.signal.aborted) throw aborted();
      throw new LiveClientError(
        'NETWORK',
        'Live request failed; reconcile server state before further actions',
      );
    }
    try {
      if (controller.signal.aborted) throw aborted();
      return await readJson(response, controller.signal, (active) => {
        reader = active;
      });
    } catch (error) {
      if (error instanceof LiveClientError) throw error;
      throw responseFailure();
    } finally {
      cancelBody(response.body);
    }
  };
  try {
    return await Promise.race([stopped, flight()]);
  } finally {
    clock.clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
