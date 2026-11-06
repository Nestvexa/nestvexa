/**
 * TEST DOUBLE — an in-process, in-memory S3-compatible HTTP server for the
 * uploads test suite. It implements just enough of the S3 REST API (PUT/GET
 * with single Range/HEAD/DELETE object, header and presigned-query SigV4
 * authentication, expiry, signed content-length/type and payload hash checks)
 * to exercise S3Storage over real HTTP. It is NOT a substitute for running the
 * same flow against AWS S3 or MinIO, which remains an owner/CI step.
 *
 * Signature verification here is an independent re-implementation of the
 * SigV4 canonicalization rules, so it does not reuse the code under test.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

export interface FakeS3 {
  readonly url: string;
  readonly objects: Map<string, { body: Buffer; contentType: string }>;
  readonly requests: { method: string; path: string; status: number }[];
  /** Override the server clock (milliseconds) for expiry tests. */
  now: () => number;
  close(): Promise<void>;
}

const sha = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const mac = (key: string | Buffer, value: string) =>
  createHmac('sha256', key).update(value).digest();
function encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
function parseStamp(stamp: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
  if (!match) return Number.NaN;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  return Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 0, h ?? 0, mi ?? 0, s ?? 0);
}

export async function startFakeS3(options: {
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Extra headers on every response (for browser CORS tests). */
  readonly cors?: string;
  /** Listening port; 0 (the default) picks a free port. */
  readonly port?: number;
  /** Listening address; defaults to 127.0.0.1. */
  readonly host?: string;
  /**
   * Test-only, unauthenticated `GET /__fake/objects` listing of stored keys,
   * sizes and SHA-256 digests, so browser tests running against a separate
   * process can assert what landed in the bucket. Off by default.
   */
  readonly inspection?: boolean;
}): Promise<FakeS3> {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const requests: { method: string; path: string; status: number }[] = [];
  const state = { now: () => Date.now() };

  function deny(response: ServerResponse, status: number, code: string): void {
    response.writeHead(status, { 'content-type': 'application/xml' });
    response.end(`<?xml version="1.0"?><Error><Code>${code}</Code></Error>`);
  }

  function verify(
    request: IncomingMessage,
    url: URL,
    body: Buffer,
  ): string | undefined {
    const rawQuery = (request.url ?? '').includes('?')
      ? (request.url ?? '').slice((request.url ?? '').indexOf('?') + 1)
      : '';
    const pairs = rawQuery
      ? rawQuery
          .split('&')
          .filter(Boolean)
          .map((part) => {
            const index = part.indexOf('=');
            const key = decodeURIComponent(
              index < 0 ? part : part.slice(0, index),
            );
            const value = decodeURIComponent(
              index < 0 ? '' : part.slice(index + 1),
            );
            return [key, value] as const;
          })
      : [];
    const query = new Map(pairs);
    const presigned = query.has('X-Amz-Signature');
    let credential: string;
    let signedHeaders: string;
    let signature: string;
    let stamp: string;
    let payload: string;
    if (presigned) {
      if (query.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256')
        return 'AuthorizationQueryParametersError';
      credential = query.get('X-Amz-Credential') ?? '';
      signedHeaders = query.get('X-Amz-SignedHeaders') ?? '';
      signature = query.get('X-Amz-Signature') ?? '';
      stamp = query.get('X-Amz-Date') ?? '';
      payload = 'UNSIGNED-PAYLOAD';
      const expires = Number(query.get('X-Amz-Expires'));
      if (!Number.isInteger(expires) || expires < 1 || expires > 604800)
        return 'AuthorizationQueryParametersError';
      if (state.now() > parseStamp(stamp) + expires * 1000)
        return 'AccessDenied';
    } else {
      const header = request.headers['authorization'] ?? '';
      const match =
        /^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/.exec(
          header,
        );
      if (!match) return 'AccessDenied';
      [, credential = '', signedHeaders = '', signature = ''] = match;
      stamp = String(request.headers['x-amz-date'] ?? '');
      payload = String(request.headers['x-amz-content-sha256'] ?? '');
      if (Math.abs(state.now() - parseStamp(stamp)) > 15 * 60_000)
        return 'RequestTimeTooSkewed';
      if (payload !== 'UNSIGNED-PAYLOAD' && payload !== sha(body))
        return 'XAmzContentSHA256Mismatch';
    }
    const [accessKey, day, region, service, terminator] = credential.split('/');
    if (
      accessKey !== options.accessKeyId ||
      region !== options.region ||
      service !== 's3' ||
      terminator !== 'aws4_request' ||
      day !== stamp.slice(0, 8)
    )
      return 'InvalidAccessKeyId';
    const names = signedHeaders.split(';');
    if (!names.includes('host')) return 'AccessDenied';
    const canonicalHeaders = names
      .map((name) => {
        const value = request.headers[name];
        return `${name}:${(Array.isArray(value) ? value.join(',') : (value ?? '')).trim().replace(/\s+/g, ' ')}\n`;
      })
      .join('');
    const canonicalQuery = pairs
      .filter(([key]) => key !== 'X-Amz-Signature')
      .map(([key, value]) => [encode(key), encode(value)] as const)
      .sort((a, b) =>
        a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1,
      )
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
    const canonicalPath = url.pathname
      .split('/')
      .map((segment) => encode(decodeURIComponent(segment)))
      .join('/');
    const canonical = [
      request.method,
      canonicalPath,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payload,
    ].join('\n');
    const scope = `${day}/${region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha(canonical)].join(
      '\n',
    );
    const key = mac(
      mac(
        mac(mac(`AWS4${options.secretAccessKey}`, day ?? ''), region ?? ''),
        's3',
      ),
      'aws4_request',
    );
    const expected = createHmac('sha256', key).update(toSign).digest('hex');
    if (
      !timingSafeEqual(
        Buffer.from(expected),
        Buffer.from(signature.padEnd(64, '0').slice(0, 64)),
      )
    )
      return 'SignatureDoesNotMatch';
    return undefined;
  }

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(request.url ?? '/', 'http://fake-s3.invalid');
      const record = (status: number) =>
        requests.push({
          method: request.method ?? '',
          path: url.pathname,
          status,
        });
      if (options.cors) {
        response.setHeader('access-control-allow-origin', options.cors);
        response.setHeader('access-control-allow-methods', 'PUT, GET');
        response.setHeader('access-control-allow-headers', 'content-type');
        if (request.method === 'OPTIONS') {
          response.writeHead(204);
          response.end();
          record(204);
          return;
        }
      }
      if (
        options.inspection &&
        request.method === 'GET' &&
        url.pathname === '/__fake/objects'
      ) {
        record(200);
        response.writeHead(200, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        });
        return response.end(
          JSON.stringify(
            [...objects].map(([key, object]) => ({
              key,
              size: object.body.byteLength,
              sha256: sha(object.body),
              contentType: object.contentType,
            })),
          ),
        );
      }
      const prefix = `/${options.bucket}/`;
      if (!url.pathname.startsWith(prefix)) {
        record(404);
        return deny(response, 404, 'NoSuchBucket');
      }
      const failure = verify(request, url, body);
      if (failure) {
        record(403);
        return deny(response, 403, failure);
      }
      const key = decodeURIComponent(url.pathname.slice(prefix.length));
      if (request.method === 'PUT') {
        const declared = Number(request.headers['content-length']);
        if (declared !== body.byteLength) {
          record(400);
          return deny(response, 400, 'IncompleteBody');
        }
        objects.set(key, {
          body,
          contentType: String(
            request.headers['content-type'] ?? 'binary/octet-stream',
          ),
        });
        record(200);
        response.writeHead(200, { etag: `"${sha(body).slice(0, 32)}"` });
        return response.end();
      }
      const object = objects.get(key);
      if (request.method === 'DELETE') {
        objects.delete(key);
        record(204);
        response.writeHead(204);
        return response.end();
      }
      if (!object) {
        record(404);
        return deny(response, 404, 'NoSuchKey');
      }
      const headers: Record<string, string> = {
        'content-type':
          url.searchParams.get('response-content-type') ?? object.contentType,
        'accept-ranges': 'bytes',
      };
      const disposition = url.searchParams.get('response-content-disposition');
      if (disposition) headers['content-disposition'] = disposition;
      if (request.method === 'HEAD') {
        record(200);
        response.writeHead(200, {
          ...headers,
          'content-length': String(object.body.byteLength),
        });
        return response.end();
      }
      const range = /^bytes=(\d+)-(\d+)$/.exec(
        String(request.headers['range'] ?? ''),
      );
      if (range) {
        const start = Number(range[1]);
        const end = Math.min(Number(range[2]), object.body.byteLength - 1);
        record(206);
        response.writeHead(206, {
          ...headers,
          'content-range': `bytes ${start}-${end}/${object.body.byteLength}`,
          'content-length': String(end - start + 1),
        });
        return response.end(object.body.subarray(start, end + 1));
      }
      record(200);
      response.writeHead(200, {
        ...headers,
        'content-length': String(object.body.byteLength),
      });
      response.end(object.body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Fake S3 did not bind');
  return {
    url: `http://${options.host ?? '127.0.0.1'}:${address.port}`,
    objects,
    requests,
    get now() {
      return state.now;
    },
    set now(value: () => number) {
      state.now = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
