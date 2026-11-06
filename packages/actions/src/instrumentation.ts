/**
 * Structural tracing hook, the same shape as @nestvexa/live's
 * `instrumentation` option and @nestvexa/observability's
 * `LiveInstrumentation` (this package imports neither). Attribute values are
 * group and action ids, outcomes and error codes only: never inputs, results,
 * identities or tokens.
 */
export type ActionSpanAttributes = Readonly<
  Record<string, string | number | boolean>
>;
export interface ActionInstrumentation {
  start(
    name: string,
    attributes: ActionSpanAttributes,
  ): {
    end(outcome: 'ok' | 'error', attributes?: ActionSpanAttributes): void;
  };
}

export function isInstrumentation(
  value: unknown,
): value is ActionInstrumentation {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'start') === 'function'
  );
}

/** Closed error code of a failure, when it has one (for example ActionError). */
function errorCode(error: unknown): ActionSpanAttributes {
  if (typeof error !== 'object' || error === null) return {};
  const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    ? { 'nestvexa.error_code': code }
    : {};
}

/** Run work inside a span; a throwing hook never changes the call's outcome. */
export async function traced<T>(
  hook: ActionInstrumentation | undefined,
  name: string,
  attributes: ActionSpanAttributes,
  work: () => Promise<T>,
): Promise<T> {
  if (!hook) return work();
  let span: ReturnType<ActionInstrumentation['start']> | undefined;
  try {
    span = hook.start(name, attributes);
  } catch {
    span = undefined;
  }
  try {
    const value = await work();
    try {
      span?.end('ok');
    } catch {
      // Telemetry is best effort.
    }
    return value;
  } catch (error) {
    try {
      span?.end('error', errorCode(error));
    } catch {
      // Telemetry is best effort.
    }
    throw error;
  }
}
