import { HttpException } from '@nestjs/common';
import {
  DEFAULT_ERROR_MESSAGES,
  MAX_ISSUES,
  MAX_MESSAGE_LENGTH,
  REASON_PATTERN,
  defaultStatusFor,
  isActionErrorCode,
} from './shared/protocol.js';
import type { ActionErrorCode, ActionIssue } from './shared/protocol.js';

export interface ActionErrorOptions {
  /** HTTP status; defaults to the code's canonical status (VALIDATION 400 ...). */
  readonly status?: number;
  /** Stable machine-readable refinement, `^[A-Z][A-Z0-9_]{0,63}$`. */
  readonly reason?: string;
  readonly issues?: readonly ActionIssue[];
  /** Server-side cause; never serialized to clients. */
  readonly cause?: unknown;
}

function bounded(message: string): string {
  return message.length > MAX_MESSAGE_LENGTH
    ? message.slice(0, MAX_MESSAGE_LENGTH)
    : message;
}

/** Detached, bounded issue copies; invalid entries are rejected rather than coerced. */
export function sanitizeIssues(
  issues: readonly ActionIssue[] | undefined,
): readonly ActionIssue[] | undefined {
  if (issues === undefined) return undefined;
  if (!Array.isArray(issues))
    throw new TypeError('Action issues must be an array');
  return Object.freeze(
    issues.slice(0, MAX_ISSUES).map((issue: ActionIssue) => {
      if (
        typeof issue !== 'object' ||
        issue === null ||
        !Array.isArray(issue.path) ||
        typeof issue.message !== 'string'
      )
        throw new TypeError('Invalid action issue');
      return Object.freeze({
        path: Object.freeze(
          issue.path
            .slice(0, 32)
            .map((segment: unknown) =>
              typeof segment === 'number' && Number.isSafeInteger(segment)
                ? segment
                : String(segment).slice(0, 128),
            ),
        ),
        message: bounded(issue.message),
      });
    }),
  );
}

/**
 * Public action failure. Its message, reason and issues are intended for
 * clients; `cause` stays on the server. Extends `HttpException` so host
 * global filters and Nest's default handler keep the correct status.
 */
export class ActionError extends HttpException {
  readonly code: ActionErrorCode;
  readonly reason: string | undefined;
  readonly issues: readonly ActionIssue[] | undefined;

  constructor(
    code: ActionErrorCode,
    message?: string,
    options: ActionErrorOptions = {},
  ) {
    if (!isActionErrorCode(code))
      throw new TypeError('Unknown action error code');
    const status = options.status ?? defaultStatusFor(code);
    if (!Number.isSafeInteger(status) || status < 400 || status > 599)
      throw new TypeError('Action error status must be 4xx or 5xx');
    if (options.reason !== undefined && !REASON_PATTERN.test(options.reason))
      throw new TypeError(
        'Action error reason must match ^[A-Z][A-Z0-9_]{0,63}$',
      );
    const text = bounded(message ?? DEFAULT_ERROR_MESSAGES[code]);
    const issues = sanitizeIssues(options.issues);
    super(
      {
        statusCode: status,
        code,
        message: text,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
        ...(issues === undefined ? {} : { issues }),
      },
      status,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'ActionError';
    this.code = code;
    this.reason = options.reason;
    this.issues = issues;
  }

  static validation(
    message?: string,
    issues?: readonly ActionIssue[],
    reason?: string,
  ): ActionError {
    return new ActionError('VALIDATION', message, {
      ...(issues === undefined ? {} : { issues }),
      ...(reason === undefined ? {} : { reason }),
    });
  }
  static forbidden(message?: string, reason?: string): ActionError {
    return new ActionError(
      'FORBIDDEN',
      message,
      reason === undefined ? {} : { reason },
    );
  }
  static unauthenticated(message?: string): ActionError {
    return new ActionError('UNAUTHENTICATED', message);
  }
  static notFound(message?: string): ActionError {
    return new ActionError('NOT_FOUND', message);
  }
  static conflict(message?: string, reason?: string): ActionError {
    return new ActionError(
      'CONFLICT',
      message,
      reason === undefined ? {} : { reason },
    );
  }
  static rateLimited(message?: string): ActionError {
    return new ActionError('RATE_LIMITED', message);
  }
}

/** Internal shorthand for admission failures with a canonical message. */
export function reject(
  code: ActionErrorCode,
  reason: string,
  status?: number,
): never {
  throw new ActionError(code, undefined, {
    reason,
    ...(status === undefined ? {} : { status }),
  });
}
