import { Inject, Injectable } from '@nestjs/common';
import type {
  BeforeApplicationShutdown,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rm, stat, utimes } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import busboy from 'busboy';
import { UploadError, fail } from './errors.js';
import type { UploadErrorCode } from './errors.js';
import { declaredMime, mimeCompatible } from './file-types.js';
import type { FileTypeDefinition } from './file-types.js';
import { decodeFilenameHeader, parseClientFilename } from './filename.js';
import { inspectContent, writeBody } from './inspect.js';
import type {
  ResolvedOptions,
  ResolvedPurpose,
  UploadIdentity,
} from './options.js';
import { UPLOAD_SESSION_PATTERN, UPLOAD_TOKEN_PATTERN } from './references.js';
import { traced } from './instrumentation.js';
import { uploadPolicyEnforcer, uploadSecurityPolicies } from './policies.js';
import type { UploadPolicyEnforcer } from './policies.js';
import type { UploadSpanAttributes } from './instrumentation.js';
import { sendDownload } from './download.js';
import type { ScanVerdict } from './scanner.js';
import type { ByteRange } from './storage.js';

export const UPLOADS_OPTIONS = Symbol('nv:uploads-options');

/** Public description of a pending (temporary) upload. */
export interface UploadReceipt {
  readonly token: string;
  readonly purpose: string;
  readonly name: string;
  readonly size: number;
  readonly contentType: string;
  readonly expiresAt: number;
}
/** Span attributes for a received upload: purpose and size, never the name. */
function receiptAttributes(receipt: UploadReceipt): UploadSpanAttributes {
  return {
    'nestvexa.upload.purpose': receipt.purpose,
    'nestvexa.upload.bytes': receipt.size,
    'nestvexa.upload.files': 1,
  };
}
/** A finalized upload. Persist these fields in your own database. */
export interface FinalizedUpload {
  readonly key: string;
  readonly storage: string;
  readonly purpose: string;
  readonly name: string;
  readonly extension: string;
  readonly contentType: string;
  readonly size: number;
  readonly sha256: string;
  readonly inline: boolean;
  readonly scan: 'clean' | 'not-configured';
}
/** Fields needed to stream a previously finalized file. */
export interface StoredFileReference {
  readonly key: string;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
  readonly sha256?: string;
}
export interface SessionDescription {
  readonly session: string;
  readonly mode: 'chunked' | 'direct';
  readonly chunkSize: number;
  readonly size: number;
  readonly received: number;
  readonly nextIndex: number;
  readonly expiresAt: number;
  readonly url?: string;
  readonly method?: 'PUT';
  readonly headers?: Readonly<Record<string, string>>;
}
export interface FormUploadResult {
  readonly fields: Readonly<Record<string, string>>;
  readonly files: readonly (UploadReceipt & { readonly field: string })[];
}
export interface FormUploadOptions {
  readonly purpose: string;
  /** Hidden form field holding the CSRF token; must precede file inputs. Default `_csrf`. */
  readonly csrfField?: string;
  /** Text fields accepted besides the CSRF field. Default 20. */
  readonly maxFields?: number;
  /** Bytes per text field. Default 8192. */
  readonly maxFieldBytes?: number;
}

interface PendingRecord {
  readonly kind: 'session' | 'file';
  readonly binding: Buffer;
  readonly tenant: string | undefined;
  readonly purpose: string;
  readonly name: string;
  readonly extension: string;
  readonly type: FileTypeDefinition;
  /** Declared (session) or reserved/actual (file) size. */
  size: number;
  received: number;
  readonly chunks: (string | undefined)[];
  readonly temp: string | undefined;
  readonly direct: string | undefined;
  sha256: string | undefined;
  readonly createdAt: number;
  expiresAt: number;
  busy: boolean;
  abort: AbortController | undefined;
}

const maxSessionMs = 24 * 3_600_000;
const tombstoneMs = 60 * 60_000;
const maxTombstones = 10_000;

function header(request: object, name: string): string | undefined {
  const headers: unknown = Reflect.get(request, 'headers');
  if (typeof headers !== 'object' || headers === null) return undefined;
  const value: unknown = Reflect.get(headers, name);
  return typeof value === 'string' ? value : undefined;
}
/** Largest rejected request body that is drained instead of closing the connection. */
const drainLimit = 2 * 1024 * 1024;
function rawRequest(value: object): IncomingMessage {
  if (value instanceof IncomingMessage) return value;
  const raw: unknown = Reflect.get(value, 'raw');
  if (raw instanceof IncomingMessage) return raw;
  return fail(500, 'HTTP_ADAPTER');
}
function rawResponse(value: object): ServerResponse | undefined {
  if (value instanceof ServerResponse) return value;
  const raw: unknown = Reflect.get(value, 'raw');
  return raw instanceof ServerResponse ? raw : undefined;
}
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
function tokenKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
function randomId(): string {
  return randomBytes(32).toString('base64url');
}
function storageKey(): string {
  return `${randomBytes(2).toString('base64url').slice(0, 2)}/${randomId()}`;
}
function plainBody(
  value: unknown,
  keys: readonly string[],
  required: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(400, 'INVALID_REQUEST');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    fail(400, 'INVALID_REQUEST');
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      !keys.includes(key) ||
      !descriptor ||
      !('value' in descriptor)
    )
      fail(400, 'INVALID_REQUEST');
    result[key] = descriptor.value;
  }
  for (const key of required)
    if (!(key in result)) fail(400, 'INVALID_REQUEST');
  return result;
}
function contentLength(request: object): number | undefined {
  const value = header(request, 'content-length');
  if (value === undefined) return undefined;
  if (!/^\d{1,16}$/.test(value)) fail(400, 'INVALID_REQUEST');
  const length = Number(value);
  if (!Number.isSafeInteger(length)) fail(413, 'FILE_TOO_LARGE');
  return length;
}

/**
 * Storage-agnostic upload pipeline. All state is in process memory: pending
 * tokens do not survive restarts, and their temporary files are removed on
 * shutdown and on the next start. Use sticky sessions for multi-instance hosts.
 */
@Injectable()
export class UploadsService
  implements OnModuleInit, BeforeApplicationShutdown, OnApplicationShutdown
{
  readonly #records = new Map<string, PendingRecord>();
  readonly #finalized = new Map<string, number>();
  readonly #active = new Map<string, number>();
  readonly #rate = new Map<string, { start: number; count: number }>();
  readonly #instance = `${process.pid}-${randomBytes(6).toString('hex')}`;
  #sweeper: ReturnType<typeof setInterval> | undefined;
  #closed = false;
  #ready: Promise<void> | undefined;

  /** Origin, CSRF-header and authorization decisions (the kernel registry when configured). */
  readonly #policy: UploadPolicyEnforcer;

  constructor(
    @Inject(UPLOADS_OPTIONS) private readonly options: ResolvedOptions,
  ) {
    this.#policy = uploadPolicyEnforcer(
      uploadSecurityPolicies({
        origin: options.origin,
        resolveIdentity: (request) => this.identity(request),
        authorize: options.authorize,
        maxFileBytes: Math.max(
          ...[...options.purposes.values()].map((entry) => entry.maxFileSize),
        ),
        maxFiles: options.quotas.identityFiles,
        maxTotalBytes: options.quotas.identityBytes,
      }),
      options.policies,
      options.policyOwner,
    );
  }

  /** Per-process temporary directory. */
  get temporaryDirectory(): string {
    return join(this.options.tempDirectory, this.#instance);
  }
  /** Number of pending temporary uploads and sessions (diagnostics/tests). */
  get pendingCount(): number {
    return this.#records.size;
  }

  async onModuleInit(): Promise<void> {
    await this.ready();
    this.#sweeper = setInterval(
      () => void this.sweep(),
      this.options.sweepIntervalMs,
    );
    this.#sweeper.unref();
  }
  private ready(): Promise<void> {
    this.#ready ??= (async () => {
      await mkdir(this.temporaryDirectory, { recursive: true, mode: 0o700 });
      await this.removeStaleInstances();
    })();
    return this.#ready;
  }
  /** Remove temporary directories left by crashed processes after twice the token lifetime. */
  private async removeStaleInstances(): Promise<void> {
    const cutoff = Date.now() - this.options.tokenTtlMs * 2;
    let entries: string[];
    try {
      entries = await readdir(this.options.tempDirectory);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === this.#instance || !/^\d+-[a-f0-9]{12}$/.test(entry))
        continue;
      const path = join(this.options.tempDirectory, entry);
      try {
        if ((await stat(path)).mtimeMs < cutoff)
          await rm(path, { recursive: true, force: true });
      } catch {
        // Another process may own or remove it concurrently.
      }
    }
  }

  /** Delete expired, idle temporary uploads. Runs on a timer; callable directly. */
  async sweep(now = Date.now()): Promise<number> {
    let removed = 0;
    for (const [key, record] of this.#records)
      if (record.expiresAt <= now && !record.busy) {
        this.#records.delete(key);
        await this.dispose(record);
        removed++;
      }
    for (const [key, expires] of this.#finalized)
      if (expires <= now) this.#finalized.delete(key);
    for (const [key, bucket] of this.#rate)
      if (now - bucket.start >= 60_000) this.#rate.delete(key);
    if (!this.#closed) {
      const time = new Date();
      await utimes(this.temporaryDirectory, time, time).catch(() => undefined);
      await this.removeStaleInstances();
    }
    return removed;
  }
  private async dispose(record: PendingRecord): Promise<void> {
    record.abort?.abort();
    if (record.temp)
      await rm(record.temp, { force: true }).catch(() => undefined);
    if (record.direct) {
      const key = record.direct;
      await Promise.race([
        this.options.storage.delete(key).catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 5000).unref()),
      ]);
    }
  }
  beforeApplicationShutdown(): void {
    this.#closed = true;
    if (this.#sweeper) clearInterval(this.#sweeper);
    for (const record of this.#records.values()) record.abort?.abort();
  }
  async onApplicationShutdown(): Promise<void> {
    this.beforeApplicationShutdown();
    const records = [...this.#records.values()];
    this.#records.clear();
    await Promise.all(records.map((record) => this.dispose(record)));
    await rm(this.temporaryDirectory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }

  // ---------------------------------------------------------------- policy
  private async identity(request: object): Promise<UploadIdentity> {
    if (this.#closed) fail(503, 'UPLOADS_SHUTDOWN');
    let identity: UploadIdentity;
    try {
      identity = await this.options.resolveIdentity(request);
    } catch (error) {
      if (error instanceof UploadError) throw error;
      return fail(401, 'IDENTITY_REQUIRED');
    }
    if (
      !identity ||
      typeof identity.binding !== 'string' ||
      identity.binding.length < 16 ||
      identity.binding.length > 1024 ||
      typeof identity.csrfToken !== 'string' ||
      identity.csrfToken.length < 32 ||
      identity.csrfToken.length > 256 ||
      (identity.tenant !== undefined &&
        (typeof identity.tenant !== 'string' ||
          identity.tenant.length < 1 ||
          identity.tenant.length > 256))
    )
      fail(401, 'IDENTITY_REQUIRED');
    return Object.freeze({
      binding: identity.binding,
      csrfToken: identity.csrfToken,
      ...(identity.tenant === undefined ? {} : { tenant: identity.tenant }),
    });
  }
  private purpose(name: unknown): ResolvedPurpose {
    if (typeof name !== 'string') fail(400, 'UNKNOWN_PURPOSE');
    const purpose = this.options.purposes.get(name);
    if (!purpose) return fail(404, 'UNKNOWN_PURPOSE');
    return purpose;
  }
  private async authorize(
    identity: UploadIdentity,
    purpose: string,
    operation: 'upload' | 'finalize' | 'discard',
  ): Promise<void> {
    if (!(await this.#policy.authorize(identity, purpose, operation)))
      fail(403, 'UPLOAD_FORBIDDEN');
    if (this.#closed) fail(503, 'UPLOADS_SHUTDOWN');
  }
  private limit(identity: UploadIdentity): void {
    const now = Date.now();
    const key = digest(identity.binding).toString('hex');
    let bucket = this.#rate.get(key);
    if (!bucket || now - bucket.start >= 60_000) {
      if (!bucket && this.#rate.size >= 10_000) fail(429, 'RATE_LIMIT');
      bucket = { start: now, count: 0 };
      this.#rate.set(key, bucket);
    }
    if (++bucket.count > this.options.quotas.requestsPerMinute)
      fail(429, 'RATE_LIMIT');
  }
  /**
   * HTTP admission for the generated JSON/raw routes: exact Origin for
   * state-changing methods, CSRF header, no content coding, host identity.
   */
  async admit(
    request: object,
    stateChanging: boolean,
  ): Promise<UploadIdentity> {
    if (stateChanging && !this.#policy.originAllowed(header(request, 'origin')))
      fail(403, 'ORIGIN_REJECTED');
    const encoding = header(request, 'content-encoding');
    if (encoding !== undefined && encoding.trim().toLowerCase() !== 'identity')
      fail(415, 'CONTENT_ENCODING');
    const identity = await this.identity(request);
    if (!(await this.#policy.verifyCsrf(request, identity)))
      fail(403, 'CSRF_REJECTED');
    this.limit(identity);
    return identity;
  }
  private enter(identity: UploadIdentity): () => void {
    const key = digest(identity.binding).toString('hex');
    const count = this.#active.get(key) ?? 0;
    if (count >= this.options.quotas.concurrentPerIdentity)
      fail(429, 'CONCURRENCY_LIMIT');
    this.#active.set(key, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.#active.get(key) ?? 1) - 1;
      if (remaining > 0) this.#active.set(key, remaining);
      else this.#active.delete(key);
    };
  }
  /** Quota check for a new pending upload of `size` bytes. */
  private reserve(
    identity: UploadIdentity,
    purpose: ResolvedPurpose,
    size: number,
  ): void {
    const binding = digest(identity.binding);
    const quotas = this.options.quotas;
    let identityFiles = 0;
    let identityBytes = 0;
    let purposeFiles = 0;
    let tenantFiles = 0;
    let tenantBytes = 0;
    let totalBytes = 0;
    for (const record of this.#records.values()) {
      totalBytes += record.size;
      if (timingSafeEqual(record.binding, binding)) {
        identityFiles++;
        identityBytes += record.size;
        if (record.purpose === purpose.name) purposeFiles++;
      }
      if (identity.tenant !== undefined && record.tenant === identity.tenant) {
        tenantFiles++;
        tenantBytes += record.size;
      }
    }
    if (purposeFiles + 1 > purpose.maxFiles) fail(429, 'TOO_MANY_FILES');
    if (
      identityFiles + 1 > quotas.identityFiles ||
      identityBytes + size > quotas.identityBytes ||
      (identity.tenant !== undefined &&
        (tenantFiles + 1 > quotas.tenantFiles ||
          tenantBytes + size > quotas.tenantBytes)) ||
      this.#records.size + 1 > quotas.totalFiles ||
      totalBytes + size > quotas.totalBytes
    )
      fail(429, 'QUOTA_EXCEEDED');
  }
  private fileType(
    purpose: ResolvedPurpose,
    filename: unknown,
    declared: unknown,
  ) {
    const parsed = parseClientFilename(filename);
    const type = purpose.byExtension.get(parsed.extension);
    if (!type) fail(415, 'TYPE_NOT_ALLOWED');
    const mime = declaredMime(declared);
    if (!mimeCompatible(type, mime)) fail(415, 'MIME_MISMATCH');
    return { ...parsed, type };
  }
  private record(
    kind: 'session' | 'file',
    identity: UploadIdentity,
    purpose: ResolvedPurpose,
    file: { name: string; extension: string; type: FileTypeDefinition },
    size: number,
    location: { temp?: string; direct?: string },
  ): PendingRecord {
    const now = Date.now();
    return {
      kind,
      binding: digest(identity.binding),
      tenant: identity.tenant,
      purpose: purpose.name,
      name: file.name,
      extension: file.extension,
      type: file.type,
      size,
      received: 0,
      chunks: [],
      temp: location.temp,
      direct: location.direct,
      sha256: undefined,
      createdAt: now,
      expiresAt: now + this.options.tokenTtlMs,
      busy: false,
      abort: undefined,
    };
  }
  private tempPath(): string {
    return join(this.temporaryDirectory, `${randomId()}.part`);
  }
  private receipt(token: string, record: PendingRecord): UploadReceipt {
    return Object.freeze({
      token,
      purpose: record.purpose,
      name: record.name,
      size: record.size,
      contentType: record.type.mime,
      expiresAt: record.expiresAt,
    });
  }
  /** Find a pending record owned by this identity; other identities see "not found". */
  private owned(
    kind: 'session' | 'file',
    identity: UploadIdentity,
    id: unknown,
  ): { key: string; record: PendingRecord } {
    const pattern =
      kind === 'file' ? UPLOAD_TOKEN_PATTERN : UPLOAD_SESSION_PATTERN;
    if (typeof id !== 'string' || !pattern.test(id))
      fail(400, 'INVALID_UPLOAD_TOKEN');
    const key = tokenKey(id);
    const record = this.#records.get(key);
    if (!record || record.kind !== kind) {
      if (this.#finalized.has(key)) fail(409, 'UPLOAD_ALREADY_FINALIZED');
      return fail(404, 'UPLOAD_NOT_FOUND');
    }
    if (
      !timingSafeEqual(record.binding, digest(identity.binding)) ||
      record.tenant !== identity.tenant
    )
      fail(404, 'UPLOAD_NOT_FOUND');
    if (record.expiresAt <= Date.now() && !record.busy) {
      this.#records.delete(key);
      void this.dispose(record);
      fail(410, 'UPLOAD_EXPIRED');
    }
    return { key, record };
  }
  private json(request: object): void {
    if (
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
        header(request, 'content-type') ?? '',
      )
    )
      fail(415, 'CONTENT_TYPE');
  }
  private markClose(request: object, response?: object): void {
    const raw = response ? rawResponse(response) : undefined;
    const incoming = rawRequest(request);
    if (!raw || incoming.complete || raw.headersSent) return;
    // Closing with unread bytes makes the TCP stack send a reset, and clients
    // (notably on Windows) then lose the error response. Small remainders are
    // read and discarded so the client sees the status; large or unknown
    // remainders still close the connection rather than being drained.
    const declared = Number(header(request, 'content-length'));
    if (Number.isSafeInteger(declared) && declared <= drainLimit) {
      incoming.resume();
      return;
    }
    raw.setHeader('Connection', 'close');
  }

  // ------------------------------------------------------------ single file
  /** `POST <endpoint>/files`: one raw `application/octet-stream` body. */
  async receiveFile(
    request: object,
    response?: object,
  ): Promise<UploadReceipt> {
    try {
      return await traced(
        this.options.instrumentation,
        'nestvexa.upload.receive',
        { 'nestvexa.upload.mode': 'direct' },
        () => this.#receiveFile(request),
        receiptAttributes,
      );
    } catch (error) {
      this.markClose(request, response);
      throw error;
    }
  }
  async #receiveFile(request: object): Promise<UploadReceipt> {
    const identity = await this.admit(request, true);
    if (
      !/^application\/octet-stream$/i.test(
        header(request, 'content-type') ?? '',
      )
    )
      fail(415, 'CONTENT_TYPE');
    const purpose = this.purpose(header(request, 'x-nestvexa-upload-purpose'));
    await this.authorize(identity, purpose.name, 'upload');
    const file = this.fileType(
      purpose,
      decodeFilenameHeader(header(request, 'x-nestvexa-upload-name')),
      header(request, 'x-nestvexa-upload-type'),
    );
    const length = contentLength(request);
    if (length === undefined) fail(411, 'LENGTH_REQUIRED');
    if (length > purpose.maxFileSize) fail(413, 'FILE_TOO_LARGE');
    if (length === 0 && !purpose.allowEmpty) fail(422, 'EMPTY_FILE');
    await this.ready();
    this.reserve(identity, purpose, length);
    const release = this.enter(identity);
    const token = `nvu_${randomId()}`;
    const key = tokenKey(token);
    const record = this.record('file', identity, purpose, file, length, {
      temp: this.tempPath(),
    });
    record.busy = true;
    record.abort = new AbortController();
    this.#records.set(key, record);
    let handle: FileHandle | undefined;
    try {
      const temp = record.temp ?? fail(500, 'STORAGE_FAILED');
      handle = await open(temp, 'wx', 0o600);
      const body = await writeBody(rawRequest(request), handle, {
        position: 0,
        limit: Math.min(length, purpose.maxFileSize),
        idleTimeoutMs: this.options.idleTimeoutMs,
        maxDurationMs: this.options.maxRequestMs,
        signal: record.abort.signal,
        digest: false,
      });
      await handle.close();
      handle = undefined;
      if (body.bytes !== length) fail(400, 'SIZE_MISMATCH');
      const result = await inspectContent(createReadStream(temp), record.type, {
        maxBytes: purpose.maxFileSize,
        allowEmpty: purpose.allowEmpty,
      });
      record.sha256 = result.sha256;
      record.received = result.size;
      record.expiresAt = Date.now() + this.options.tokenTtlMs;
      record.busy = false;
      record.abort = undefined;
      return this.receipt(token, record);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      this.#records.delete(key);
      await this.dispose(record);
      throw error;
    } finally {
      release();
    }
  }

  // ------------------------------------------------------- chunked sessions
  /** `POST <endpoint>/sessions`: start a resumable chunked (or direct) upload. */
  async createSession(
    request: object,
    body: unknown,
  ): Promise<SessionDescription> {
    const identity = await this.admit(request, true);
    this.json(request);
    const input = plainBody(
      body,
      ['purpose', 'name', 'type', 'size'],
      ['purpose', 'name', 'size'],
    );
    const purpose = this.purpose(input['purpose']);
    await this.authorize(identity, purpose.name, 'upload');
    if (input['type'] !== undefined && typeof input['type'] !== 'string')
      fail(400, 'INVALID_REQUEST');
    const file = this.fileType(purpose, input['name'], input['type']);
    const size = input['size'];
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)
      fail(400, 'INVALID_REQUEST');
    if (size > purpose.maxFileSize) fail(413, 'FILE_TOO_LARGE');
    if (size === 0 && !purpose.allowEmpty) fail(422, 'EMPTY_FILE');
    await this.ready();
    this.reserve(identity, purpose, size);
    const session = `nvs_${randomId()}`;
    const storage = this.options.storage;
    if (purpose.direct && storage.presignUpload) {
      const key = storageKey();
      const record = this.record('session', identity, purpose, file, size, {
        direct: key,
      });
      const target = await storage.presignUpload(key, {
        contentType: file.type.mime,
        size,
        expiresInSeconds: Math.max(
          1,
          Math.floor(this.options.tokenTtlMs / 1000),
        ),
      });
      this.#records.set(tokenKey(session), record);
      return Object.freeze({
        session,
        mode: 'direct' as const,
        chunkSize: this.options.chunkSize,
        size,
        received: 0,
        nextIndex: 0,
        expiresAt: record.expiresAt,
        url: target.url,
        method: target.method,
        headers: target.headers,
      });
    }
    const temp = this.tempPath();
    const handle = await open(temp, 'wx', 0o600);
    await handle.close();
    const record = this.record('session', identity, purpose, file, size, {
      temp,
    });
    this.#records.set(tokenKey(session), record);
    return this.describe(session, record);
  }
  private describe(session: string, record: PendingRecord): SessionDescription {
    return Object.freeze({
      session,
      mode: record.direct ? ('direct' as const) : ('chunked' as const),
      chunkSize: this.options.chunkSize,
      size: record.size,
      received: record.received,
      nextIndex: Math.ceil(record.received / this.options.chunkSize),
      expiresAt: record.expiresAt,
    });
  }
  /** `GET <endpoint>/sessions/:id`: resume query for received bytes. */
  async sessionStatus(
    request: object,
    session: unknown,
  ): Promise<SessionDescription> {
    const identity = await this.admit(request, false);
    const { record } = this.owned('session', identity, session);
    return this.describe(String(session), record);
  }
  /** `PUT <endpoint>/sessions/:id/chunks/:index`: append exactly the next chunk. */
  async receiveChunk(
    request: object,
    session: unknown,
    index: unknown,
    response?: object,
  ): Promise<SessionDescription> {
    try {
      return await this.#receiveChunk(request, session, index);
    } catch (error) {
      this.markClose(request, response);
      throw error;
    }
  }
  async #receiveChunk(
    request: object,
    session: unknown,
    indexValue: unknown,
  ): Promise<SessionDescription> {
    const identity = await this.admit(request, true);
    if (
      !/^application\/octet-stream$/i.test(
        header(request, 'content-type') ?? '',
      )
    )
      fail(415, 'CONTENT_TYPE');
    const { record } = this.owned('session', identity, session);
    if (!record.temp) fail(409, 'DIRECT_UPLOAD_UNAVAILABLE');
    await this.authorize(identity, record.purpose, 'upload');
    if (typeof indexValue !== 'string' || !/^\d{1,9}$/.test(indexValue))
      fail(400, 'INVALID_REQUEST');
    const index = Number(indexValue);
    const offsetHeader = header(request, 'x-nestvexa-chunk-offset');
    if (offsetHeader === undefined || !/^\d{1,16}$/.test(offsetHeader))
      fail(400, 'CHUNK_OFFSET');
    const offset = Number(offsetHeader);
    const checksum = header(request, 'x-nestvexa-chunk-sha256');
    if (checksum !== undefined && !/^[a-f0-9]{64}$/.test(checksum))
      fail(400, 'CHUNK_DIGEST');
    const chunkSize = this.options.chunkSize;
    const nextIndex = Math.ceil(record.received / chunkSize);
    if (record.busy) fail(409, 'UPLOAD_BUSY');
    if (index < nextIndex) fail(409, 'CHUNK_ALREADY_RECEIVED');
    if (index > nextIndex) fail(409, 'CHUNK_OUT_OF_ORDER');
    if (offset !== index * chunkSize || offset !== record.received)
      fail(409, 'CHUNK_OFFSET');
    const expected = Math.min(chunkSize, record.size - offset);
    const length = contentLength(request);
    if (length === undefined) fail(411, 'LENGTH_REQUIRED');
    if (expected <= 0 || length !== expected) fail(400, 'CHUNK_SIZE');
    const release = this.enter(identity);
    record.busy = true;
    record.abort = new AbortController();
    let handle: FileHandle | undefined;
    try {
      handle = await open(record.temp, 'r+');
      const body = await writeBody(rawRequest(request), handle, {
        position: offset,
        limit: expected,
        idleTimeoutMs: this.options.idleTimeoutMs,
        maxDurationMs: this.options.maxRequestMs,
        signal: record.abort.signal,
        digest: true,
      });
      if (body.bytes !== expected) fail(400, 'SIZE_MISMATCH');
      if (checksum !== undefined && body.sha256 !== checksum)
        fail(422, 'CHUNK_DIGEST');
      await handle.close();
      handle = undefined;
      record.chunks[index] = checksum;
      record.received = offset + expected;
      const now = Date.now();
      record.expiresAt = Math.min(
        now + this.options.tokenTtlMs,
        record.createdAt + maxSessionMs,
      );
      return this.describe(String(session), record);
    } catch (error) {
      // Discard any partial bytes so the session resumes at the last whole chunk.
      if (handle) {
        await handle.truncate(record.received).catch(() => undefined);
        await handle.close().catch(() => undefined);
      }
      throw error;
    } finally {
      record.busy = false;
      record.abort = undefined;
      release();
    }
  }
  /** `POST <endpoint>/sessions/:id/complete`: verify, inspect and issue the upload token. */
  async completeSession(
    request: object,
    session: unknown,
    body: unknown,
  ): Promise<UploadReceipt> {
    return traced(
      this.options.instrumentation,
      'nestvexa.upload.receive',
      { 'nestvexa.upload.mode': 'chunked' },
      () => this.#completeSession(request, session, body),
      receiptAttributes,
    );
  }
  async #completeSession(
    request: object,
    session: unknown,
    body: unknown,
  ): Promise<UploadReceipt> {
    const identity = await this.admit(request, true);
    this.json(request);
    const input = plainBody(body ?? {}, ['digest'], []);
    const { key, record } = this.owned('session', identity, session);
    await this.authorize(identity, record.purpose, 'upload');
    if (record.busy) fail(409, 'UPLOAD_BUSY');
    const purpose = this.purpose(record.purpose);
    const expectedDigest = input['digest'];
    if (
      expectedDigest !== undefined &&
      (typeof expectedDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(expectedDigest))
    )
      fail(400, 'INVALID_REQUEST');
    record.busy = true;
    try {
      let result: { size: number; sha256: string };
      if (record.direct) {
        const info = await this.options.storage.stat(record.direct);
        if (!info) fail(409, 'UPLOAD_INCOMPLETE');
        if (info.size !== record.size) {
          this.#records.delete(key);
          await this.dispose(record);
          fail(400, 'SIZE_MISMATCH');
        }
        result = await inspectContent(
          await this.options.storage.open(record.direct),
          record.type,
          {
            maxBytes: purpose.maxFileSize,
            allowEmpty: purpose.allowEmpty,
          },
        );
      } else {
        if (record.received !== record.size) fail(409, 'UPLOAD_INCOMPLETE');
        if (expectedDigest !== undefined) {
          const count = Math.ceil(record.size / this.options.chunkSize);
          const hashes = Array.from(
            { length: count },
            (_value, index) => record.chunks[index],
          );
          if (
            !hashes.every((value): value is string => typeof value === 'string')
          )
            fail(422, 'DIGEST_MISMATCH');
          const combined = createHash('sha256')
            .update(
              Buffer.concat(hashes.map((value) => Buffer.from(value, 'hex'))),
            )
            .digest('hex');
          if (combined !== expectedDigest) fail(422, 'DIGEST_MISMATCH');
        }
        result = await inspectContent(
          createReadStream(record.temp ?? ''),
          record.type,
          {
            maxBytes: purpose.maxFileSize,
            allowEmpty: purpose.allowEmpty,
          },
        );
      }
      if (result.size !== record.size) fail(400, 'SIZE_MISMATCH');
      const token = `nvu_${randomId()}`;
      const file: PendingRecord = {
        ...record,
        kind: 'file',
        sha256: result.sha256,
        received: result.size,
        expiresAt: Date.now() + this.options.tokenTtlMs,
        busy: false,
        abort: undefined,
      };
      this.#records.delete(key);
      this.#records.set(tokenKey(token), file);
      return this.receipt(token, file);
    } catch (error) {
      // Content failures are final: remove the session and its bytes.
      if (
        error instanceof UploadError &&
        (
          [
            'CONTENT_MISMATCH',
            'DANGEROUS_CONTENT',
            'EMPTY_FILE',
            'FILE_TOO_LARGE',
          ] as UploadErrorCode[]
        ).includes(error.code)
      ) {
        this.#records.delete(key);
        await this.dispose(record);
      }
      throw error;
    } finally {
      record.busy = false;
    }
  }

  // ------------------------------------------------------------ discard
  /** `DELETE <endpoint>/sessions/:id` or `/files/:token` (cancellation). */
  async discardRequest(
    request: object,
    kind: 'session' | 'file',
    id: unknown,
  ): Promise<void> {
    const identity = await this.admit(request, true);
    await this.#discard(identity, kind, id);
  }
  /** Server-side cancellation of a pending upload token for the current identity. */
  async discard(request: object, token: string): Promise<void> {
    await this.#discard(await this.identity(request), 'file', token);
  }
  async #discard(
    identity: UploadIdentity,
    kind: 'session' | 'file',
    id: unknown,
  ): Promise<void> {
    const { key, record } = this.owned(kind, identity, id);
    await this.authorize(identity, record.purpose, 'discard');
    this.#records.delete(key);
    // Aborting an in-flight chunk also removes its partial bytes.
    await this.dispose(record);
  }

  // ------------------------------------------------------------ inspect/finalize
  /** Describe a pending upload owned by the current identity, for confirmation UIs. */
  async peek(
    request: object,
    token: string,
    options: { readonly purpose: string },
  ): Promise<UploadReceipt> {
    const identity = await this.identity(request);
    const { record } = this.owned('file', identity, token);
    if (record.purpose !== options.purpose) fail(403, 'PURPOSE_MISMATCH');
    if (record.busy || !record.sha256) fail(409, 'UPLOAD_BUSY');
    return this.receipt(token, record);
  }

  /**
   * Commit a temporary upload. Re-resolves the host identity and requires the
   * same binding/tenant, the expected purpose, an unexpired single-use token,
   * unchanged size and SHA-256, a fresh content inspection and (if configured)
   * a clean scan. Call from an authorized action or controller; this method
   * does not check CSRF headers itself.
   */
  async finalize(
    request: object,
    token: string,
    options: { readonly purpose: string },
  ): Promise<FinalizedUpload> {
    if (!options || typeof options.purpose !== 'string')
      throw new Error('finalize requires a purpose');
    return traced(
      this.options.instrumentation,
      'nestvexa.upload.finalize',
      {},
      () => this.#finalize(request, token, options),
      (file) => ({
        'nestvexa.upload.purpose': file.purpose,
        'nestvexa.upload.bytes': file.size,
        'nestvexa.upload.scan': file.scan,
      }),
    );
  }
  async #finalize(
    request: object,
    token: string,
    options: { readonly purpose: string },
  ): Promise<FinalizedUpload> {
    const identity = await this.identity(request);
    const { key, record } = this.owned('file', identity, token);
    if (record.purpose !== options.purpose) fail(403, 'PURPOSE_MISMATCH');
    await this.authorize(identity, record.purpose, 'finalize');
    if (record.busy || !record.sha256) fail(409, 'UPLOAD_BUSY');
    const purpose = this.purpose(record.purpose);
    if (
      !purpose.byExtension.has(record.extension) ||
      record.size > purpose.maxFileSize
    )
      fail(415, 'TYPE_NOT_ALLOWED');
    record.busy = true;
    try {
      const storage = this.options.storage;
      const open = async (): Promise<Readable> =>
        record.direct
          ? storage.open(record.direct)
          : createReadStream(record.temp ?? '');
      const size = record.direct
        ? (await storage.stat(record.direct))?.size
        : await stat(record.temp ?? '').then(
            (info) => info.size,
            () => undefined,
          );
      if (size !== record.size) fail(409, 'UPLOAD_TAMPERED');
      const check = await inspectContent(await open(), record.type, {
        maxBytes: purpose.maxFileSize,
        allowEmpty: purpose.allowEmpty,
      });
      if (check.sha256 !== record.sha256 || check.size !== record.size)
        fail(409, 'UPLOAD_TAMPERED');
      const scan = await this.scan(record, open, purpose);
      if (scan === 'infected') {
        this.#records.delete(key);
        await this.dispose(record);
        fail(422, 'UPLOAD_INFECTED');
      }
      let objectKey: string;
      if (record.direct) objectKey = record.direct;
      else {
        objectKey = storageKey();
        await storage
          .put(objectKey, {
            path: record.temp ?? '',
            size: record.size,
            sha256: record.sha256,
            contentType: record.type.mime,
          })
          .catch((error: unknown) => {
            if (error instanceof UploadError) throw error;
            fail(502, 'STORAGE_FAILED');
          });
      }
      this.#records.delete(key);
      if (this.#finalized.size >= maxTombstones) {
        const oldest = this.#finalized.keys().next();
        if (!oldest.done) this.#finalized.delete(oldest.value);
      }
      this.#finalized.set(key, Date.now() + tombstoneMs);
      if (record.temp)
        await rm(record.temp, { force: true }).catch(() => undefined);
      return Object.freeze({
        key: objectKey,
        storage: storage.kind,
        purpose: record.purpose,
        name: record.name,
        extension: record.extension,
        contentType: record.type.mime,
        size: record.size,
        sha256: record.sha256,
        inline: record.type.inline === true,
        scan,
      });
    } catch (error) {
      if (error instanceof UploadError && error.code === 'UPLOAD_TAMPERED') {
        this.#records.delete(key);
        await this.dispose(record);
      }
      throw error;
    } finally {
      record.busy = false;
    }
  }
  private async scan(
    record: PendingRecord,
    open: () => Promise<Readable>,
    purpose: ResolvedPurpose,
  ): Promise<'clean' | 'infected' | 'not-configured'> {
    const scanner = this.options.scanner;
    if (!scanner) {
      if (purpose.requireScan) fail(503, 'SCANNER_REQUIRED');
      return 'not-configured';
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.scanTimeoutMs,
    );
    timer.unref();
    let verdict: ScanVerdict;
    try {
      verdict = await Promise.race([
        scanner.scan(
          Object.freeze({
            name: record.name,
            contentType: record.type.mime,
            size: record.size,
            sha256: record.sha256 ?? '',
            open,
          }),
          controller.signal,
        ),
        new Promise<ScanVerdict>((resolve) =>
          controller.signal.addEventListener('abort', () =>
            resolve({ status: 'error', reason: 'timeout' }),
          ),
        ),
      ]);
    } catch {
      verdict = { status: 'error' };
    } finally {
      clearTimeout(timer);
    }
    if (verdict?.status === 'clean') return 'clean';
    if (verdict?.status === 'infected') return 'infected';
    return fail(503, 'SCAN_FAILED');
  }

  // ------------------------------------------------------------ HTML form fallback
  /**
   * Receive a no-JavaScript `multipart/form-data` POST with the same validation
   * pipeline. The CSRF field must precede file inputs; a present Origin header
   * must match. Returns pending upload receipts to finalize, then redirect.
   */
  async receiveForm(
    request: object,
    options: FormUploadOptions,
    response?: object,
  ): Promise<FormUploadResult> {
    try {
      return await traced(
        this.options.instrumentation,
        'nestvexa.upload.receive',
        { 'nestvexa.upload.mode': 'form' },
        () => this.#receiveForm(request, options),
        (result) => ({
          'nestvexa.upload.files': result.files.length,
          'nestvexa.upload.bytes': result.files.reduce(
            (sum, file) => sum + file.size,
            0,
          ),
        }),
      );
    } catch (error) {
      this.markClose(request, response);
      throw error;
    }
  }
  async #receiveForm(
    request: object,
    options: FormUploadOptions,
  ): Promise<FormUploadResult> {
    const originHeader = header(request, 'origin');
    if (originHeader !== undefined && !this.#policy.originAllowed(originHeader))
      fail(403, 'ORIGIN_REJECTED');
    const encoding = header(request, 'content-encoding');
    if (encoding !== undefined && encoding.trim().toLowerCase() !== 'identity')
      fail(415, 'CONTENT_ENCODING');
    if (
      !/^multipart\/form-data\s*;/i.test(header(request, 'content-type') ?? '')
    )
      fail(415, 'CONTENT_TYPE');
    const identity = await this.identity(request);
    this.limit(identity);
    const purpose = this.purpose(options.purpose);
    await this.authorize(identity, purpose.name, 'upload');
    const csrfField = options.csrfField ?? '_csrf';
    const maxFields = options.maxFields ?? 20;
    const maxFieldBytes = options.maxFieldBytes ?? 8192;
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(csrfField))
      throw new Error('Invalid CSRF field name');
    if (!Number.isSafeInteger(maxFields) || maxFields < 0 || maxFields > 200)
      throw new Error('Invalid maxFields');
    if (
      !Number.isSafeInteger(maxFieldBytes) ||
      maxFieldBytes < 1 ||
      maxFieldBytes > 1_048_576
    )
      throw new Error('Invalid maxFieldBytes');
    const length = contentLength(request);
    // Generous envelope bound: files plus fields and multipart overhead.
    const envelope =
      purpose.maxFileSize * purpose.maxFiles +
      maxFields * maxFieldBytes +
      1_048_576;
    if (length !== undefined && length > envelope) fail(413, 'FILE_TOO_LARGE');
    await this.ready();
    const raw = rawRequest(request);
    const release = this.enter(identity);
    const controller = new AbortController();
    const created: {
      key: string;
      token: string;
      record: PendingRecord;
      field: string;
    }[] = [];
    const fields: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    let csrfVerified = false;
    let fileCount = 0;
    const parser = busboy({
      headers: raw.headers,
      defParamCharset: 'utf8',
      // Keep the client's raw name so traversal attempts are refused, not silently rewritten.
      preservePath: true,
      limits: {
        fileSize: purpose.maxFileSize + 1,
        files: purpose.maxFiles + 1,
        fields: maxFields + 1,
        fieldSize: maxFieldBytes + 1,
        parts: purpose.maxFiles + maxFields + 2,
        headerPairs: 50,
        fieldNameSize: 100,
      },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        let failed = false;
        let pending = Promise.resolve();
        const abort = (error: unknown): void => {
          if (failed) return;
          failed = true;
          controller.abort();
          raw.unpipe(parser);
          raw.pause();
          reject(error);
        };
        const total = setTimeout(
          () => abort(new UploadError(408, 'UPLOAD_TIMEOUT')),
          this.options.maxRequestMs,
        );
        total.unref();
        parser.on('field', (name, value, info) => {
          if (failed) return;
          if (
            info.nameTruncated ||
            info.valueTruncated ||
            value.length > maxFieldBytes
          )
            return abort(new UploadError(413, 'INVALID_REQUEST'));
          if (name === csrfField) {
            if (!equal(value, identity.csrfToken))
              return abort(new UploadError(403, 'CSRF_REJECTED'));
            csrfVerified = true;
            return;
          }
          if (
            !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(name) ||
            Object.hasOwn(fields, name)
          )
            return abort(new UploadError(400, 'INVALID_REQUEST'));
          fields[name] = value;
        });
        parser.on('file', (field, stream, info) => {
          if (failed) {
            stream.resume();
            return;
          }
          // Browsers submit an empty part for a file input with no selection.
          if (!info.filename) {
            stream.resume();
            return;
          }
          if (!csrfVerified) {
            stream.resume();
            return abort(new UploadError(403, 'CSRF_REJECTED'));
          }
          if (++fileCount > purpose.maxFiles) {
            stream.resume();
            return abort(new UploadError(413, 'TOO_MANY_FILES'));
          }
          if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(field)) {
            stream.resume();
            return abort(new UploadError(400, 'INVALID_REQUEST'));
          }
          let file: ReturnType<UploadsService['fileType']>;
          try {
            file = this.fileType(purpose, info.filename, info.mimeType);
            this.reserve(identity, purpose, purpose.maxFileSize);
          } catch (error) {
            stream.resume();
            return abort(error);
          }
          const token = `nvu_${randomId()}`;
          const key = tokenKey(token);
          const record = this.record(
            'file',
            identity,
            purpose,
            file,
            purpose.maxFileSize,
            {
              temp: this.tempPath(),
            },
          );
          record.busy = true;
          this.#records.set(key, record);
          created.push({ key, token, record, field });
          pending = pending
            .then(async () => {
              if (failed) {
                stream.resume();
                return;
              }
              const handle = await open(record.temp ?? '', 'wx', 0o600);
              try {
                const result = await writeBody(stream, handle, {
                  position: 0,
                  limit: purpose.maxFileSize,
                  idleTimeoutMs: this.options.idleTimeoutMs,
                  maxDurationMs: this.options.maxRequestMs,
                  signal: controller.signal,
                  digest: false,
                });
                if (Reflect.get(stream, 'truncated') === true)
                  fail(413, 'FILE_TOO_LARGE');
                record.size = result.bytes;
              } finally {
                await handle.close();
              }
            })
            .catch((error: unknown) => {
              stream.resume();
              abort(error);
            });
        });
        parser.on('filesLimit', () =>
          abort(new UploadError(413, 'TOO_MANY_FILES')),
        );
        parser.on('fieldsLimit', () =>
          abort(new UploadError(413, 'INVALID_REQUEST')),
        );
        parser.on('partsLimit', () =>
          abort(new UploadError(413, 'INVALID_REQUEST')),
        );
        parser.once('error', () =>
          abort(new UploadError(400, 'INVALID_REQUEST')),
        );
        parser.once('close', () => {
          clearTimeout(total);
          void pending.then(() => {
            if (failed) return;
            if (!csrfVerified)
              return abort(new UploadError(403, 'CSRF_REJECTED'));
            resolve();
          });
        });
        raw.once('aborted', () =>
          abort(new UploadError(400, 'UPLOAD_INTERRUPTED')),
        );
        raw.pipe(parser);
      });
      const files: (UploadReceipt & { readonly field: string })[] = [];
      for (const entry of created) {
        const purposeEntry = this.purpose(entry.record.purpose);
        const result = await inspectContent(
          createReadStream(entry.record.temp ?? ''),
          entry.record.type,
          {
            maxBytes: purposeEntry.maxFileSize,
            allowEmpty: purposeEntry.allowEmpty,
          },
        );
        entry.record.size = result.size;
        entry.record.received = result.size;
        entry.record.sha256 = result.sha256;
        entry.record.expiresAt = Date.now() + this.options.tokenTtlMs;
        entry.record.busy = false;
        files.push(
          Object.freeze({
            ...this.receipt(entry.token, entry.record),
            field: entry.field,
          }),
        );
      }
      return Object.freeze({
        fields: Object.freeze({ ...fields }),
        files: Object.freeze(files),
      });
    } catch (error) {
      for (const entry of created) {
        this.#records.delete(entry.key);
        await this.dispose(entry.record);
      }
      throw error;
    } finally {
      release();
    }
  }

  // ------------------------------------------------------------ downloads
  /**
   * Stream a finalized file through a host route that has already checked the
   * caller may read it (ownership/tenant). Supports single Range requests.
   */
  async download(
    request: object,
    response: object,
    file: StoredFileReference,
    options: {
      readonly disposition?: 'attachment' | 'inline';
      readonly cacheControl?: string;
    } = {},
  ): Promise<void> {
    const contentType = this.knownType(file.contentType);
    await sendDownload(request, response, {
      filename: file.name,
      contentType,
      size: file.size,
      open: (range?: ByteRange) => this.options.storage.open(file.key, range),
      ...(options.disposition === undefined
        ? {}
        : { disposition: options.disposition }),
      ...(options.cacheControl === undefined
        ? {}
        : { cacheControl: options.cacheControl }),
      ...(file.sha256 !== undefined && /^[a-f0-9]{64}$/.test(file.sha256)
        ? { etag: `"${file.sha256.slice(0, 32)}"` }
        : {}),
      idleTimeoutMs: this.options.idleTimeoutMs,
    });
  }
  /** Presigned storage URL (S3) for a finalized file; undefined when storage cannot presign. */
  async presignDownload(
    file: StoredFileReference,
    options: {
      readonly expiresInSeconds?: number;
      readonly disposition?: 'attachment' | 'inline';
    } = {},
  ): Promise<string | undefined> {
    const storage = this.options.storage;
    if (!storage.presignDownload) return undefined;
    return storage.presignDownload(file.key, {
      filename: file.name,
      contentType: this.knownType(file.contentType),
      ...(options.expiresInSeconds === undefined
        ? {}
        : { expiresInSeconds: options.expiresInSeconds }),
      ...(options.disposition === undefined
        ? {}
        : { disposition: options.disposition }),
    });
  }
  /** Delete a finalized object from storage (after your own authorization). */
  async remove(file: Pick<StoredFileReference, 'key'>): Promise<void> {
    await this.options.storage.delete(file.key);
  }
  private knownType(contentType: string): string {
    for (const purpose of this.options.purposes.values())
      for (const type of purpose.types)
        if (type.mime === contentType) return contentType;
    return 'application/octet-stream';
  }
}
