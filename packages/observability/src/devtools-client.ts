/**
 * Browser half of the development panel (`@nestvexa/observability/devtools-client`).
 * It has no Node or Nest imports, so a page bundle can load it in development:
 *
 *   const reporter = devtoolsReporter();
 *   createLiveClient({ onDiagnostic: reporter.onDiagnostic, tracing: true });
 *
 * Each Live client diagnostic (queue, request and morph timings with the
 * component name, request and response sizes and the request's trace id) is
 * buffered and sent in batches to `DevtoolsModule`'s `<path>/client`
 * endpoint, which shows them as browser morph timing and network batches.
 * Only those fields are copied: no state, DOM, tokens, URLs or payloads.
 * Never install it in production; the server endpoint does not exist there.
 */

/** Structural mirror of the Live client `LiveDiagnostic` (this package does not import the client). */
export interface DevtoolsDiagnosticLike {
  readonly phase: 'queue' | 'request' | 'morph';
  readonly outcome: 'succeeded' | 'failed' | 'cancelled';
  readonly milliseconds: number;
  readonly component?: string;
  readonly requestBytes?: number;
  readonly responseBytes?: number;
  readonly traceId?: string;
}
export interface DevtoolsReporterOptions {
  /** Same-origin path of the panel's report endpoint. Default `/_nestvexa/devtools/client`. */
  readonly endpoint?: string;
  /** Delay before a batch is sent, 1–60000 ms. Default 1000. */
  readonly flushMs?: number;
  readonly fetch?: typeof fetch;
}
export interface DevtoolsReporter {
  /** Pass as the Live client `onDiagnostic` option. */
  readonly onDiagnostic: (event: DevtoolsDiagnosticLike) => void;
  /** Send everything buffered now. */
  flush(): Promise<void>;
  /** Stop sending; buffered timings are dropped. */
  dispose(): void;
}

/** Same as `DEVTOOLS_CLIENT_BATCH_LIMIT` on the server. */
const batchLimit = 50;
/** Timings buffered at most while a send is pending; later ones are dropped. */
const bufferLimit = 200;
const endpointPattern = /^\/(?!\/)[A-Za-z0-9_\-/]*$/;

/** Buffer Live client diagnostics and send them to the development panel. */
export function devtoolsReporter(
  options: DevtoolsReporterOptions = {},
): DevtoolsReporter {
  const endpoint = options.endpoint ?? '/_nestvexa/devtools/client';
  if (!endpointPattern.test(endpoint))
    throw new Error('devtoolsReporter endpoint must be a same-origin path');
  const flushMs = options.flushMs ?? 1000;
  if (!Number.isSafeInteger(flushMs) || flushMs < 1 || flushMs > 60_000)
    throw new Error('devtoolsReporter flushMs must be 1-60000');
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  const buffer: DevtoolsDiagnosticLike[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  async function flush(): Promise<void> {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    while (!disposed && buffer.length) {
      const timings = buffer.splice(0, batchLimit);
      try {
        await send(endpoint, {
          method: 'POST',
          credentials: 'same-origin',
          redirect: 'error',
          keepalive: true,
          headers: {
            'content-type': 'application/json',
            'x-nestvexa-devtools': '1',
          },
          body: JSON.stringify({ timings }),
        });
      } catch {
        // Development telemetry is best effort; a lost batch is not retried.
      }
    }
  }
  return Object.freeze({
    onDiagnostic(event: DevtoolsDiagnosticLike): void {
      if (disposed || buffer.length >= bufferLimit) return;
      buffer.push(
        Object.freeze({
          phase: event.phase,
          outcome: event.outcome,
          milliseconds: event.milliseconds,
          ...(event.component === undefined
            ? {}
            : { component: event.component }),
          ...(event.requestBytes === undefined
            ? {}
            : { requestBytes: event.requestBytes }),
          ...(event.responseBytes === undefined
            ? {}
            : { responseBytes: event.responseBytes }),
          ...(event.traceId === undefined ? {} : { traceId: event.traceId }),
        }),
      );
      timer ??= setTimeout(() => void flush(), flushMs);
    },
    flush,
    dispose(): void {
      disposed = true;
      buffer.length = 0;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  });
}
