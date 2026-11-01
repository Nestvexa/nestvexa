import {
  FORM_ERROR,
  errorsFromIssues,
  formatPath,
  hasErrors,
  normalizeErrors,
} from './errors.js';
import type { FormErrors, PathSegment } from './errors.js';
import { hardenInput } from './harden.js';
import type { FormValue, InputLimits } from './harden.js';

/** Outcome of a schema adapter. `value` is the adapter's typed output. */
export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: FormErrors };

/**
 * The single contract every validation library is wrapped in. Adapters receive
 * untrusted input; built-in adapters harden it first. Errors use stable dotted
 * paths (see {@link FormErrors}).
 */
export interface SchemaAdapter<T> {
  validate(input: unknown): Promise<ValidationResult<T>>;
}

/** Typed output of an adapter. */
export type AdapterOutput<A> = A extends SchemaAdapter<infer T> ? T : never;

/** A normalized validation problem passed to message localization. */
export interface ValidationIssue {
  /** Dotted path, `''` for the whole form. */
  readonly path: string;
  /** Library code: a Zod issue code, a class-validator constraint name or a custom code. */
  readonly code: string;
  /** The library's (or author's) default message. */
  readonly message: string;
}

/**
 * Localize messages. A record is searched for `"<path>:<code>"`, then
 * `"<code>"`; a function may return `undefined` to keep the default message.
 * The placeholder `{path}` is replaced with the issue path.
 */
export type MessageMap =
  | Readonly<Record<string, string>>
  | ((issue: ValidationIssue) => string | undefined);

/** Resolve the final message for an issue. */
export function localizeIssue(
  issue: ValidationIssue,
  messages?: MessageMap,
): string {
  let message: string | undefined;
  if (typeof messages === 'function') message = messages(issue);
  else if (messages) {
    const scoped = `${issue.path}:${issue.code}`;
    message = Object.hasOwn(messages, scoped)
      ? messages[scoped]
      : Object.hasOwn(messages, issue.code)
        ? messages[issue.code]
        : undefined;
  }
  const chosen =
    typeof message === 'string' && message ? message : issue.message;
  return chosen.replaceAll('{path}', issue.path || FORM_ERROR);
}

/** Options shared by the built-in adapters. */
export interface AdapterOptions {
  readonly messages?: MessageMap;
  readonly limits?: InputLimits;
}

/** Turn localized issues into a frozen failure result. */
export function failure(
  issues: readonly ValidationIssue[],
  messages?: MessageMap,
): { readonly ok: false; readonly errors: FormErrors } {
  const errors = errorsFromIssues(
    issues.map((issue) => ({
      path: issue.path,
      message: localizeIssue(issue, messages),
    })),
  );
  return Object.freeze({
    ok: false as const,
    errors: hasErrors(errors)
      ? errors
      : normalizeErrors({ [FORM_ERROR]: ['The form is invalid.'] }),
  });
}

/** Records issues inside a {@link customAdapter} validator. */
export interface IssueCollector {
  /**
   * Add a problem. `path` is a dotted string or segments; `code` is used for
   * localization lookups.
   */
  issue(
    path: string | readonly PathSegment[],
    code: string,
    message: string,
  ): void;
  /** Number of issues recorded so far. */
  readonly count: number;
}

/**
 * Wrap a hand-written (optionally async) validator. Input is hardened first.
 * Return the typed value; it is used only when no issue was recorded.
 *
 * ```ts
 * const login = customAdapter<{ email: string; password: string }>((input, ctx) => {
 *   const email = typeof input.email === 'string' ? input.email.trim() : '';
 *   if (!email) ctx.issue('email', 'required', 'Enter your email address.');
 *   ...
 *   return { email, password };
 * });
 * ```
 */
export function customAdapter<T>(
  validate: (
    input: { readonly [key: string]: FormValue | undefined },
    issues: IssueCollector,
  ) => T | Promise<T>,
  options: AdapterOptions = {},
): SchemaAdapter<T> {
  if (typeof validate !== 'function')
    throw new Error('customAdapter requires a validator function');
  return Object.freeze({
    async validate(input: unknown): Promise<ValidationResult<T>> {
      const hardened = hardenInput(input, options.limits);
      if (
        hardened === null ||
        typeof hardened !== 'object' ||
        Array.isArray(hardened)
      )
        return failure(
          [{ path: '', code: 'type', message: 'Expected form fields.' }],
          options.messages,
        );
      const issues: ValidationIssue[] = [];
      const collector: IssueCollector = {
        issue(path, code, message) {
          if (typeof code !== 'string' || typeof message !== 'string')
            throw new Error('Issues need a code and a message');
          if (issues.length >= 200) return;
          issues.push({
            path:
              typeof path === 'string'
                ? formatPath(path ? path.split('.').map(indexOrKey) : [])
                : formatPath(path),
            code,
            message,
          });
        },
        get count() {
          return issues.length;
        },
      };
      const value = await validate(Object.freeze({ ...hardened }), collector);
      if (issues.length) return failure(issues, options.messages);
      return Object.freeze({ ok: true as const, value });
    },
  });
}
function indexOrKey(part: string): PathSegment {
  return /^(?:0|[1-9][0-9]{0,8})$/.test(part) ? Number(part) : part;
}

/**
 * Validate with input hardening and bounded error normalization, regardless of
 * whether `adapter` is built-in or third-party.
 */
export async function validateForm<T>(
  adapter: SchemaAdapter<T>,
  input: unknown,
  options: { readonly limits?: InputLimits } = {},
): Promise<ValidationResult<T>> {
  if (!adapter || typeof adapter.validate !== 'function')
    throw new Error('A schema adapter with validate(input) is required');
  const hardened = hardenInput(input, options.limits);
  // Third-party adapters are checked at runtime, not only by their types.
  const result: ValidationResult<T> | null | undefined =
    await adapter.validate(hardened);
  if (result === null || typeof result !== 'object')
    throw new Error('Schema adapter returned an invalid result');
  if (result.ok === true)
    return Object.freeze({ ok: true as const, value: result.value });
  if (result.ok === false) {
    const errors = normalizeErrors(result.errors);
    return Object.freeze({
      ok: false as const,
      errors: hasErrors(errors)
        ? errors
        : normalizeErrors({ [FORM_ERROR]: ['The form is invalid.'] }),
    });
  }
  throw new Error('Schema adapter returned an invalid result');
}
