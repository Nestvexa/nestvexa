/**
 * Structural tracing hook, the same shape as @nestvexa/live's
 * `instrumentation` option and @nestvexa/observability's
 * `LiveInstrumentation` (this package imports neither). Attributes are
 * transports, channel kinds (the part of a channel name before the first
 * `:`), counts, sizes and closed rejection codes: never full channel names,
 * payloads, tokens or identities.
 */
export type RealtimeSpanAttributes = Readonly<
  Record<string, string | number | boolean>
>;
export interface RealtimeSpan {
  end(outcome: 'ok' | 'error', attributes?: RealtimeSpanAttributes): void;
}
export interface RealtimeInstrumentation {
  start(name: string, attributes: RealtimeSpanAttributes): RealtimeSpan;
}

export function isRealtimeInstrumentation(
  value: unknown,
): value is RealtimeInstrumentation {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'start') === 'function'
  );
}

const noop: RealtimeSpan = Object.freeze({ end: () => undefined });

/** Start a span; a throwing hook yields a no-op span and never breaks delivery. */
export function startSpan(
  hook: RealtimeInstrumentation | undefined,
  name: string,
  attributes: RealtimeSpanAttributes,
): RealtimeSpan {
  if (!hook) return noop;
  let span: RealtimeSpan;
  try {
    span = hook.start(name, attributes);
  } catch {
    return noop;
  }
  let ended = false;
  return {
    end(outcome, extra) {
      if (ended) return;
      ended = true;
      try {
        span.end(outcome, extra);
      } catch {
        // Telemetry is best effort.
      }
    },
  };
}

/** The low-cardinality part of a channel name (`orders:tenant-a` → `orders`). */
export function channelKind(channel: string): string {
  const index = channel.indexOf(':');
  return index === -1 ? channel : channel.slice(0, index);
}
