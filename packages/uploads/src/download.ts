import { IncomingMessage, ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';
import { fail } from './errors.js';
import { contentDisposition } from './filename.js';
import type { ByteRange } from './storage.js';

export type RangeResult =
  | { readonly kind: 'full' }
  | { readonly kind: 'partial'; readonly start: number; readonly end: number }
  | { readonly kind: 'unsatisfiable' };

/**
 * Parse a single `bytes=` range (RFC 9110 §14). Malformed and multi-range
 * headers are ignored (full response); ranges beyond the end are unsatisfiable.
 */
export function parseRange(header: unknown, size: number): RangeResult {
  if (typeof header !== 'string' || header.length > 200)
    return { kind: 'full' };
  const match = /^\s*bytes\s*=\s*(\d{0,16})\s*-\s*(\d{0,16})\s*$/i.exec(header);
  if (!match) return { kind: 'full' };
  const [, first = '', last = ''] = match;
  if (!first && !last) return { kind: 'full' };
  if (!first) {
    const suffix = Number(last);
    if (!Number.isSafeInteger(suffix)) return { kind: 'full' };
    if (suffix === 0 || size === 0) return { kind: 'unsatisfiable' };
    return {
      kind: 'partial',
      start: Math.max(0, size - suffix),
      end: size - 1,
    };
  }
  const start = Number(first);
  const end = last ? Number(last) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end))
    return { kind: 'full' };
  if (last && end < start) return { kind: 'full' };
  if (start >= size) return { kind: 'unsatisfiable' };
  return { kind: 'partial', start, end: Math.min(end, size - 1) };
}

export interface DownloadOptions {
  readonly filename: string;
  /** Registry content type. Text types get `charset=utf-8`. */
  readonly contentType: string;
  readonly size: number;
  /** Open the full object or an inclusive byte range. */
  readonly open: (range?: ByteRange) => Promise<Readable>;
  /** `inline` is honored only for raster image types; everything else downloads. */
  readonly disposition?: 'attachment' | 'inline';
  /** Strong validator; enables If-None-Match/If-Range handling. */
  readonly etag?: string;
  /** Default `private, no-store`. */
  readonly cacheControl?: string;
  /** Destroy the transfer when the client stops reading for this long. Default 30000ms. */
  readonly idleTimeoutMs?: number;
}

function rawRequest(value: object): IncomingMessage {
  if (value instanceof IncomingMessage) return value;
  const raw: unknown = Reflect.get(value, 'raw');
  if (raw instanceof IncomingMessage) return raw;
  return fail(500, 'HTTP_ADAPTER');
}
/** Take over the native response. Fastify replies are hijacked first. */
function takeResponse(value: object): ServerResponse {
  if (value instanceof ServerResponse) return value;
  const raw: unknown = Reflect.get(value, 'raw');
  if (!(raw instanceof ServerResponse)) return fail(500, 'HTTP_ADAPTER');
  const hijack: unknown = Reflect.get(value, 'hijack');
  if (typeof hijack === 'function') Reflect.apply(hijack, value, []);
  return raw;
}
const inlineTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);
const mimePattern =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;
const etagPattern = /^"[A-Za-z0-9_-]{1,128}"$/;

/**
 * Stream a stored file from a host route that has already authorized the
 * download (use `@Res()`; the response is taken over). Sends nosniff, a
 * sandboxing CSP, RFC 5987 Content-Disposition, single-range 206/416 and honors
 * backpressure. It never fetches URLs: bytes come only from `open`.
 */
export async function sendDownload(
  request: object,
  response: object,
  options: DownloadOptions,
): Promise<void> {
  const req = rawRequest(request);
  if (
    typeof options.contentType !== 'string' ||
    !mimePattern.test(options.contentType) ||
    !Number.isSafeInteger(options.size) ||
    options.size < 0 ||
    typeof options.open !== 'function' ||
    (options.etag !== undefined && !etagPattern.test(options.etag)) ||
    (options.cacheControl !== undefined &&
      (typeof options.cacheControl !== 'string' ||
        /[\r\n]/.test(options.cacheControl)))
  )
    throw new Error('Invalid download options');
  const idle = options.idleTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(idle) || idle < 100 || idle > 600_000)
    throw new Error('Invalid download idle timeout');
  const res = takeResponse(response);
  const method = req.method ?? 'GET';
  const headers: Record<string, string> = {
    'Content-Type': options.contentType.startsWith('text/')
      ? `${options.contentType}; charset=utf-8`
      : options.contentType,
    'Content-Disposition': contentDisposition(
      options.filename,
      options.disposition === 'inline' && inlineTypes.has(options.contentType)
        ? 'inline'
        : 'attachment',
    ),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': options.cacheControl ?? 'private, no-store',
    'Accept-Ranges': 'bytes',
  };
  if (options.etag) headers['ETag'] = options.etag;
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Length': '0' });
    res.end();
    return;
  }
  if (options.etag && req.headers['if-none-match'] === options.etag) {
    res.writeHead(304, {
      ETag: options.etag,
      'Cache-Control': headers['Cache-Control'] ?? '',
    });
    res.end();
    return;
  }
  const ifRange = req.headers['if-range'];
  const range =
    ifRange !== undefined && ifRange !== options.etag
      ? ({ kind: 'full' } as const)
      : parseRange(req.headers['range'], options.size);
  if (range.kind === 'unsatisfiable') {
    res.writeHead(416, {
      ...headers,
      'Content-Range': `bytes */${options.size}`,
      'Content-Length': '0',
    });
    res.end();
    return;
  }
  const partial = range.kind === 'partial';
  const length = partial ? range.end - range.start + 1 : options.size;
  if (partial)
    headers['Content-Range'] =
      `bytes ${range.start}-${range.end}/${options.size}`;
  headers['Content-Length'] = String(length);
  if (method === 'HEAD' || length === 0) {
    res.writeHead(partial ? 206 : 200, headers);
    res.end();
    return;
  }
  const source = await options.open(
    partial ? { start: range.start, end: range.end } : undefined,
  );
  res.writeHead(partial ? 206 : 200, headers);
  await new Promise<void>((resolve) => {
    let sent = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      source.off('data', data);
      res.off('drain', resume);
      res.off('close', closed);
      source.off('end', ended);
      source.off('error', failed);
      resolve();
    };
    const arm = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        source.destroy();
        res.destroy();
        finish();
      }, idle);
      timer.unref();
    };
    const resume = (): void => {
      arm();
      source.resume();
    };
    const data = (chunk: Buffer | string): void => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      sent += bytes.byteLength;
      if (sent > length) {
        // The source returned more than promised; never send beyond Content-Length.
        source.destroy();
        res.destroy();
        finish();
        return;
      }
      arm();
      if (!res.write(bytes)) source.pause();
    };
    const ended = (): void => {
      if (sent !== length) res.destroy();
      else res.end();
      finish();
    };
    const failed = (): void => {
      source.destroy();
      res.destroy();
      finish();
    };
    const closed = (): void => {
      source.destroy();
      finish();
    };
    arm();
    source.on('data', data);
    source.once('end', ended);
    source.once('error', failed);
    res.on('drain', resume);
    res.once('close', closed);
  });
}
