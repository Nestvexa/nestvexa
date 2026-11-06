export type MailErrorCode =
  | 'INVALID_ADDRESS'
  | 'INVALID_HEADER'
  | 'INVALID_MESSAGE'
  | 'TOO_MANY_RECIPIENTS'
  | 'TEMPLATE_FAILED'
  | 'TRANSPORT_FAILED'
  | 'UNSAFE_ENVIRONMENT';

/**
 * Closed error codes. Messages name the offending field, never its value, so
 * an error can be logged without leaking recipients, tokens or body text.
 */
export class MailError extends Error {
  constructor(
    readonly code: MailErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MailError';
  }
}
