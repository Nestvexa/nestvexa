import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import { createHash } from 'node:crypto';

export const ORIGIN = 'http://uploads.test';

export interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
  json(): Record<string, unknown>;
}
export interface SendOptions {
  readonly headers?: OutgoingHttpHeaders;
  readonly body?: Buffer | string;
  /** Write these body parts with delays (chunked unless content-length is given). */
  readonly parts?: readonly Buffer[];
  /** Destroy the socket after writing `parts` (simulates a client going away). */
  readonly abortAfterParts?: boolean;
  readonly partDelayMs?: number;
}

/** Real HTTP client with byte-level control. Resolves with an error marker on connection reset. */
export function send(
  base: string,
  method: string,
  path: string,
  options: SendOptions = {},
): Promise<Reply> {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      url,
      { method, headers: { connection: 'close', ...options.headers } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body,
            json: () =>
              JSON.parse(body.toString('utf8')) as Record<string, unknown>,
          });
        });
        response.on('error', reject);
      },
    );
    outgoing.on('error', (error: NodeJS.ErrnoException) => {
      if (['ECONNRESET', 'EPIPE', 'ECONNABORTED'].includes(error.code ?? ''))
        resolve({
          status: -1,
          headers: {},
          body: Buffer.alloc(0),
          json: () => ({ code: error.code }),
        });
      else reject(error);
    });
    if (options.parts) {
      void (async () => {
        for (const part of options.parts ?? []) {
          if (outgoing.destroyed) return;
          outgoing.write(part);
          await new Promise((done) =>
            setTimeout(done, options.partDelayMs ?? 20),
          );
        }
        if (options.abortAfterParts) outgoing.destroy();
        else outgoing.end();
      })();
    } else outgoing.end(options.body);
  });
}

export function identity(
  user: string,
  tenant?: string,
): Record<string, string> {
  return {
    'x-test-user': user,
    ...(tenant === undefined ? {} : { 'x-test-tenant': tenant }),
    'x-nestvexa-csrf': csrfFor(user),
    origin: ORIGIN,
  };
}
export function csrfFor(user: string): string {
  return `csrf-${user}-`.padEnd(40, 'x');
}

export const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-png-body-for-tests'),
]);
export const PDF = Buffer.from('%PDF-1.7\n% test document\n%%EOF\n');

export function rawUpload(
  base: string,
  user: string,
  purpose: string,
  name: string,
  body: Buffer,
  extra: OutgoingHttpHeaders = {},
): Promise<Reply> {
  return send(base, 'POST', '/_nestvexa/uploads/files', {
    headers: {
      ...identity(user),
      'content-type': 'application/octet-stream',
      'content-length': String(body.byteLength),
      'x-nestvexa-upload-purpose': purpose,
      'x-nestvexa-upload-name': encodeURIComponent(name),
      ...extra,
    },
    body,
  });
}

export function json(
  base: string,
  method: string,
  path: string,
  user: string,
  body?: unknown,
): Promise<Reply> {
  const text = body === undefined ? undefined : JSON.stringify(body);
  return send(base, method, path, {
    headers: {
      ...identity(user),
      ...(text === undefined
        ? {}
        : {
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(text)),
          }),
    },
    ...(text === undefined ? {} : { body: text }),
  });
}

export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function multipart(
  parts: readonly (
    | { readonly name: string; readonly value: string }
    | {
        readonly name: string;
        readonly filename: string;
        readonly type: string;
        readonly data: Buffer;
      }
  )[],
): { readonly boundary: string; readonly body: Buffer } {
  const boundary = `----nestvexa${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    if ('value' in part)
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`,
        ),
      );
    else
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.type}\r\n\r\n`,
        ),
        part.data,
        Buffer.from('\r\n'),
      );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(chunks) };
}
