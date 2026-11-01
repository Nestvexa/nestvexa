import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { validateForm } from './adapter.js';
import type { SchemaAdapter } from './adapter.js';
import { parseFormBody } from './body.js';
import type { FormBodyOptions } from './body.js';
import {
  FORM_ERROR,
  FormInputError,
  hasErrors,
  normalizeErrors,
} from './errors.js';
import type { FormErrors } from './errors.js';
import type { FormValue } from './harden.js';
import {
  constantTimeEqual,
  headerValue,
  pushFlash,
  sessionOf,
  verifyCsrf,
} from './session.js';
import type { CsrfOptions } from './session.js';

/** Value for a Nest `@Redirect()` handler: `{ url, statusCode: 303 }`. */
export interface FormRedirect {
  readonly url: string;
  readonly statusCode: 303;
}

/** What the success handler decides after the input validated. */
export type SubmitOutcome =
  | { readonly redirect: string; readonly flash?: string }
  /** Domain failures (wrong password, taken email): back to the form with these errors. */
  | {
      readonly errors:
        FormErrors | Readonly<Record<string, string | readonly string[]>>;
    };

export interface SubmitContext {
  readonly request: object;
}

/** Old input and errors for re-rendering a form after a failed POST. */
export interface FormState {
  readonly errors: FormErrors;
  readonly old: Readonly<Record<string, FormValue>>;
}

/**
 * Process-local registry that makes a submission token single-use and lets a
 * duplicate request replay the first request's redirect. Implement it on shared
 * storage (Redis `SET NX` plus a result key) for multi-process deployments.
 */
export interface SubmissionLedger {
  /** Atomically claim a token; false when it was already claimed. */
  claim(token: string, ttlMs: number): boolean | Promise<boolean>;
  /** Record where the claiming request redirected. */
  complete(token: string, redirect: string): void | Promise<void>;
  /**
   * Wait (bounded) for the claiming request's redirect. Resolves `undefined`
   * immediately for a token that was never claimed, and on timeout.
   */
  outcome(token: string, timeoutMs: number): Promise<string | undefined>;
}

/** In-memory {@link SubmissionLedger}; bounded and expiring. */
export class MemorySubmissionLedger implements SubmissionLedger {
  readonly #entries = new Map<
    string,
    {
      expiresAt: number;
      redirect?: string;
      waiters: ((redirect: string | undefined) => void)[];
    }
  >();
  constructor(private readonly maxEntries = 10_000) {}
  claim(token: string, ttlMs: number): boolean {
    const now = Date.now();
    for (const [key, entry] of this.#entries)
      if (entry.expiresAt <= now && !entry.waiters.length)
        this.#entries.delete(key);
    if (this.#entries.has(token)) return false;
    if (this.#entries.size >= this.maxEntries) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }
    this.#entries.set(token, { expiresAt: now + ttlMs, waiters: [] });
    return true;
  }
  complete(token: string, redirect: string): void {
    const entry = this.#entries.get(token);
    if (!entry) return;
    entry.redirect = redirect;
    for (const waiter of entry.waiters.splice(0)) waiter(redirect);
  }
  outcome(token: string, timeoutMs: number): Promise<string | undefined> {
    const entry = this.#entries.get(token);
    if (!entry) return Promise.resolve(undefined);
    if (entry.redirect !== undefined) return Promise.resolve(entry.redirect);
    if (entry.waiters.length >= 16) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        entry.waiters = entry.waiters.filter((item) => item !== waiter);
        resolve(undefined);
      }, timeoutMs);
      const waiter = (redirect: string | undefined) => {
        clearTimeout(timer);
        resolve(redirect);
      };
      entry.waiters.push(waiter);
    });
  }
}

export interface SubmitFormOptions<T> {
  /** Form id for the session error bag, `[a-z][a-z0-9-]{0,63}`. */
  readonly form: string;
  readonly adapter: SchemaAdapter<T>;
  /** Application-relative path of the form page (failure redirect). */
  readonly back: string;
  /** Runs only after CSRF, origin, hardening and schema checks passed. */
  readonly handle: (
    value: T,
    context: SubmitContext,
  ) => SubmitOutcome | Promise<SubmitOutcome>;
  readonly csrf?: CsrfOptions;
  /**
   * Defense in depth: when present, an `Origin` header must be one of these, and
   * `Sec-Fetch-Site: cross-site` is refused. The CSRF token stays mandatory.
   */
  readonly allowedOrigins?: readonly string[];
  /**
   * Top-level fields kept as "old input" for the re-rendered form. Default:
   * every submitted field except names containing
   * pass/secret/token/otp/card/cvv/cvc/ssn/confirm. Prefer an explicit list.
   */
  readonly remember?: readonly string[];
  readonly body?: FormBodyOptions;
  /**
   * Make the hidden `_submission` token (see {@link issueSubmissionToken})
   * mandatory and single-use. Duplicates wait up to 5 s and replay the first
   * request's redirect without running `handle` again.
   */
  readonly singleUse?: SubmissionLedger;
  /** Lifetime of stored errors/old input. Default 10 minutes. */
  readonly stateTtlMs?: number;
}

const formIdPattern = /^[a-z][a-z0-9-]{0,63}$/;
/** The well-formed `_submission` token of a request body, if any. */
function submissionToken(request: object): string | undefined {
  const body: unknown = Reflect.get(request, 'body');
  const descriptor =
    body && typeof body === 'object'
      ? Object.getOwnPropertyDescriptor(body, '_submission')
      : undefined;
  const token: unknown =
    descriptor && 'value' in descriptor ? descriptor.value : undefined;
  return typeof token === 'string' && /^[A-Za-z0-9_-]{32}$/.test(token)
    ? token
    : undefined;
}
const sensitive = /pass|secret|token|otp|card|cvv|cvc|ssn|confirm/i;
const stateKey = (form: string) => `nestvexa:form:${form}`;
const submissionKey = (form: string) => `nestvexa:submissions:${form}`;
const maxOldBytes = 16_384;

/** Validate an application-relative redirect path; absolute and scheme URLs are rejected. */
export function safeRedirectPath(url: string): string {
  if (
    typeof url !== 'string' ||
    url.length === 0 ||
    url.length > 2048 ||
    !url.startsWith('/') ||
    url.startsWith('//') ||
    url.includes('\\') ||
    [...url].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    throw new Error('Form redirects require an application-relative path');
  const parsed = new URL(url, 'http://nestvexa.invalid');
  if (parsed.origin !== 'http://nestvexa.invalid')
    throw new Error('Form redirects must stay on the current origin');
  return parsed.pathname + parsed.search + parsed.hash;
}

function checkForm(form: string): string {
  if (typeof form !== 'string' || !formIdPattern.test(form))
    throw new Error('Form ids must match [a-z][a-z0-9-]{0,63}');
  return form;
}

/**
 * Issue a single-use submission token for `form`, kept in the session (at most
 * 8 outstanding per form). Render it as `<input type="hidden" name="_submission">`.
 */
export function issueSubmissionToken(request: object, form: string): string {
  checkForm(form);
  const session = sessionOf(request);
  if (!session) throw new Error('Submission tokens require a host session');
  const token = randomBytes(24).toString('base64url');
  const prior = session.get(submissionKey(form));
  const list = Array.isArray(prior)
    ? prior.filter((item): item is string => typeof item === 'string')
    : [];
  session.set(submissionKey(form), [...list, token].slice(-8));
  return token;
}

/**
 * Read and remove the errors/old input stored by a failed {@link submitForm}.
 * Read-once: a refresh shows a clean form. Expired state is ignored.
 */
export function consumeFormState(request: object, form: string): FormState {
  checkForm(form);
  const empty: FormState = Object.freeze({
    errors: Object.freeze({}),
    old: Object.freeze({}),
  });
  const session = sessionOf(request);
  if (!session) return empty;
  const stored = session.get(stateKey(form));
  if (stored === undefined) return empty;
  session.delete(stateKey(form));
  if (stored === null || typeof stored !== 'object') return empty;
  const expiresAt: unknown = Reflect.get(stored, 'expiresAt');
  if (typeof expiresAt !== 'number' || expiresAt <= Date.now()) return empty;
  let old: Record<string, FormValue>;
  try {
    const value: unknown = Reflect.get(stored, 'old');
    old = value && typeof value === 'object' ? parseFormBody(value) : {};
  } catch {
    old = {};
  }
  return Object.freeze({
    errors: normalizeErrors(Reflect.get(stored, 'errors')),
    old: Object.freeze(old),
  });
}

function rememberedInput(
  input: Readonly<Record<string, FormValue>>,
  remember: readonly string[] | undefined,
): Record<string, FormValue> {
  const old: Record<string, FormValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (remember ? !remember.includes(key) : sensitive.test(key)) continue;
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      (Array.isArray(value) && value.every((item) => typeof item === 'string'))
    )
      old[key] = value;
  }
  return Buffer.byteLength(JSON.stringify(old)) > maxOldBytes ? {} : old;
}

/**
 * Handle an ordinary (no-JavaScript) form POST in a Nest controller:
 *
 * 1. refuse cross-origin requests (when `allowedOrigins` is set) and verify the
 *    session CSRF token against the hidden `_csrf` field in constant time
 *    (`403` on failure; nothing is stored);
 * 2. optionally claim a single-use `_submission` token;
 * 3. harden and parse the body (`400` on attack shapes or bound violations),
 *    then validate with `adapter`;
 * 4. on failure store errors and remembered old input in the session (read-once,
 *    see {@link consumeFormState}) and redirect back with `303 See Other`;
 * 5. on success call `handle`, push its optional flash message and redirect to
 *    its application-relative target with `303`.
 *
 * Return the result from a handler decorated with `@Redirect()`.
 */
export async function submitForm<T>(
  request: object,
  options: SubmitFormOptions<T>,
): Promise<FormRedirect> {
  const form = checkForm(options.form);
  const back = safeRedirectPath(options.back);
  const ttl = options.stateTtlMs ?? 600_000;
  if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 86_400_000)
    throw new Error('stateTtlMs must be 1 second to 24 hours');
  if (typeof options.handle !== 'function')
    throw new Error('submitForm requires a handle function');
  if (Reflect.get(request, 'method') !== 'POST')
    throw new BadRequestException('Form submissions use POST');
  if (options.allowedOrigins) {
    const origin = headerValue(request, 'origin');
    if (origin !== undefined && !options.allowedOrigins.includes(origin))
      throw new ForbiddenException('Cross-origin form submission refused');
    if (headerValue(request, 'sec-fetch-site') === 'cross-site')
      throw new ForbiddenException('Cross-origin form submission refused');
  }
  // A duplicate of an already-claimed submission replays the first redirect
  // before CSRF verification: the first request may have regenerated the
  // session (sign-in), and a replay performs no state change. Unknown tokens
  // resolve immediately and continue through every check below.
  const submitted = options.singleUse ? submissionToken(request) : undefined;
  if (options.singleUse && submitted !== undefined) {
    const replay = await options.singleUse.outcome(
      `${form}:${submitted}`,
      5000,
    );
    if (replay !== undefined)
      return Object.freeze({ url: replay, statusCode: 303 });
  }
  if (!verifyCsrf(request, options.csrf))
    throw new ForbiddenException('Invalid or missing CSRF token');
  const session = sessionOf(request);
  if (!session) throw new ForbiddenException('Form session required');
  const redirect = (url: string): FormRedirect =>
    Object.freeze({ url, statusCode: 303 as const });
  const fail = (
    errors: FormErrors,
    old: Record<string, FormValue>,
  ): FormRedirect => {
    // Re-read: `handle` may have regenerated the session (for example on login).
    const current = sessionOf(request);
    if (!current) throw new ForbiddenException('Form session required');
    current.set(stateKey(form), {
      errors,
      old,
      expiresAt: Date.now() + ttl,
    });
    return redirect(back);
  };

  let claimed: string | undefined;
  if (options.singleUse) {
    const token = submitted;
    const expired = () =>
      fail(
        normalizeErrors({
          [FORM_ERROR]: ['This form expired. Review it and submit again.'],
        }),
        {},
      );
    if (token === undefined) return expired();
    // Claim first (namespaced by form): a concurrent duplicate may already have
    // removed the token from a shared session object.
    const ledgerKey = `${form}:${token}`;
    if (!(await options.singleUse.claim(ledgerKey, ttl)))
      // Duplicate: replay the first outcome without touching the session.
      return redirect(
        (await options.singleUse.outcome(ledgerKey, 5000)) ?? back,
      );
    claimed = ledgerKey;
    const current = sessionOf(request);
    const issued = current?.get(submissionKey(form));
    const known =
      Array.isArray(issued) &&
      issued.some(
        (item) => typeof item === 'string' && constantTimeEqual(item, token),
      );
    if (!known || !current) {
      await options.singleUse.complete(ledgerKey, back);
      return expired();
    }
    // Also forget it in the session, so ledger expiry never revives it.
    current.set(
      submissionKey(form),
      issued.filter(
        (item) => typeof item !== 'string' || !constantTimeEqual(item, token),
      ),
    );
  }
  const finish = async (result: FormRedirect): Promise<FormRedirect> => {
    if (claimed && options.singleUse)
      await options.singleUse.complete(claimed, result.url);
    return result;
  };

  let input: Record<string, FormValue>;
  try {
    input = parseFormBody(Reflect.get(request, 'body'), options.body);
  } catch (error) {
    if (claimed && options.singleUse)
      await options.singleUse.complete(claimed, back);
    if (error instanceof FormInputError)
      throw new BadRequestException('Malformed form submission');
    throw error;
  }
  const old = rememberedInput(input, options.remember);
  try {
    const result = await validateForm(options.adapter, input, {
      ...(options.body?.limits === undefined
        ? {}
        : { limits: options.body.limits }),
    });
    if (!result.ok) return await finish(fail(result.errors, old));
    const outcome = await options.handle(result.value, { request });
    if ('errors' in outcome) {
      const errors = normalizeErrors(outcome.errors);
      return await finish(
        fail(
          hasErrors(errors)
            ? errors
            : normalizeErrors({ [FORM_ERROR]: ['The form is invalid.'] }),
          old,
        ),
      );
    }
    const target = safeRedirectPath(outcome.redirect);
    if (outcome.flash !== undefined) pushFlash(request, outcome.flash);
    return await finish(redirect(target));
  } catch (error) {
    // A failed handler must not leave duplicates waiting for the full timeout.
    if (claimed && options.singleUse)
      await options.singleUse.complete(claimed, back);
    if (error instanceof FormInputError)
      throw new BadRequestException('Malformed form submission');
    throw error;
  }
}
