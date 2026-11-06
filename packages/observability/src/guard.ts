import { HttpException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { LiveInstrumentation, LiveSpan } from './instrumentation.js';

interface Subscribable {
  subscribe(observer: {
    next(value: unknown): void;
    error(error: unknown): void;
    complete(): void;
  }): { unsubscribe(): void };
}
function isSubscribable(value: unknown): value is Subscribable {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'subscribe') === 'function'
  );
}
/** First emitted value of an Observable guard result, like Nest's own guard consumer. */
function firstValue(source: Subscribable): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let done = false;
    const subscription = source.subscribe({
      next(value) {
        if (done) return;
        done = true;
        resolve(value);
        queueMicrotask(() => subscription.unsubscribe());
      },
      error(error) {
        if (!done) reject(error);
        done = true;
      },
      complete() {
        if (!done) resolve(false);
        done = true;
      },
    });
  });
}
const guardName = /^[A-Za-z_$][\w$]{0,63}$/;

/**
 * Wrap a guard instance so each check is a `nestvexa.guard` span with the
 * guard class name and the decision (`nestvexa.guard.allowed`); a thrown
 * exception records its HTTP status. Requests, users and messages are never
 * recorded. The decision and exceptions are passed through unchanged.
 *
 * ```ts
 * app.useGlobalGuards(traceGuard(new SessionGuard(), instrumentation));
 * ```
 */
export function traceGuard(
  guard: CanActivate,
  instrumentation: LiveInstrumentation,
  name?: string,
): CanActivate {
  if (typeof guard?.canActivate !== 'function')
    throw new Error('traceGuard requires a guard with canActivate()');
  if (typeof instrumentation?.start !== 'function')
    throw new Error('traceGuard requires an instrumentation with start()');
  const constructorName: unknown =
    Object.getPrototypeOf(guard)?.constructor?.name;
  const label =
    name ??
    (typeof constructorName === 'string' && guardName.test(constructorName)
      ? constructorName
      : 'anonymous');
  if (!guardName.test(label)) throw new Error('Invalid guard span name');
  return {
    async canActivate(context: ExecutionContext): Promise<boolean> {
      let span: LiveSpan | undefined;
      try {
        span = instrumentation.start('nestvexa.guard', {
          'nestvexa.guard': label,
          'nestvexa.guard.context': context.getType(),
        });
      } catch {
        span = undefined;
      }
      const end = (
        outcome: 'ok' | 'error',
        attributes: Readonly<Record<string, string | number | boolean>>,
      ) => {
        try {
          span?.end(outcome, attributes);
        } catch {
          // Telemetry is best effort.
        }
      };
      try {
        let result: unknown = await guard.canActivate(context);
        if (isSubscribable(result)) result = await firstValue(result);
        // Nest allows any truthy decision; keep the same semantics.
        const allowed = Boolean(result);
        end('ok', { 'nestvexa.guard.allowed': allowed });
        return allowed;
      } catch (error) {
        end(
          'error',
          error instanceof HttpException
            ? { 'nestvexa.guard.allowed': false, status: error.getStatus() }
            : { 'nestvexa.guard.allowed': false },
        );
        throw error;
      }
    },
  };
}
