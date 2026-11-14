import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserUploadError,
  browserUploadMessage,
  readCookie,
  uploadFile,
  uploadFiles,
} from '../packages/uploads/src/browser/index.js';

// The framework-neutral browser uploader (`@nestvexa/uploads/browser`) against
// a scripted XMLHttpRequest double, imported from source for the coverage
// gate. tests/uploads-browser.test.ts runs the bundled module in Chromium
// against a real Nest upload server; this file pins the protocol edges
// (retries, direct mode, cleanup, malformed replies) deterministically.

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}
type Reply =
  | { status: number; body?: unknown; text?: string }
  | 'error'
  | 'timeout'
  | 'hang';
type Handler = (request: Sent) => Reply;

let handler: Handler = () => ({ status: 500 });
const sent: Sent[] = [];

class FakeXhr {
  status = 0;
  responseText = '';
  timeout = 0;
  upload: { onprogress: ((event: { loaded: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  #request: Sent = { method: '', url: '', headers: {}, body: null };
  #settled = false;
  open(method: string, url: string) {
    this.#request = { method, url, headers: {}, body: null };
  }
  setRequestHeader(name: string, value: string) {
    this.#request.headers[name] = value;
  }
  send(body: unknown) {
    this.#request.body = body;
    sent.push(this.#request);
    const reply = handler(this.#request);
    queueMicrotask(() => {
      if (this.#settled) return;
      if (reply === 'hang') return;
      this.#settled = true;
      if (reply === 'error') return this.onerror?.();
      if (reply === 'timeout') return this.ontimeout?.();
      const size =
        body instanceof Blob
          ? body.size
          : typeof body === 'string'
            ? body.length
            : 0;
      this.upload.onprogress?.({ loaded: size });
      this.status = reply.status;
      this.responseText =
        reply.text ??
        (reply.body === undefined ? '' : JSON.stringify(reply.body));
      this.onload?.();
    });
  }
  abort() {
    if (this.#settled) return;
    this.#settled = true;
    queueMicrotask(() => this.onabort?.());
  }
}

const session = (n: string) => `nvs_${n.repeat(43).slice(0, 43)}`;
const token = (n: string) => `nvu_${n.repeat(43).slice(0, 43)}`;
const file = (text: string, name = 'a.txt') =>
  new File([text], name, { type: 'text/plain' });

/** A chunked server: sessions per file, `chunkSize` bytes per chunk. */
function chunkedServer(chunkSize = 4) {
  const sessions = new Map<
    string,
    { size: number; received: number; next: number }
  >();
  let count = 0;
  const completed: unknown[] = [];
  const route: Handler = (request) => {
    const path = new URL(request.url).pathname;
    if (request.method === 'POST' && path.endsWith('/sessions')) {
      const id = session(String.fromCharCode(97 + count++));
      const { size } = JSON.parse(String(request.body)) as { size: number };
      sessions.set(id, { size, received: 0, next: 0 });
      return {
        status: 201,
        body: { session: id, chunkSize, received: 0, nextIndex: 0 },
      };
    }
    const chunk = /\/sessions\/(nvs_[^/]+)\/chunks\/(\d+)$/.exec(path);
    if (request.method === 'PUT' && chunk?.[1]) {
      const state = sessions.get(chunk[1]);
      if (!state) return { status: 404, body: { code: 'NOT_FOUND' } };
      state.received += (request.body as Blob).size;
      state.next += 1;
      return {
        status: 200,
        body: {
          session: chunk[1],
          chunkSize,
          received: state.received,
          nextIndex: state.next,
        },
      };
    }
    const read = /\/sessions\/(nvs_[^/]+)$/.exec(path);
    if (request.method === 'GET' && read?.[1]) {
      const state = sessions.get(read[1]);
      return {
        status: 200,
        body: {
          session: read[1],
          chunkSize,
          received: state?.received ?? 0,
          nextIndex: state?.next ?? 0,
        },
      };
    }
    const complete = /\/sessions\/(nvs_[^/]+)\/complete$/.exec(path);
    if (request.method === 'POST' && complete?.[1]) {
      completed.push(JSON.parse(String(request.body)));
      return { status: 200, body: { token: token(complete[1].slice(4, 5)) } };
    }
    if (request.method === 'DELETE') return { status: 204 };
    return { status: 500 };
  };
  return { route, completed, sessions };
}

beforeEach(() => {
  sent.length = 0;
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  vi.stubGlobal('location', { href: 'https://app.test/page' });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('uploadFiles over chunked sessions', () => {
  it('uploads files in order with CSRF, offsets, chunk digests and a combined digest', async () => {
    const server = chunkedServer(4);
    handler = server.route;
    let reads = 0;
    const progress: number[] = [];
    const tokens = await uploadFiles(
      [file('hello world'), file('xyz', 'b.txt')],
      {
        purpose: 'avatar',
        csrf: () => `csrf-${++reads}`,
        endpoint: '/uploads/',
        onProgress: (event) => progress.push(event.percentage),
      },
    );
    expect(tokens).toEqual([token('a'), token('b')]);
    expect(Object.isFrozen(tokens)).toBe(true);
    const chunks = sent.filter((request) => request.url.includes('/chunks/'));
    expect(
      chunks.map((request) => request.headers['x-nestvexa-chunk-offset']),
    ).toEqual(['0', '4', '8', '0']);
    expect(
      chunks.every((request) =>
        /^[0-9a-f]{64}$/.test(request.headers['x-nestvexa-chunk-sha256'] ?? ''),
      ),
    ).toBe(true);
    expect(
      sent.every((request) =>
        request.url.startsWith('https://app.test/uploads/'),
      ),
    ).toBe(true);
    expect(
      sent.every((request) =>
        request.headers['x-nestvexa-csrf']?.startsWith('csrf-'),
      ),
    ).toBe(true);
    expect(server.completed).toEqual([
      { digest: expect.stringMatching(/^[0-9a-f]{64}$/) },
      { digest: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(100);
    expect(JSON.parse(String(sent[0]?.body))).toEqual({
      purpose: 'avatar',
      name: 'a.txt',
      type: 'text/plain',
      size: 11,
    });
  });

  it('retries transient chunk failures after re-reading the session, then omits the digest', async () => {
    const server = chunkedServer(4);
    let failures = 0;
    handler = (request) => {
      if (request.url.includes('/chunks/1') && failures < 2) {
        failures++;
        return failures === 1 ? { status: 503 } : 'error';
      }
      return server.route(request);
    };
    await expect(
      uploadFiles([file('abcdefgh')], { purpose: 'doc', csrf: 't' }),
    ).resolves.toEqual([token('a')]);
    expect(sent.filter((request) => request.method === 'GET')).toHaveLength(2);
    expect(server.completed).toEqual([{}]);
  });

  it('gives up after three retries with NETWORK and discards the open session', async () => {
    const server = chunkedServer(4);
    handler = (request) =>
      request.url.includes('/chunks/') ? 'timeout' : server.route(request);
    await expect(
      uploadFiles([file('abcdefgh')], { purpose: 'doc', csrf: 't' }),
    ).rejects.toMatchObject({ code: 'NETWORK' });
    await Promise.resolve();
    expect(sent.at(-1)).toMatchObject({
      method: 'DELETE',
      url: `https://app.test/_nestvexa/uploads/sessions/${session('a')}`,
    });
  }, 15_000);

  it('stops on a server error code and discards earlier tokens and the session', async () => {
    const server = chunkedServer(64);
    handler = (request) => {
      if (
        request.method === 'POST' &&
        request.url.endsWith('/sessions') &&
        server.sessions.size === 1
      )
        return { status: 413, body: { code: 'FILE_TOO_LARGE' } };
      return server.route(request);
    };
    const error = await uploadFiles([file('one'), file('two')], {
      purpose: 'doc',
      csrf: 't',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BrowserUploadError);
    expect(error).toMatchObject({
      code: 'FILE_TOO_LARGE',
      message: 'Upload failed (FILE_TOO_LARGE)',
    });
    expect(browserUploadMessage(error)).toBe('The file is too large.');
    await Promise.resolve();
    expect(
      sent
        .filter((request) => request.method === 'DELETE')
        .map((request) => new URL(request.url).pathname),
    ).toEqual([`/_nestvexa/uploads/files/${token('a')}`]);
  });

  it.each([
    ['a lowercase code', { status: 400, body: { code: 'bad' } }, 'HTTP_400'],
    ['a non-JSON body', { status: 502, text: '<html>' }, 'HTTP_502'],
    ['an array body', { status: 409, body: ['x'] }, 'HTTP_409'],
  ])('maps %s to HTTP_<status>', async (_, reply, code) => {
    handler = () => reply;
    await expect(
      uploadFiles([file('x')], { purpose: 'doc', csrf: 't' }),
    ).rejects.toMatchObject({ code });
  });

  it('rejects malformed session and token replies as RESPONSE', async () => {
    handler = () => ({
      status: 201,
      body: { session: 'nope', chunkSize: 4, received: 0, nextIndex: 0 },
    });
    await expect(
      uploadFiles([file('x')], { purpose: 'doc', csrf: 't' }),
    ).rejects.toMatchObject({ code: 'RESPONSE' });
    const server = chunkedServer(4);
    handler = (request) =>
      request.url.endsWith('/complete')
        ? { status: 200, body: { token: 'bad' } }
        : server.route(request);
    await expect(
      uploadFiles([file('x')], { purpose: 'doc', csrf: 't' }),
    ).rejects.toMatchObject({ code: 'RESPONSE' });
  });
});

describe('uploadFiles in direct mode', () => {
  const direct = (
    url: string,
    headers: unknown = { 'x-amz-acl': 'private' },
  ) => {
    const server = chunkedServer(4);
    handler = (request) => {
      if (request.method === 'POST' && request.url.endsWith('/sessions'))
        return {
          status: 201,
          body: {
            session: session('d'),
            chunkSize: 4,
            received: 0,
            nextIndex: 0,
            mode: 'direct',
            url,
            headers,
          },
        };
      if (request.url.startsWith('https://bucket.test/'))
        return {
          status: request.headers['x-amz-acl'] ? 200 : 403,
          body: { code: 'SIGNATURE' },
        };
      return server.route(request);
    };
    return server;
  };

  it('PUTs the whole file to the presigned URL without the CSRF header', async () => {
    const server = direct('https://bucket.test/object?sig=1');
    await expect(
      uploadFile(file('direct body'), { purpose: 'doc', csrf: 'secret' }),
    ).resolves.toBe(token('d'));
    const put = sent.find((request) =>
      request.url.startsWith('https://bucket.test/'),
    );
    expect(put?.headers).toEqual({ 'x-amz-acl': 'private' });
    expect(server.completed).toEqual([{}]);
  });

  it('never trusts an error code from the foreign storage origin', async () => {
    direct('https://bucket.test/object', {});
    await expect(
      uploadFile(file('x'), { purpose: 'doc', csrf: 't' }),
    ).rejects.toMatchObject({ code: 'HTTP_403' });
  });

  it.each([
    ['a javascript: URL', 'javascript:alert(1)', {}],
    ['credentials in the URL', 'https://user:pass@bucket.test/o', {}],
    ['an unparsable URL', 'http://[bad', {}],
    ['invalid header names', 'https://bucket.test/o', { 'Bad Header': 'x' }],
    ['non-string header values', 'https://bucket.test/o', { 'x-a': 1 }],
    ['missing headers', 'https://bucket.test/o', null],
  ])('rejects %s', async (_, url, headers) => {
    direct(url, headers);
    await expect(
      uploadFile(file('x'), { purpose: 'doc', csrf: 't' }),
    ).rejects.toMatchObject({ code: 'RESPONSE' });
  });
});

describe('uploadFiles options and cancellation', () => {
  it.each([
    ['an invalid purpose', { purpose: '1bad' }],
    ['a protocol-relative endpoint', { endpoint: '//evil.test/u' }],
    ['an absolute URL endpoint', { endpoint: 'https://evil.test/u' }],
    ['a traversing endpoint', { endpoint: '/a/../b' }],
  ])('rejects %s before any request', async (_, options) => {
    await expect(
      uploadFiles([file('x')], { purpose: 'doc', csrf: 't', ...options }),
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    expect(sent).toEqual([]);
  });

  it('reports 100% at once for an empty batch', async () => {
    const progress: number[] = [];
    await expect(
      uploadFiles([], {
        purpose: 'doc',
        csrf: 't',
        onProgress: (event) => progress.push(event.percentage),
      }),
    ).resolves.toEqual([]);
    expect(progress).toEqual([100, 100]);
  });

  it('fails fast when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      uploadFiles([file('x')], {
        purpose: 'doc',
        csrf: 't',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect(sent).toEqual([]);
  });

  it('aborts the pending request and cleans up the session when cancelled mid-upload', async () => {
    const server = chunkedServer(4);
    const controller = new AbortController();
    handler = (request) => {
      if (request.url.includes('/chunks/')) {
        queueMicrotask(() => controller.abort());
        return 'hang';
      }
      return server.route(request);
    };
    const error = await uploadFiles([file('abcdefgh')], {
      purpose: 'doc',
      csrf: 't',
      signal: controller.signal,
      timeoutMs: 5000,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'ABORTED' });
    expect(browserUploadMessage(error)).toBe('Upload cancelled.');
    await Promise.resolve();
    expect(sent.at(-1)?.method).toBe('DELETE');
  });

  it('wraps unexpected failures as NETWORK', async () => {
    handler = () => {
      throw new Error('transport exploded');
    };
    await expect(
      uploadFiles([file('x')], { purpose: 'doc', csrf: 't' }),
    ).rejects.toMatchObject({ code: 'NETWORK' });
  });
});

describe('browserUploadMessage and readCookie', () => {
  it('maps known codes and falls back for unknown codes and foreign errors', () => {
    expect(browserUploadMessage(new BrowserUploadError('QUOTA_EXCEEDED'))).toBe(
      'Upload limit reached.',
    );
    expect(browserUploadMessage(new BrowserUploadError('HTTP_500'))).toBe(
      'Please try again.',
    );
    expect(browserUploadMessage(new Error('x'))).toBe('Please try again.');
    expect(browserUploadMessage(new BrowserUploadError('toString'))).toBe(
      'Please try again.',
    );
  });

  it('reads and decodes cookies, empty when absent, malformed or without a document', () => {
    expect(readCookie('XSRF-TOKEN')).toBe('');
    vi.stubGlobal('document', {
      cookie: 'a=1; XSRF-TOKEN=ab%3Dc=d; bad=%E0%A4%A',
    });
    expect(readCookie('XSRF-TOKEN')).toBe('ab=c=d');
    expect(readCookie('bad')).toBe('');
    expect(readCookie('missing')).toBe('');
  });
});
