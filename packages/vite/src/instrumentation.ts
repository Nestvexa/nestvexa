/**
 * Structural tracing hook, the same shape as @nestvexa/live's
 * `instrumentation` option and @nestvexa/observability's
 * `LiveInstrumentation` (this package imports neither). Attributes are
 * content types, sizes, status codes and cache flags: never paths, query
 * strings or request headers.
 */
export type ViteSpanAttributes = Readonly<
  Record<string, string | number | boolean>
>;
export interface ViteInstrumentation {
  start(
    name: string,
    attributes: ViteSpanAttributes,
  ): { end(outcome: 'ok' | 'error', attributes?: ViteSpanAttributes): void };
}
export interface ViteSpan {
  end(outcome: 'ok' | 'error', attributes?: ViteSpanAttributes): void;
}
const noop: ViteSpan = Object.freeze({ end: () => undefined });

export function isViteInstrumentation(
  value: unknown,
): value is ViteInstrumentation {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'start') === 'function'
  );
}
/** Start a span that ends at most once; a throwing hook never breaks serving. */
export function startSpan(
  hook: ViteInstrumentation | undefined,
  name: string,
  attributes: ViteSpanAttributes,
): ViteSpan {
  if (!hook) return noop;
  let span: ViteSpan;
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
