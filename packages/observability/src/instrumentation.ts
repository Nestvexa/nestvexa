/**
 * Instrumentation contract consumed by @nestvexa/live (`instrumentation` host option).
 * Attribute values are small primitives chosen by the runtime: component and action
 * names, revisions and sizes. Public state, identities, tokens and HTML never appear.
 */
export type SpanAttributes = Readonly<
  Record<string, string | number | boolean>
>;
export interface LiveSpan {
  end(outcome: 'ok' | 'error', attributes?: SpanAttributes): void;
}
export interface LiveInstrumentation {
  start(name: string, attributes: SpanAttributes): LiveSpan;
}

/** Structural subset of the OpenTelemetry API `Tracer`; no hard dependency. */
export interface OtelTracerLike {
  startSpan(
    name: string,
    options?: {
      attributes?: Record<string, string | number | boolean>;
      kind?: number;
    },
  ): {
    setAttribute(key: string, value: string | number | boolean): unknown;
    setStatus(status: { code: number; message?: string }): unknown;
    end(): void;
  };
}
/** OpenTelemetry status codes (`SpanStatusCode`): UNSET 0, OK 1, ERROR 2. */
const ok = 1;
const error = 2;

/** Bridge Live spans to an OpenTelemetry tracer from `trace.getTracer('nestvexa')`. */
export function openTelemetryInstrumentation(
  tracer: OtelTracerLike,
): LiveInstrumentation {
  return Object.freeze({
    start(name: string, attributes: SpanAttributes): LiveSpan {
      const span = tracer.startSpan(name, { attributes: { ...attributes } });
      let ended = false;
      return {
        end(outcome, extra = {}) {
          if (ended) return;
          ended = true;
          for (const [key, value] of Object.entries(extra))
            span.setAttribute(key, value);
          // Error details stay out of telemetry; only the outcome is recorded.
          span.setStatus({ code: outcome === 'ok' ? ok : error });
          span.end();
        },
      };
    },
  });
}

export interface SpanRecord {
  readonly name: string;
  readonly outcome: 'ok' | 'error';
  readonly milliseconds: number;
  readonly attributes: SpanAttributes;
  readonly at: number;
}
export interface MetricSummary {
  readonly name: string;
  readonly count: number;
  readonly errors: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}
/** Bounded in-memory recorder for development panels and tests. */
export class MemoryInstrumentation implements LiveInstrumentation {
  readonly #records: SpanRecord[] = [];
  constructor(
    private readonly capacity = 500,
    private readonly now: () => number = () => performance.now(),
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new Error('Invalid capacity');
  }
  start(name: string, attributes: SpanAttributes): LiveSpan {
    const started = this.now();
    let ended = false;
    return {
      end: (outcome, extra = {}) => {
        if (ended) return;
        ended = true;
        this.#records.push(
          Object.freeze({
            name,
            outcome,
            milliseconds: Math.max(0, this.now() - started),
            attributes: Object.freeze({ ...attributes, ...extra }),
            at: Date.now(),
          }),
        );
        if (this.#records.length > this.capacity) this.#records.shift();
      },
    };
  }
  get records(): readonly SpanRecord[] {
    return [...this.#records];
  }
  summary(): MetricSummary[] {
    const groups = new Map<string, SpanRecord[]>();
    for (const record of this.#records) {
      const list = groups.get(record.name) ?? [];
      list.push(record);
      groups.set(record.name, list);
    }
    return [...groups].map(([name, list]) => {
      const sorted = list
        .map((record) => record.milliseconds)
        .sort((a, b) => a - b);
      const at = (fraction: number) =>
        sorted[
          Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))
        ] ?? 0;
      return {
        name,
        count: list.length,
        errors: list.filter((record) => record.outcome === 'error').length,
        p50: at(0.5),
        p95: at(0.95),
        max: sorted.at(-1) ?? 0,
      };
    });
  }
  clear(): void {
    this.#records.length = 0;
  }
}
/** Fan out to several instrumentations (for example OpenTelemetry + devtools). */
export function combineInstrumentation(
  ...targets: LiveInstrumentation[]
): LiveInstrumentation {
  return Object.freeze({
    start(name: string, attributes: SpanAttributes): LiveSpan {
      const spans = targets.map((target) => target.start(name, attributes));
      return {
        end: (outcome, extra) =>
          spans.forEach((span) => span.end(outcome, extra)),
      };
    },
  });
}

const sensitive =
  /pass(word)?|secret|token|cookie|authorization|session|csrf|snapshot|binding|api[-_]?key|credential/i;
/**
 * Copy a value for structured logs, replacing sensitive keys with "[redacted]" and
 * bounding depth, size and string length.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth]';
  if (typeof value === 'string')
    return value.length > 2048 ? value.slice(0, 2048) + '…' : value;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => redact(item, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 100))
    // defineProperty: an own `__proto__` key (for example from JSON.parse of a
    // request body) must stay a logged field, not replace the copy's prototype.
    Object.defineProperty(output, key, {
      value: sensitive.test(key) ? '[redacted]' : redact(item, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return output;
}
export interface StructuredLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}
/** JSON-lines logger with redaction; the sink defaults to stdout. */
export function createLogger(
  sink: (line: string) => void = (line) => process.stdout.write(line + '\n'),
): StructuredLogger {
  const write = (
    level: string,
    message: string,
    fields: Record<string, unknown> = {},
  ) =>
    sink(
      JSON.stringify({
        time: new Date().toISOString(),
        level,
        message,
        ...(redact(fields) as object),
      }),
    );
  return {
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}
