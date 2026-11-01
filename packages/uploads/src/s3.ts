import { createReadStream } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Readable } from 'node:stream';
import { fail } from './errors.js';
import { contentDisposition } from './filename.js';
import { EMPTY_SHA256, presignUrl, signRequest } from './sigv4.js';
import type { AwsCredentials } from './sigv4.js';
import { assertStorageKey } from './storage.js';
import type {
  ByteRange,
  DirectUploadTarget,
  PresignedDownloadOptions,
  StorageSource,
  StoredObject,
  UploadStorage,
} from './storage.js';

export interface S3StorageOptions {
  /**
   * Static service endpoint, for example `https://s3.eu-west-1.amazonaws.com`
   * or `http://127.0.0.1:9000` for MinIO. Never derived from requests.
   */
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  /** Server-side credentials or a provider (for rotation). Never sent to browsers. */
  readonly credentials:
    AwsCredentials | (() => AwsCredentials | Promise<AwsCredentials>);
  /** Path-style URLs (`endpoint/bucket/key`). Default true for S3-compatible servers. */
  readonly forcePathStyle?: boolean;
  /** Key prefix such as `uploads/`. Letters, digits, `-`, `_`, `/`. */
  readonly prefix?: string;
  /** Per-request inactivity timeout. Default 30000ms. */
  readonly requestTimeoutMs?: number;
  /** Clock override for tests. */
  readonly now?: () => Date;
}

/**
 * S3-compatible storage using signed HTTP requests (AWS SigV4) and presigned
 * URLs. No AWS SDK is required. Tested against AWS published signing vectors
 * and an in-process S3-compatible test double; validate against your real
 * provider (AWS S3, MinIO, R2, …) before production.
 */
export class S3Storage implements UploadStorage {
  readonly kind = 's3';
  readonly #endpoint: URL;
  readonly #options: S3StorageOptions;
  readonly #prefix: string;
  readonly #timeout: number;
  constructor(options: S3StorageOptions) {
    if (!options || typeof options !== 'object')
      throw new Error('Invalid S3 storage options');
    const endpoint = new URL(options.endpoint);
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      (endpoint.pathname !== '/' && endpoint.pathname !== '')
    )
      throw new Error(
        'S3 endpoint must be an HTTP(S) origin without credentials or path',
      );
    if (
      typeof options.bucket !== 'string' ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket)
    )
      throw new Error('Invalid S3 bucket name');
    if (
      typeof options.region !== 'string' ||
      !/^[a-z0-9-]{1,64}$/.test(options.region)
    )
      throw new Error('Invalid S3 region');
    const prefix = options.prefix ?? '';
    if (
      typeof prefix !== 'string' ||
      !/^(?:[A-Za-z0-9_-]+\/)*$/.test(prefix) ||
      prefix.length > 256
    )
      throw new Error(
        'S3 prefix must be empty or end with "/" and contain only letters, digits, "-" and "_"',
      );
    const timeout = options.requestTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 600_000)
      throw new Error('Invalid S3 request timeout');
    if (
      typeof options.credentials !== 'function' &&
      (!options.credentials || typeof options.credentials !== 'object')
    )
      throw new Error('S3 credentials are required');
    this.#endpoint = endpoint;
    this.#options = options;
    this.#prefix = prefix;
    this.#timeout = timeout;
  }
  private now(): Date {
    return this.#options.now ? this.#options.now() : new Date();
  }
  private async credentials(): Promise<AwsCredentials> {
    const source = this.#options.credentials;
    return typeof source === 'function' ? await source() : source;
  }
  /** Object URL for a generated key; the key shape is checked first. */
  url(key: string): URL {
    assertStorageKey(key);
    const object = `${this.#prefix}${key}`;
    const url = new URL(this.#endpoint.href);
    if (this.#options.forcePathStyle === false) {
      url.hostname = `${this.#options.bucket}.${url.hostname}`;
      url.pathname = `/${object}`;
    } else url.pathname = `/${this.#options.bucket}/${object}`;
    return url;
  }
  private async send(
    method: 'GET' | 'PUT' | 'HEAD' | 'DELETE',
    key: string,
    headers: Record<string, string>,
    payloadHash: string,
    body?: Readable,
  ): Promise<IncomingMessage> {
    const url = this.url(key);
    const signed = signRequest({
      method,
      url,
      headers,
      payloadHash,
      credentials: await this.credentials(),
      region: this.#options.region,
      service: 's3',
      date: this.now(),
    });
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise<IncomingMessage>((resolve, reject) => {
      const outgoing = send(url, { method, headers: signed }, resolve);
      outgoing.setTimeout(this.#timeout, () =>
        outgoing.destroy(new Error('S3 request timed out')),
      );
      outgoing.once('error', reject);
      if (body) {
        body.once('error', (error) => outgoing.destroy(error));
        body.pipe(outgoing);
      } else outgoing.end();
    });
  }
  private static async drain(response: IncomingMessage): Promise<void> {
    response.resume();
    await new Promise<void>((resolve) => {
      response.once('end', resolve);
      response.once('close', resolve);
      response.once('error', () => resolve());
    });
  }
  async put(key: string, source: StorageSource): Promise<StoredObject> {
    assertStorageKey(key);
    if (!/^[a-f0-9]{64}$/.test(source.sha256))
      throw new Error('Invalid source digest');
    const response = await this.send(
      'PUT',
      key,
      {
        'content-type': source.contentType,
        'content-length': String(source.size),
      },
      source.sha256,
      createReadStream(source.path),
    ).catch(() => fail(502, 'STORAGE_FAILED'));
    await S3Storage.drain(response);
    if (response.statusCode !== 200) fail(502, 'STORAGE_FAILED');
    return Object.freeze({ key, size: source.size });
  }
  async open(key: string, range?: ByteRange): Promise<Readable> {
    assertStorageKey(key);
    const response = await this.send(
      'GET',
      key,
      range === undefined ? {} : { range: `bytes=${range.start}-${range.end}` },
      EMPTY_SHA256,
    ).catch(() => fail(502, 'STORAGE_FAILED'));
    if (response.statusCode === 404) {
      await S3Storage.drain(response);
      fail(404, 'UPLOAD_NOT_FOUND');
    }
    if (response.statusCode !== (range === undefined ? 200 : 206)) {
      await S3Storage.drain(response);
      fail(502, 'STORAGE_FAILED');
    }
    return response;
  }
  async stat(key: string): Promise<{ readonly size: number } | undefined> {
    assertStorageKey(key);
    const response = await this.send('HEAD', key, {}, EMPTY_SHA256).catch(() =>
      fail(502, 'STORAGE_FAILED'),
    );
    await S3Storage.drain(response);
    if (response.statusCode === 404) return undefined;
    const length = Number(response.headers['content-length']);
    if (
      response.statusCode !== 200 ||
      !Number.isSafeInteger(length) ||
      length < 0
    )
      fail(502, 'STORAGE_FAILED');
    return Object.freeze({ size: length });
  }
  async delete(key: string): Promise<void> {
    assertStorageKey(key);
    const response = await this.send('DELETE', key, {}, EMPTY_SHA256).catch(
      () => fail(502, 'STORAGE_FAILED'),
    );
    await S3Storage.drain(response);
    if (![200, 204, 404].includes(response.statusCode ?? 0))
      fail(502, 'STORAGE_FAILED');
  }
  /**
   * Presigned PUT whose signature covers content-type and content-length, so
   * the browser can only upload exactly the declared size and type.
   */
  async presignUpload(
    key: string,
    options: {
      readonly contentType: string;
      readonly size: number;
      readonly expiresInSeconds: number;
    },
  ): Promise<DirectUploadTarget> {
    const date = this.now();
    const headers = {
      'content-type': options.contentType,
      'content-length': String(options.size),
    };
    const url = presignUrl({
      method: 'PUT',
      url: this.url(key),
      headers,
      expiresInSeconds: options.expiresInSeconds,
      credentials: await this.credentials(),
      region: this.#options.region,
      service: 's3',
      date,
    });
    return Object.freeze({
      url: url.href,
      method: 'PUT' as const,
      // Browsers set Content-Length themselves; only content-type is sent explicitly.
      headers: Object.freeze({ 'content-type': options.contentType }),
      expiresAt: date.getTime() + options.expiresInSeconds * 1000,
    });
  }
  /** Presigned GET that forces a safe Content-Disposition and Content-Type. */
  async presignDownload(
    key: string,
    options: PresignedDownloadOptions,
  ): Promise<string> {
    const url = this.url(key);
    url.search = `response-content-disposition=${encodeURIComponent(
      contentDisposition(options.filename, options.disposition ?? 'attachment'),
    )}&response-content-type=${encodeURIComponent(options.contentType)}`;
    return presignUrl({
      method: 'GET',
      url,
      expiresInSeconds: options.expiresInSeconds ?? 300,
      credentials: await this.credentials(),
      region: this.#options.region,
      service: 's3',
      date: this.now(),
    }).href;
  }
}
