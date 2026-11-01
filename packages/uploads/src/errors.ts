import { HttpException } from '@nestjs/common';

/** Stable, non-sensitive failure codes returned as `{ statusCode, code }`. */
export type UploadErrorCode =
  | 'ORIGIN_REJECTED'
  | 'CSRF_REJECTED'
  | 'IDENTITY_REQUIRED'
  | 'UPLOAD_FORBIDDEN'
  | 'RATE_LIMIT'
  | 'UNKNOWN_PURPOSE'
  | 'CONTENT_TYPE'
  | 'CONTENT_ENCODING'
  | 'LENGTH_REQUIRED'
  | 'INVALID_REQUEST'
  | 'INVALID_FILENAME'
  | 'MISSING_EXTENSION'
  | 'DANGEROUS_EXTENSION'
  | 'TYPE_NOT_ALLOWED'
  | 'MIME_MISMATCH'
  | 'CONTENT_MISMATCH'
  | 'DANGEROUS_CONTENT'
  | 'EMPTY_FILE'
  | 'FILE_TOO_LARGE'
  | 'TOO_MANY_FILES'
  | 'QUOTA_EXCEEDED'
  | 'CONCURRENCY_LIMIT'
  | 'SIZE_MISMATCH'
  | 'UPLOAD_INTERRUPTED'
  | 'UPLOAD_TIMEOUT'
  | 'INVALID_UPLOAD_TOKEN'
  | 'UPLOAD_NOT_FOUND'
  | 'UPLOAD_EXPIRED'
  | 'UPLOAD_BUSY'
  | 'UPLOAD_ALREADY_FINALIZED'
  | 'PURPOSE_MISMATCH'
  | 'UPLOAD_TAMPERED'
  | 'UPLOAD_INCOMPLETE'
  | 'CHUNK_OUT_OF_ORDER'
  | 'CHUNK_ALREADY_RECEIVED'
  | 'CHUNK_OFFSET'
  | 'CHUNK_SIZE'
  | 'CHUNK_DIGEST'
  | 'DIGEST_MISMATCH'
  | 'DIRECT_UPLOAD_UNAVAILABLE'
  | 'UPLOAD_INFECTED'
  | 'SCAN_FAILED'
  | 'SCANNER_REQUIRED'
  | 'STORAGE_FAILED'
  | 'UPLOADS_SHUTDOWN'
  | 'HTTP_ADAPTER';

/** An HTTP exception whose body never contains file names, paths, tokens or identities. */
export class UploadError extends HttpException {
  constructor(
    status: number,
    readonly code: UploadErrorCode,
  ) {
    super({ statusCode: status, code }, status);
    this.name = 'UploadError';
  }
}

export function fail(status: number, code: UploadErrorCode): never {
  throw new UploadError(status, code);
}
