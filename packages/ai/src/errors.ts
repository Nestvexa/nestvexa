export type AiErrorCode =
  'CONVERSATION' | 'PROMPT' | 'BUSY' | 'APPROVAL' | 'TOOL' | 'CONFIG';

/** Safe, code-only failure. Messages never include prompt text or provider errors. */
export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'AiError';
  }
}
