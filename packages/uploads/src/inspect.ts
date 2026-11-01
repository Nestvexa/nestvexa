import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { UploadError, fail } from './errors.js';
import {
  TextValidator,
  dangerousContent,
  knownBinarySignature,
} from './file-types.js';
import type { FileTypeDefinition } from './file-types.js';

const headBytes = 4096;

function bytes(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array)
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (typeof chunk === 'string') return Buffer.from(chunk);
  return fail(400, 'UPLOAD_INTERRUPTED');
}

export interface Inspection {
  readonly size: number;
  readonly sha256: string;
}

/**
 * Authoritative content check over the complete stored bytes: size limit,
 * SHA-256, executable/markup denial, magic bytes or strict UTF-8 text rules.
 * Run on completion and again on finalization.
 */
export async function inspectContent(
  source: AsyncIterable<unknown>,
  type: FileTypeDefinition,
  options: { readonly maxBytes: number; readonly allowEmpty: boolean },
): Promise<Inspection> {
  const hash = createHash('sha256');
  const head: Buffer[] = [];
  let headLength = 0;
  let size = 0;
  const text = type.text ? new TextValidator() : undefined;
  for await (const chunk of source) {
    const data = bytes(chunk);
    size += data.byteLength;
    if (size > options.maxBytes) fail(413, 'FILE_TOO_LARGE');
    hash.update(data);
    text?.push(data);
    if (headLength < headBytes) {
      const part = data.subarray(0, headBytes - headLength);
      head.push(part);
      headLength += part.byteLength;
    }
  }
  const start = Buffer.concat(head);
  if (size === 0) {
    if (!options.allowEmpty) fail(422, 'EMPTY_FILE');
    if (!type.text) fail(415, 'CONTENT_MISMATCH');
  } else {
    if (dangerousContent(start)) fail(415, 'DANGEROUS_CONTENT');
    if (type.text) {
      if (!text?.finish() || knownBinarySignature(start))
        fail(415, 'CONTENT_MISMATCH');
    } else if (!type.detect?.(start)) fail(415, 'CONTENT_MISMATCH');
  }
  return Object.freeze({ size, sha256: hash.digest('hex') });
}

export interface BodyOptions {
  /** File offset of the first byte. */
  readonly position: number;
  /** Maximum bytes accepted from this body. */
  readonly limit: number;
  readonly idleTimeoutMs: number;
  readonly maxDurationMs: number;
  readonly signal: AbortSignal;
  readonly digest: boolean;
}

/**
 * Stream a request body into a file, enforcing the byte limit while reading
 * (never buffering beyond one chunk), with idle/total deadlines and
 * cancellation. Backpressure: the source is paused until each chunk is written.
 * On a limit failure the source is left paused (not destroyed) so the caller
 * can still answer 413 before closing the connection.
 */
export function writeBody(
  source: Readable,
  handle: FileHandle,
  options: BodyOptions,
): Promise<{ readonly bytes: number; readonly sha256?: string }> {
  const hash = options.digest ? createHash('sha256') : undefined;
  let written = 0;
  let queued = 0;
  let chain: Promise<void> = Promise.resolve();
  let idle: ReturnType<typeof setTimeout> | undefined;
  let total: ReturnType<typeof setTimeout> | undefined;
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      settled = true;
      if (idle) clearTimeout(idle);
      if (total) clearTimeout(total);
      source.off('data', data);
      source.off('end', end);
      source.off('error', error);
      source.off('aborted', interrupted);
      source.off('close', closed);
      options.signal.removeEventListener('abort', abort);
    };
    const failWith = (failure: UploadError, destroy: boolean): void => {
      if (settled) return;
      cleanup();
      source.pause();
      if (destroy) source.destroy();
      reject(failure);
    };
    const arm = (): void => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(
        () => failWith(new UploadError(408, 'UPLOAD_TIMEOUT'), true),
        options.idleTimeoutMs,
      );
      idle.unref();
    };
    const data = (chunk: unknown): void => {
      if (settled) return;
      const buffer = bytes(chunk);
      queued += buffer.byteLength;
      if (queued > options.limit) {
        failWith(new UploadError(413, 'FILE_TOO_LARGE'), false);
        return;
      }
      hash?.update(buffer);
      source.pause();
      const position = options.position + queued - buffer.byteLength;
      chain = chain
        .then(async () => {
          let offset = 0;
          while (offset < buffer.byteLength) {
            const { bytesWritten } = await handle.write(
              buffer,
              offset,
              buffer.byteLength - offset,
              position + offset,
            );
            offset += bytesWritten;
          }
          written += buffer.byteLength;
          if (settled) return;
          arm();
          source.resume();
        })
        .catch(() => failWith(new UploadError(500, 'STORAGE_FAILED'), true));
    };
    const end = (): void => {
      void chain.then(() => {
        if (settled) return;
        cleanup();
        resolve(
          hash
            ? Object.freeze({ bytes: written, sha256: hash.digest('hex') })
            : Object.freeze({ bytes: written }),
        );
      });
    };
    const error = (cause: unknown): void =>
      failWith(
        cause instanceof UploadError
          ? cause
          : new UploadError(400, 'UPLOAD_INTERRUPTED'),
        true,
      );
    const interrupted = (): void =>
      failWith(new UploadError(400, 'UPLOAD_INTERRUPTED'), true);
    const closed = (): void => {
      // 'close' before 'end' means the client went away mid-body.
      if (!source.readableEnded) interrupted();
    };
    const abort = (): void =>
      failWith(new UploadError(503, 'UPLOADS_SHUTDOWN'), true);
    if (options.signal.aborted) {
      abort();
      return;
    }
    options.signal.addEventListener('abort', abort, { once: true });
    total = setTimeout(
      () => failWith(new UploadError(408, 'UPLOAD_TIMEOUT'), true),
      options.maxDurationMs,
    );
    total.unref();
    arm();
    source.on('data', data);
    source.once('end', end);
    source.once('error', error);
    source.once('aborted', interrupted);
    source.once('close', closed);
    source.resume();
  });
}
