import {
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import { chromium } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  copyUploadEndpoint,
  parseUploadDirective,
} from '../packages/client/dist/upload.js';
import { parseDirective } from '../packages/client/dist/protocol.js';

declare global {
  interface Window {
    nvUploadFixture: typeof import('../packages/client/dist/upload.js');
    nvUploadSession: {
      controller: import('../packages/client/dist/upload.js').UploadController;
      sets: { field: string; value: string }[];
      errors: string[];
    };
  }
}

describe('closed upload grammar', () => {
  it('accepts a field name for each role', () => {
    expect(parseUploadDirective('nv:upload', 'files')).toEqual({
      kind: 'upload',
      role: 'input',
      field: 'files',
    });
    expect(parseDirective('nv:upload.progress', 'files')).toEqual({
      kind: 'upload',
      role: 'progress',
      field: 'files',
    });
    expect(parseDirective('nv:upload.status', 'files')).toEqual({
      kind: 'upload',
      role: 'status',
      field: 'files',
    });
    expect(parseDirective('nv:upload.cancel', 'files')).toEqual({
      kind: 'upload',
      role: 'cancel',
      field: 'files',
    });
  });
  it.each([
    ['nv:upload', '/_nestvexa/uploads'],
    ['nv:upload', 'files.purpose'],
    ['nv:upload', 'files()'],
    ['nv:upload', '__proto__'],
    ['nv:upload', ''],
    ['nv:upload.url', 'files'],
    ['nv:upload.progress.extra', 'files'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => parseDirective(name, value)).toThrow();
  });
  it('copies only a same-origin path endpoint', () => {
    expect(copyUploadEndpoint({ endpoint: '/_nestvexa/uploads' })).toBe(
      '/_nestvexa/uploads',
    );
    expect(copyUploadEndpoint(undefined)).toBeUndefined();
    for (const bad of [
      { endpoint: 'https://evil.example/u' },
      { endpoint: '//evil.example' },
      { endpoint: '/a?b' },
      { endpoint: '/a', extra: 1 },
      'x',
    ])
      expect(() => copyUploadEndpoint(bad)).toThrow();
    let reads = 0;
    const getter = Object.defineProperty({}, 'endpoint', {
      enumerable: true,
      get() {
        reads++;
        return '/u';
      },
    });
    expect(() => copyUploadEndpoint(getter)).toThrow();
    expect(reads).toBe(0);
  });
});

interface Upload {
  name: string;
  size: number;
  received: number;
  chunks: string[];
  failedOnce: boolean;
}
const sessions = new Map<string, Upload>();
const log: string[] = [];
let releaseSlow: (() => void) | undefined;
let browser: Browser;
let page: Page;
let server: Server;
let base: string;
const CHUNK = 4;

function body(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
  });
}
beforeAll(async () => {
  server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const send = (status: number, value: unknown) =>
        response
          .writeHead(status, { 'content-type': 'application/json' })
          .end(JSON.stringify(value));
      if (path === '/') {
        response
          .writeHead(200, { 'content-type': 'text/html' })
          .end(
            '<!doctype html><html lang="en"><head><title>Upload fixture</title><script type="module" src="/fixture.js"></script></head><body><main></main></body></html>',
          );
        return;
      }
      if (path === '/fixture.js') {
        response
          .writeHead(200, { 'content-type': 'text/javascript' })
          .end(
            "import * as upload from '/upload.js'; window.nvUploadFixture=upload;",
          );
        return;
      }
      if (path.startsWith('/up/')) {
        log.push(
          `${request.method} ${path.replace(/nvs_[A-Za-z0-9_-]{43}/, 'S')} csrf=${String(request.headers['x-nestvexa-csrf'] === 'c'.repeat(32))}`,
        );
        const data = await body(request);
        if (request.method === 'POST' && path === '/up/sessions') {
          const input = JSON.parse(data.toString()) as {
            name: string;
            size: number;
            purpose: string;
          };
          if (input.purpose !== 'docs.files')
            return send(400, { code: 'UNKNOWN_PURPOSE' });
          if (input.name.startsWith('bad'))
            return send(415, { code: 'CONTENT_MISMATCH' });
          const id = `nvs_${createHash('sha256')
            .update(input.name + Math.random())
            .digest('base64url')
            .slice(0, 43)}`;
          sessions.set(id, {
            name: input.name,
            size: input.size,
            received: 0,
            chunks: [],
            failedOnce: false,
          });
          return send(201, {
            session: id,
            mode: 'chunked',
            chunkSize: CHUNK,
            size: input.size,
            received: 0,
            nextIndex: 0,
            expiresAt: Date.now() + 60_000,
          });
        }
        const match =
          /^\/up\/sessions\/(nvs_[A-Za-z0-9_-]{43})(?:\/(chunks\/(\d+)|complete))?$/.exec(
            path,
          );
        const session = match?.[1] ? sessions.get(match[1]) : undefined;
        if (!match || !session) return send(404, { code: 'UPLOAD_NOT_FOUND' });
        const describe = () => ({
          session: match[1],
          mode: 'chunked',
          chunkSize: CHUNK,
          size: session.size,
          received: session.received,
          nextIndex: Math.ceil(session.received / CHUNK),
          expiresAt: 0,
        });
        if (request.method === 'GET') return send(200, describe());
        if (request.method === 'DELETE') {
          sessions.delete(match[1] ?? '');
          response.writeHead(204).end();
          return;
        }
        if (request.method === 'PUT' && match[3] !== undefined) {
          if (session.name.startsWith('slow') && Number(match[3]) === 1) {
            await new Promise<void>((resolve) => {
              releaseSlow = resolve;
              request.socket.once('close', () => resolve());
            });
            if (request.socket.destroyed) return;
          }
          if (
            session.name.startsWith('flaky') &&
            Number(match[3]) === 1 &&
            !session.failedOnce
          ) {
            session.failedOnce = true;
            session.received += data.byteLength; // the bytes arrived, but the reply is lost
            session.chunks[1] = String(
              request.headers['x-nestvexa-chunk-sha256'],
            );
            request.socket.destroy();
            return;
          }
          // Same ordering as the real server: an already received index is reported as such.
          if (Number(match[3]) < Math.ceil(session.received / CHUNK))
            return send(409, { code: 'CHUNK_ALREADY_RECEIVED' });
          if (
            Number(request.headers['x-nestvexa-chunk-offset']) !==
            session.received
          )
            return send(409, { code: 'CHUNK_OFFSET' });
          const digest = createHash('sha256').update(data).digest('hex');
          if (request.headers['x-nestvexa-chunk-sha256'] !== digest)
            return send(422, { code: 'CHUNK_DIGEST' });
          session.chunks[Number(match[3])] = digest;
          session.received += data.byteLength;
          return send(200, describe());
        }
        if (request.method === 'POST' && match[2] === 'complete') {
          const input = JSON.parse(data.toString() || '{}') as {
            digest?: string;
          };
          if (input.digest !== undefined) {
            const combined = createHash('sha256')
              .update(
                Buffer.concat(
                  session.chunks.map((value) => Buffer.from(value, 'hex')),
                ),
              )
              .digest('hex');
            if (combined !== input.digest)
              return send(422, { code: 'DIGEST_MISMATCH' });
          }
          log.push(`digest=${input.digest === undefined ? 'none' : 'sent'}`);
          return send(200, {
            token: `nvu_${'t'.repeat(39)}${String(session.size).padStart(4, '0')}`,
          });
        }
        return send(405, { code: 'INVALID_REQUEST' });
      }
      if (!/^\/[a-z][a-z0-9-]*\.js$/.test(path))
        return response.writeHead(404).end();
      const source = await readFile(
        new URL(`../packages/client/dist/${path.slice(1)}`, import.meta.url),
        'utf8',
      ).catch(() => undefined);
      if (source === undefined) return response.writeHead(404).end();
      response
        .writeHead(200, { 'content-type': 'text/javascript' })
        .end(source);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing fixture port');
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
});
describe('browser upload controller', () => {
  beforeEach(async () => {
    log.length = 0;
    page = await browser.newPage();
    await page.goto(base);
    await page.waitForFunction(() => Reflect.has(window, 'nvUploadFixture'));
    await page.evaluate(() => {
      document
        .querySelector('main')
        ?.insertAdjacentHTML(
          'beforeend',
          `<div data-nv-component data-nv-name="docs"><label for="f">Files</label><input id="f" type="file" multiple nv:upload="files"><progress nv:upload.progress="files" value="0" max="1"></progress><p role="status" nv:upload.status="files"></p><button type="button" nv:upload.cancel="files">Cancel</button></div>`,
        );
      const root = document.querySelector('[data-nv-component]');
      if (!root) throw new Error('missing root');
      window.nvUploadFixture.validateUploads(root, true);
      const sets: { field: string; value: string }[] = [];
      const errors: string[] = [];
      window.nvUploadSession = {
        sets,
        errors,
        controller: window.nvUploadFixture.createUploadController({
          root: document,
          window,
          endpoint: '/up',
          component: (element) => {
            const owner = element.closest('[data-nv-component]');
            return owner
              ? { root: owner, name: 'docs', csrf: 'c'.repeat(32) }
              : undefined;
          },
          set: (_element, field, value) => sets.push({ field, value }),
          onError: (error) => errors.push(String(error)),
        }),
      };
    });
  });
  afterEach(async () => {
    await page.evaluate(() => window.nvUploadSession?.controller.dispose());
    await page.close();
  });
  afterAll(async () => {
    // Release any request still held by the cancellation fixture first.
    releaseSlow?.();
    await browser?.close();
    if (server)
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
  });

  it('validates owned markup and refuses unsafe placements', async () => {
    const results = await page.evaluate(() => {
      const check = (html: string, configured = true) => {
        const host = document.createElement('div');
        host.setAttribute('data-nv-component', '');
        host.innerHTML = html;
        document.body.append(host);
        try {
          window.nvUploadFixture.validateUploads(host, configured);
          return 'ok';
        } catch {
          return 'rejected';
        } finally {
          host.remove();
        }
      };
      return [
        check('<input type="file" nv:upload="a">'),
        check('<input type="file" nv:upload="a">', false),
        check('<input type="text" nv:upload="a">'),
        check(
          '<input type="file" nv:upload="a"><input type="file" nv:upload="a">',
        ),
        check('<input type="file" nv:upload="a" nv:model="a">'),
        check('<div nv:upload.progress="a"></div>'),
        check('<button nv:upload.cancel="a">x</button>'),
        check('<p nv:upload.status="a"><b>x</b></p>'),
        check('<input type="file" nv:upload="a" nv:upload.status="a">'),
      ];
    });
    expect(results).toEqual([
      'ok',
      'rejected',
      'rejected',
      'rejected',
      'rejected',
      'rejected',
      'rejected',
      'rejected',
      'rejected',
    ]);
  });

  it('uploads multiple files in verified chunks, reports progress and sets the field', async () => {
    await page.setInputFiles('#f', [
      {
        name: 'one.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('hello world'),
      },
      { name: 'two.txt', mimeType: 'text/plain', buffer: Buffer.from('abc') },
    ]);
    await page.waitForFunction(() => window.nvUploadSession.sets.length === 1);
    const state = await page.evaluate(() => ({
      sets: window.nvUploadSession.sets,
      status: document.querySelector('[role=status]')?.textContent,
      progress: (document.querySelector('progress') as HTMLProgressElement)
        .value,
      max: (document.querySelector('progress') as HTMLProgressElement).max,
      busy: document.querySelector('#f')?.getAttribute('aria-busy'),
    }));
    expect(state.sets[0]?.field).toBe('files');
    expect(state.sets[0]?.value.split(',')).toHaveLength(2);
    expect(state).toMatchObject({
      status: 'Uploaded 2 files',
      progress: 14,
      max: 14,
      busy: null,
    });
    expect(log.filter((entry) => entry.startsWith('PUT'))).toHaveLength(4);
    expect(
      log.every(
        (entry) => entry.includes('csrf=true') || entry.startsWith('digest'),
      ),
    ).toBe(true);
    expect(log.filter((entry) => entry === 'digest=sent')).toHaveLength(2);
  });

  it('resumes after a lost chunk reply by querying received bytes', async () => {
    await page.setInputFiles('#f', {
      name: 'flaky.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('0123456789ab'),
    });
    await page.waitForFunction(
      () => window.nvUploadSession.sets.length === 1,
      undefined,
      { timeout: 10_000 },
    );
    expect(log.some((entry) => entry.startsWith('GET /up/sessions/S'))).toBe(
      true,
    );
    // A resumed session cannot prove every chunk digest, so no combined digest is claimed.
    expect(log).toContain('digest=none');
    expect(await page.textContent('[role=status]')).toBe('Uploaded 1 file');
  });

  it('cancels an in-flight upload, discards the session and keeps the field unchanged', async () => {
    await page.setInputFiles('#f', {
      name: 'slow.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('0123456789'),
    });
    await expect
      .poll(() =>
        log.some((entry) => entry.startsWith('PUT /up/sessions/S/chunks/1')),
      )
      .toBe(true);
    await page.click('button');
    await expect
      .poll(() =>
        log.some((entry) => entry.startsWith('DELETE /up/sessions/S')),
      )
      .toBe(true);
    releaseSlow?.();
    expect(await page.textContent('[role=status]')).toBe('Upload cancelled');
    expect(await page.evaluate(() => window.nvUploadSession.sets)).toEqual([]);
    expect(await page.evaluate(() => window.nvUploadSession.errors)).toEqual(
      [],
    );
  });

  it('announces server rejections without setting the field', async () => {
    await page.setInputFiles('#f', {
      name: 'bad.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('x'),
    });
    await page.waitForFunction(
      () => window.nvUploadSession.errors.length === 1,
    );
    expect(await page.textContent('[role=status]')).toBe(
      'Upload failed: This file type is not allowed.',
    );
    expect(await page.getAttribute('#f', 'aria-invalid')).toBe('true');
    expect(await page.evaluate(() => window.nvUploadSession.sets)).toEqual([]);
  });

  it('removes completed unfinalized uploads when cancel is pressed afterwards', async () => {
    await page.setInputFiles('#f', {
      name: 'done.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('ok'),
    });
    await page.waitForFunction(() => window.nvUploadSession.sets.length === 1);
    await page.click('button');
    await page.waitForFunction(() => window.nvUploadSession.sets.length === 2);
    expect(await page.evaluate(() => window.nvUploadSession.sets[1])).toEqual({
      field: 'files',
      value: '',
    });
    await expect
      .poll(() =>
        log.some((entry) => entry.startsWith('DELETE /up/files/nvu_')),
      )
      .toBe(true);
  });
});
