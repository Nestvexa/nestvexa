/**
 * Framework-neutral browser uploader for the `@nestvexa/uploads` routes, for
 * SPA frontends (Inertia React/Vue/Svelte, islands) that are not Live
 * components. It speaks the same protocol as the Live client: a chunked
 * session (`POST /sessions`, `PUT …/chunks/:index` with per-chunk SHA-256,
 * `POST …/complete`) or a presigned direct PUT, with progress events, abort
 * through an `AbortSignal`, bounded retries of transient chunk failures, and
 * server-side cancellation of whatever was started when a batch fails. The
 * result is opaque `nvu_…` tokens that a form submits instead of file bytes;
 * the server finalizes them (`UploadsService.finalize` or
 * `@nestvexa/forms` `finalizeFileField`).
 *
 * No framework, Node or Nest import: this entry is safe for any bundler.
 */

/** Options shared by every upload. */
export interface BrowserUploadOptions {
  /** Upload purpose registered in `UploadsModule.register({ purposes })`. */
  readonly purpose: string;
  /**
   * The host CSRF token sent as `x-nestvexa-csrf` (the same value
   * `resolveIdentity` returns as `csrfToken`). A function is read per request,
   * for example to read the `XSRF-TOKEN` cookie.
   */
  readonly csrf: string | (() => string);
  /** Same-origin route prefix. Default `/_nestvexa/uploads`. */
  readonly endpoint?: string;
  /** Cancels the upload (pending requests are aborted, the server session is discarded). */
  readonly signal?: AbortSignal;
  /** Called with cumulative bytes sent across the batch. */
  readonly onProgress?: (progress: BrowserUploadProgress) => void;
  /** Per-request timeout in ms. Default 120 000. */
  readonly timeoutMs?: number;
}

export interface BrowserUploadProgress {
  readonly loaded: number;
  readonly total: number;
  /** Whole percent, 0–100. */
  readonly percentage: number;
  /** Index of the file being sent. */
  readonly file: number;
}

/**
 * Failure with a closed machine-readable `code`: the server's upload error
 * code (`FILE_TOO_LARGE`, `TYPE_NOT_ALLOWED`, `QUOTA_EXCEEDED`, …),
 * `HTTP_<status>`, `NETWORK`, `ABORTED`, `RESPONSE` (malformed reply) or
 * `INVALID_OPTIONS`. Messages never include file names or tokens.
 */
export class BrowserUploadError extends Error {
  override readonly name = 'BrowserUploadError';
  constructor(readonly code: string) {
    super(`Upload failed (${code})`);
  }
}

/** Default English messages per code; map `code` yourself to localize. */
export const browserUploadMessages: Readonly<Record<string, string>> =
  Object.freeze({
    FILE_TOO_LARGE: 'The file is too large.',
    EMPTY_FILE: 'The file is empty.',
    QUOTA_EXCEEDED: 'Upload limit reached.',
    TOO_MANY_FILES: 'Upload limit reached.',
    INVALID_FILENAME: 'The file name is not allowed.',
    MISSING_EXTENSION: 'The file name is not allowed.',
    TYPE_NOT_ALLOWED: 'This file type is not allowed.',
    MIME_MISMATCH: 'This file type is not allowed.',
    CONTENT_MISMATCH: 'This file type is not allowed.',
    DANGEROUS_EXTENSION: 'This file type is not allowed.',
    DANGEROUS_CONTENT: 'This file type is not allowed.',
    ABORTED: 'Upload cancelled.',
  });

/** Human message for an upload failure (`Please try again.` when unknown). */
export function browserUploadMessage(error: unknown): string {
  const code = error instanceof BrowserUploadError ? error.code : 'NETWORK';
  return Object.hasOwn(browserUploadMessages, code)
    ? (browserUploadMessages[code] ?? 'Please try again.')
    : 'Please try again.';
}

const sessionPattern = /^nvs_[A-Za-z0-9_-]{43}$/;
const tokenPattern = /^nvu_[A-Za-z0-9_-]{43}$/;
const purposePattern =
  /^[A-Za-z][A-Za-z0-9_-]{0,63}(?:\.[A-Za-z][A-Za-z0-9_-]{0,63})?$/;
const codePattern = /^[A-Z_]{1,40}$/;
const transient = /^(?:NETWORK|HTTP_5\d\d|CHUNK_ALREADY_RECEIVED|UPLOAD_BUSY)$/;

interface Session {
  readonly id: string;
  readonly chunkSize: number;
  readonly received: number;
  readonly nextIndex: number;
  readonly direct?: {
    readonly url: string;
    readonly headers: Record<string, string>;
  };
}

interface Request {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: XMLHttpRequestBodyInit | null;
  readonly sameOrigin: boolean;
  /** Server-side cleanup after a failure or abort: never cancelled by the signal. */
  readonly cleanup?: boolean;
  readonly progress?: (loaded: number) => void;
}

/** Endpoint must be a same-origin absolute path (never a URL or `//host`). */
function endpointOf(value: string | undefined): string {
  const endpoint = value ?? '/_nestvexa/uploads';
  if (
    !/^\/[A-Za-z0-9._~/-]{0,200}$/.test(endpoint) ||
    endpoint.startsWith('//') ||
    endpoint.includes('..')
  )
    throw new BrowserUploadError('INVALID_OPTIONS');
  return endpoint.replace(/\/+$/, '');
}

function sessionOf(body: Record<string, unknown>): Session {
  const { session: id, chunkSize, received, nextIndex } = body;
  if (
    typeof id !== 'string' ||
    !sessionPattern.test(id) ||
    typeof chunkSize !== 'number' ||
    !Number.isSafeInteger(chunkSize) ||
    chunkSize < 1 ||
    typeof received !== 'number' ||
    !Number.isSafeInteger(received) ||
    typeof nextIndex !== 'number' ||
    !Number.isSafeInteger(nextIndex)
  )
    throw new BrowserUploadError('RESPONSE');
  const session = { id, chunkSize, received, nextIndex };
  if (body['mode'] !== 'direct') return session;
  let url: URL;
  try {
    url = new URL(String(body['url']));
  } catch {
    throw new BrowserUploadError('RESPONSE');
  }
  const headers = body['headers'];
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    typeof headers !== 'object' ||
    headers === null ||
    Object.entries(headers).some(
      ([name, value]) =>
        !/^[a-z0-9-]{1,64}$/.test(name) || typeof value !== 'string',
    )
  )
    throw new BrowserUploadError('RESPONSE');
  return {
    ...session,
    direct: {
      url: url.href,
      headers: { ...(headers as Record<string, string>) },
    },
  };
}

async function sha256(
  data: Blob | Uint8Array<ArrayBuffer>,
): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return undefined;
  const bytes =
    data instanceof Uint8Array
      ? data
      : new Uint8Array(await data.arrayBuffer());
  const hash = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Uploads `files` one after another and resolves with one token per file in
 * order. On failure or abort every token already issued and the open session
 * are discarded on the server, and the promise rejects with
 * {@link BrowserUploadError}.
 */
export async function uploadFiles(
  files: readonly File[],
  options: BrowserUploadOptions,
): Promise<readonly string[]> {
  if (!purposePattern.test(options.purpose))
    throw new BrowserUploadError('INVALID_OPTIONS');
  const endpoint = endpointOf(options.endpoint);
  const base = new URL(endpoint, globalThis.location.href).href;
  const timeout = options.timeoutMs ?? 120_000;
  const csrf = () =>
    typeof options.csrf === 'function' ? options.csrf() : options.csrf;
  const signal = options.signal;
  let current: XMLHttpRequest | undefined;
  let openSession: string | undefined;
  const tokens: string[] = [];
  const total = files.reduce((sum, file) => sum + file.size, 0);
  let done = 0;
  let index = 0;

  const send = (request: Request): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      if (!request.cleanup && signal?.aborted)
        return reject(new BrowserUploadError('ABORTED'));
      const xhr = new XMLHttpRequest();
      if (!request.cleanup) current = xhr;
      xhr.open(request.method, request.url);
      xhr.timeout = timeout;
      if (request.sameOrigin) xhr.setRequestHeader('x-nestvexa-csrf', csrf());
      for (const [name, value] of Object.entries(request.headers))
        xhr.setRequestHeader(name, value);
      const progress = request.progress;
      if (progress) xhr.upload.onprogress = (event) => progress(event.loaded);
      xhr.onload = () => {
        let parsed: unknown;
        try {
          parsed = xhr.responseText ? JSON.parse(xhr.responseText) : {};
        } catch {
          parsed = {};
        }
        const body =
          typeof parsed === 'object' &&
          parsed !== null &&
          !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
        if (xhr.status >= 200 && xhr.status < 300) return resolve(body);
        const code = body['code'];
        reject(
          new BrowserUploadError(
            request.sameOrigin &&
              typeof code === 'string' &&
              codePattern.test(code)
              ? code
              : `HTTP_${xhr.status}`,
          ),
        );
      };
      xhr.onerror = xhr.ontimeout = () =>
        reject(new BrowserUploadError('NETWORK'));
      xhr.onabort = () => reject(new BrowserUploadError('ABORTED'));
      xhr.send(request.body);
    });
  const json = (method: string, path: string, body?: unknown) =>
    send({
      method,
      url: base + path,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? null : JSON.stringify(body),
      sameOrigin: true,
    });
  const report = (loaded: number) => {
    const sent = Math.min(done + loaded, total);
    options.onProgress?.({
      loaded: sent,
      total,
      percentage: total === 0 ? 100 : Math.floor((sent / total) * 100),
      file: index,
    });
  };
  const discard = (path: string) => {
    void send({
      method: 'DELETE',
      url: base + path,
      headers: {},
      body: null,
      sameOrigin: true,
      cleanup: true,
    }).catch(() => undefined);
  };
  const abort = () => current?.abort();
  signal?.addEventListener('abort', abort, { once: true });

  async function one(file: File): Promise<string> {
    const started = sessionOf(
      await json('POST', '/sessions', {
        purpose: options.purpose,
        name: file.name,
        type: file.type,
        size: file.size,
      }),
    );
    openSession = started.id;
    const path = `/sessions/${started.id}`;
    let digests: (string | undefined)[] | undefined =
      started.received === 0 ? [] : undefined;
    if (started.direct) {
      await send({
        method: 'PUT',
        url: started.direct.url,
        headers: started.direct.headers,
        body: file,
        sameOrigin: false,
        progress: report,
      });
    } else {
      let state = started;
      for (let retries = 0; state.received < file.size;) {
        const offset = state.received;
        const chunk = file.slice(offset, offset + state.chunkSize);
        const hash = await sha256(chunk);
        try {
          state = sessionOf(
            await send({
              method: 'PUT',
              url: `${base}${path}/chunks/${state.nextIndex}`,
              headers: {
                'content-type': 'application/octet-stream',
                'x-nestvexa-chunk-offset': String(offset),
                ...(hash === undefined
                  ? {}
                  : { 'x-nestvexa-chunk-sha256': hash }),
              },
              body: chunk,
              sameOrigin: true,
              progress: (loaded) => report(offset + loaded),
            }),
          );
          if (digests) digests[state.nextIndex - 1] = hash;
        } catch (error) {
          const code =
            error instanceof BrowserUploadError ? error.code : 'NETWORK';
          if (signal?.aborted || ++retries > 3 || !transient.test(code))
            throw error;
          digests = undefined;
          await new Promise((resolve) => setTimeout(resolve, 250 * retries));
          state = sessionOf(await json('GET', path));
        }
      }
    }
    let combined: string | undefined;
    if (
      digests?.length &&
      !started.direct &&
      digests.every((value) => value !== undefined)
    ) {
      const bytes = new Uint8Array(digests.length * 32);
      digests.forEach((value, position) => {
        for (let offset = 0; offset < 32; offset++)
          bytes[position * 32 + offset] = parseInt(
            value.slice(offset * 2, offset * 2 + 2),
            16,
          );
      });
      combined = await sha256(bytes);
    }
    const completed = await json(
      'POST',
      `${path}/complete`,
      combined === undefined ? {} : { digest: combined },
    );
    openSession = undefined;
    const token = completed['token'];
    if (typeof token !== 'string' || !tokenPattern.test(token))
      throw new BrowserUploadError('RESPONSE');
    return token;
  }

  try {
    report(0);
    for (const file of files) {
      tokens.push(await one(file));
      done += file.size;
      index += 1;
    }
    report(0);
    return Object.freeze([...tokens]);
  } catch (error) {
    for (const token of tokens) discard(`/files/${token}`);
    if (openSession) discard(`/sessions/${openSession}`);
    throw signal?.aborted
      ? new BrowserUploadError('ABORTED')
      : error instanceof BrowserUploadError
        ? error
        : new BrowserUploadError('NETWORK');
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

/** Uploads one file; see {@link uploadFiles}. */
export async function uploadFile(
  file: File,
  options: BrowserUploadOptions,
): Promise<string> {
  const [token] = await uploadFiles([file], options);
  if (token === undefined) throw new BrowserUploadError('RESPONSE');
  return token;
}

/**
 * Reads a cookie by name (for example the `XSRF-TOKEN` cookie that hosts
 * using the official Inertia client already set), URL-decoded; `''` when absent.
 */
export function readCookie(name: string): string {
  if (typeof document === 'undefined') return '';
  for (const part of document.cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return '';
      }
    }
  }
  return '';
}
