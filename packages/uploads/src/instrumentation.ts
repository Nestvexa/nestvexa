/**
 * Structural tracing hook, the same shape as @nestvexa/live's
 * `instrumentation` option and @nestvexa/observability's
 * `LiveInstrumentation` (this package imports neither). Attributes are the
 * purpose name, mode, file counts and byte sizes only: never file names,
 * contents, tokens or identities.
 */
export type UploadSpanAttributes = Readonly<
  Record<string, string | number | boolean>
>;
export interface UploadInstrumentation {
  start(
    name: string,
    attributes: UploadSpanAttributes,
  ): {
    end(outcome: 'ok' | 'error', attributes?: UploadSpanAttributes): void;
  };
}

export function isInstrumentation(
  value: unknown,
): value is UploadInstrumentation {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'start') === 'function'
  );
}

/** Run work inside a span; a throwing hook never changes the upload outcome. */
export async function traced<T>(
  hook: UploadInstrumentation | undefined,
  name: string,
  attributes: UploadSpanAttributes,
  work: () => Promise<T>,
  finish: (value: T) => UploadSpanAttributes,
): Promise<T> {
  if (!hook) return work();
  let span: ReturnType<UploadInstrumentation['start']> | undefined;
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
