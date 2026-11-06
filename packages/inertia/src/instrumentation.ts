/**
 * Structural tracing hook, the same shape as @nestvexa/live's
 * `instrumentation` option and @nestvexa/observability's
 * `LiveInstrumentation` (this package imports neither). Attributes are the
 * page component, app key, response kind and sizes only: never props, HTML or
 * request data.
 */
export type InertiaSpanAttributes = Readonly<
  Record<string, string | number | boolean>
>;
export interface InertiaInstrumentation {
  start(
    name: string,
    attributes: InertiaSpanAttributes,
  ): {
    end(outcome: 'ok' | 'error', attributes?: InertiaSpanAttributes): void;
  };
}

export function isInstrumentation(
  value: unknown,
): value is InertiaInstrumentation {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'start') === 'function'
  );
}

/** Run work inside a span; a throwing hook never changes the response. */
export async function traced<T>(
  hook: InertiaInstrumentation | undefined,
  name: string,
  attributes: InertiaSpanAttributes,
  work: () => Promise<T>,
  finish: (value: T) => InertiaSpanAttributes,
): Promise<T> {
  if (!hook) return work();
  let span: ReturnType<InertiaInstrumentation['start']> | undefined;
  try {
    span = hook.start(name, attributes);
  } catch {
    span = undefined;
  }
  try {
    const value = await work();
    try {
      span?.end('ok', finish(value));
    } catch {
      // Telemetry is best effort.
    }
    return value;
  } catch (error) {
    try {
      span?.end('error');
    } catch {
      // Telemetry is best effort.
    }
    throw error;
  }
}

const ssrErrorTypes = new Set([
  'browser-api',
  'component-resolution',
  'render',
  'connection',
  'timeout',
  'invalid-response',
]);
/** Start a span that the caller ends; a throwing hook yields no span. */
export function startSpan(
  hook: InertiaInstrumentation | undefined,
  name: string,
  attributes: InertiaSpanAttributes,
): { end(outcome: 'ok' | 'error', attributes?: InertiaSpanAttributes): void } {
  let span: ReturnType<InertiaInstrumentation['start']> | undefined;
  try {
    span = hook?.start(name, attributes);
  } catch {
    span = undefined;
  }
  return {
    end(outcome, extra) {
      try {
        span?.end(outcome, extra);
      } catch {
        // Telemetry is best effort.
      }
    },
  };
}
/**
 * Closed classification of an SSR failure (`InertiaSsrError`/`ViteSsrError`
 * `type`); anything else is `unknown`. Messages stay out of telemetry.
 */
export function ssrErrorType(error: unknown): string {
  const type: unknown =
    typeof error === 'object' && error !== null
      ? Reflect.get(error, 'type')
      : undefined;
  return typeof type === 'string' && ssrErrorTypes.has(type) ? type : 'unknown';
}
