import { normalizeErrors } from './errors.js';
import type { FormErrors } from './errors.js';
import type { FormDefinition, FormSnapshot } from './form.js';

/**
 * Bridges `@nestvexa/uploads` into form state without a package dependency:
 * upload failures are recognized structurally (`name === 'UploadError'` and a
 * string `code`) and become field errors.
 */
export const defaultUploadMessages: Readonly<Record<string, string>> =
  Object.freeze({
    FILE_TOO_LARGE: 'The file is too large.',
    EMPTY_FILE: 'The file is empty.',
    TOO_MANY_FILES: 'Too many files.',
    TYPE_NOT_ALLOWED: 'This file type is not allowed.',
    MIME_MISMATCH: 'The file type does not match its contents.',
    CONTENT_MISMATCH: 'The file type does not match its contents.',
    DANGEROUS_EXTENSION: 'This file type is not allowed.',
    DANGEROUS_CONTENT: 'This file type is not allowed.',
    MISSING_EXTENSION: 'The file name needs an extension.',
    INVALID_FILENAME: 'The file name is not allowed.',
    QUOTA_EXCEEDED: 'Your upload quota is used up.',
    UPLOAD_INFECTED: 'The file was rejected by the malware scanner.',
    SCAN_FAILED: 'The file could not be scanned. Try again later.',
    UPLOAD_EXPIRED: 'The upload expired. Upload the file again.',
    UPLOAD_NOT_FOUND: 'Upload the file again.',
    INVALID_UPLOAD_TOKEN: 'Upload the file again.',
    UPLOAD_ALREADY_FINALIZED: 'This file was already submitted.',
    PURPOSE_MISMATCH: 'Upload the file again.',
    UPLOAD_INCOMPLETE: 'The upload did not finish. Upload the file again.',
  });
const fallbackMessage = 'The file could not be accepted.';

/** True for `UploadError`-shaped errors from `@nestvexa/uploads`. */
export function isUploadError(
  error: unknown,
): error is Error & { readonly code: string } {
  return (
    error instanceof Error &&
    error.name === 'UploadError' &&
    typeof Reflect.get(error, 'code') === 'string'
  );
}

/**
 * Field errors for an upload failure, or `undefined` when `error` is not an
 * upload error (rethrow those). `messages` maps upload codes to text.
 */
export function uploadFormErrors(
  error: unknown,
  field: string,
  messages: Readonly<Record<string, string>> = {},
): FormErrors | undefined {
  if (!isUploadError(error)) return undefined;
  const message = Object.hasOwn(messages, error.code)
    ? messages[error.code]
    : Object.hasOwn(defaultUploadMessages, error.code)
      ? defaultUploadMessages[error.code]
      : fallbackMessage;
  return normalizeErrors({ [field]: [message ?? fallbackMessage] });
}

export type FinalizeFieldResult<F> =
  | { readonly ok: true; readonly files: readonly F[] }
  | {
      readonly ok: false;
      readonly errors: FormErrors;
      /** Files finalized before the failure; persist or delete them. */
      readonly files: readonly F[];
    };

/**
 * Finalize every upload token of a file field, for example with
 * `(token) => uploads.finalize(request, token, { purpose })`. Malformed
 * references and upload failures become errors on `field`.
 */
export async function finalizeFileField<F>(
  form: FormDefinition<unknown>,
  state: FormSnapshot,
  field: string,
  finalize: (token: string) => Promise<F>,
  options: { readonly messages?: Readonly<Record<string, string>> } = {},
): Promise<FinalizeFieldResult<F>> {
  let tokens: readonly string[];
  try {
    tokens = form.files(state, field);
  } catch {
    return {
      ok: false,
      errors: normalizeErrors({
        [field]: [
          options.messages?.['INVALID_UPLOAD_TOKEN'] ??
            defaultUploadMessages['INVALID_UPLOAD_TOKEN'] ??
            fallbackMessage,
        ],
      }),
      files: [],
    };
  }
  const files: F[] = [];
  for (const token of tokens)
    try {
      files.push(await finalize(token));
    } catch (error) {
      const errors = uploadFormErrors(error, field, options.messages);
      if (!errors) throw error;
      return { ok: false, errors, files: Object.freeze(files) };
    }
  return { ok: true, files: Object.freeze(files) };
}
