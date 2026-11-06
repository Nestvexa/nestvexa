import 'reflect-metadata';
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Module,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { chromium } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  UploadsModule,
  UploadsService,
  configureUploads,
} from '../packages/uploads/dist/index.js';
import {
  BrowserUploadError,
  browserUploadMessage,
} from '../packages/uploads/dist/browser/index.js';

declare global {
  interface Window {
    nvUploads: typeof import('../packages/uploads/dist/browser/index.js');
  }
}

const browserEntry = join(
  import.meta.dirname,
  '../packages/uploads/dist/browser/index.js',
);

function cookie(request: object, name: string): string | undefined {
  const raw = Reflect.get(Reflect.get(request, 'headers') as object, 'cookie');
  if (typeof raw !== 'string') return undefined;
  return new RegExp(`(?:^|;\\s*)${name}=([A-Za-z0-9_-]+)`).exec(raw)?.[1];
}
const csrfFor = (user: string) => `csrf-${user}-`.padEnd(40, 'x');

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

let app: INestApplication;
let browser: Browser;
let page: Page;
let base: string;
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nestvexa-upload-browser-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const script = await readFile(browserEntry, 'utf8');

  @Controller()
  class PageController {
    constructor(
      @Inject(UploadsService) private readonly uploads: UploadsService,
    ) {}
    @Get()
    @Header('content-type', 'text/html; charset=utf-8')
    index() {
      return '<!doctype html><title>uploads</title><script type="module">import * as uploads from "/uploader.js"; window.nvUploads = uploads;</script>';
    }
    @Get('uploader.js')
    @Header('content-type', 'text/javascript; charset=utf-8')
    uploader() {
      return script;
    }
    /** Finalizes tokens like a form route would and reports what was stored. */
    @Post('finalize')
    @HttpCode(200)
    async finalize(@Req() request: object, @Body() body: { tokens: string[] }) {
      const results = [];
      for (const token of body.tokens)
        try {
          const file = await this.uploads.finalize(request, token, {
            purpose: 'documents',
          });
          results.push({ ok: true, size: file.size, sha256: file.sha256 });
        } catch (error) {
          results.push({
            ok: false,
            code: Reflect.get(error as object, 'code'),
          });
        }
      return results;
    }
  }
  @Module({
    imports: [
      UploadsModule.register({
        origin: base,
        directory,
        chunkSize: 16 * 1024,
        sweepIntervalMs: 60_000,
        quotas: { requestsPerMinute: 10_000 },
        resolveIdentity(request: object) {
          const user = cookie(request, 'user');
          if (!user) throw new UnauthorizedException();
          return {
            binding: `test-user:${user}:binding`,
            csrfToken: csrfFor(user),
          };
        },
        authorize: () => true,
        purposes: {
          documents: {
            types: ['txt', 'png'],
            maxFileSize: 512 * 1024,
            maxFiles: 2,
          },
        },
      }),
    ],
    controllers: [PageController],
  })
  class AppModule {}
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await configureUploads(app);
  await app.listen(port, '127.0.0.1');
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
});

async function openPage(user: string): Promise<Page> {
  const context = await browser.newContext();
  await context.addCookies([{ name: 'user', value: user, url: base }]);
  const opened = await context.newPage();
  await opened.goto(base);
  await opened.waitForFunction(() => window.nvUploads !== undefined);
  return opened;
}

interface Outcome {
  readonly tokens?: readonly string[] | undefined;
  readonly code?: string | undefined;
  readonly name?: string | undefined;
  readonly progress: {
    loaded: number;
    total: number;
    percentage: number;
    file: number;
  }[];
}

/** Runs `uploadFiles` in the page with generated files. */
function run(
  target: Page,
  files: {
    name: string;
    type: string;
    text?: string;
    size?: number;
    png?: boolean;
  }[],
  options: {
    purpose?: string;
    endpoint?: string;
    csrf?: string;
    abortAfterBytes?: number;
  } = {},
): Promise<Outcome> {
  return target.evaluate(
    async ({ files, options, csrf }) => {
      const progress: Outcome['progress'] = [];
      const controller = new AbortController();
      const made = files.map((spec) => {
        let body: BlobPart;
        if (spec.png)
          body = new Uint8Array([
            0x89,
            0x50,
            0x4e,
            0x47,
            0x0d,
            0x0a,
            0x1a,
            0x0a,
            ...new TextEncoder().encode('fake-png-body-for-tests'),
          ]);
        else body = spec.text ?? 'a'.repeat(spec.size ?? 10);
        return new File([body], spec.name, { type: spec.type });
      });
      try {
        const tokens = await window.nvUploads.uploadFiles(made, {
          purpose: options.purpose ?? 'documents',
          ...(options.endpoint === undefined
            ? {}
            : { endpoint: options.endpoint }),
          csrf: () => options.csrf ?? csrf,
          signal: controller.signal,
          onProgress: (event) => {
            progress.push({ ...event });
            if (
              options.abortAfterBytes !== undefined &&
              event.loaded >= options.abortAfterBytes
            )
              controller.abort();
          },
        });
        return { tokens: [...tokens], progress };
      } catch (error) {
        return {
          code: (error as { code?: string }).code,
          name: (error as Error).name,
          progress,
        };
      }
    },
    { files, options, csrf: csrfFor('alice') },
  );
}

function finalize(target: Page, tokens: readonly string[]) {
  return target.evaluate(async (tokens) => {
    const response = await fetch('/finalize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tokens }),
    });
    return (await response.json()) as {
      ok: boolean;
      size?: number;
      sha256?: string;
      code?: string;
    }[];
  }, tokens);
}

describe(
  '@nestvexa/uploads/browser against a real UploadsModule',
  { timeout: 60_000 },
  () => {
    beforeAll(async () => {
      page = await openPage('alice');
    });

    it('uploads several files in chunks with monotonic progress and finalizable tokens', async () => {
      const text = 'nestvexa '.repeat(5000); // 45 000 bytes -> 3 chunks of 16 KiB
      const outcome = await run(page, [
        { name: 'notes.txt', type: 'text/plain', text },
        { name: 'pixel.png', type: 'image/png', png: true },
      ]);
      expect(outcome.code).toBeUndefined();
      expect(outcome.tokens).toHaveLength(2);
      for (const token of outcome.tokens ?? [])
        expect(token).toMatch(/^nvu_[A-Za-z0-9_-]{43}$/);
      const loaded = outcome.progress.map((event) => event.loaded);
      expect(loaded).toEqual([...loaded].sort((a, b) => a - b));
      expect(outcome.progress.at(-1)).toMatchObject({
        loaded: text.length + 31,
        total: text.length + 31,
        percentage: 100,
      });
      expect(outcome.progress.some((event) => event.file === 1)).toBe(true);
      const stored = await finalize(page, outcome.tokens ?? []);
      expect(stored[0]).toEqual({
        ok: true,
        size: text.length,
        sha256: createHash('sha256').update(text).digest('hex'),
      });
      expect(stored[1]).toMatchObject({ ok: true, size: 31 });
      // Single use: the same tokens cannot be finalized twice.
      expect(
        (await finalize(page, outcome.tokens ?? [])).map((r) => r.ok),
      ).toEqual([false, false]);
    });

    it('reports the server code and discards earlier files of a failed batch', async () => {
      const outcome = await run(page, [
        { name: 'ok.txt', type: 'text/plain', text: 'fine' },
        { name: 'report.pdf', type: 'application/pdf', text: '%PDF-1.7' },
      ]);
      expect(outcome.name).toBe('BrowserUploadError');
      expect(outcome.code).toMatch(
        /^(?:TYPE_NOT_ALLOWED|EXTENSION_NOT_ALLOWED)$/,
      );
      // Quota (maxFiles 2 pending) is free again: the first token was discarded.
      await expect
        .poll(async () => {
          const again = await run(page, [
            { name: 'a.txt', type: 'text/plain', text: 'one' },
            { name: 'b.txt', type: 'text/plain', text: 'two' },
          ]);
          if (again.tokens) await finalize(page, again.tokens);
          return again.tokens?.length ?? again.code;
        })
        .toBe(2);
    });

    it('aborts through the signal and releases the server session', async () => {
      const outcome = await run(
        page,
        [{ name: 'big.txt', type: 'text/plain', size: 300 * 1024 }],
        { abortAfterBytes: 1 },
      );
      expect(outcome.code).toBe('ABORTED');
      await expect
        .poll(async () => {
          const again = await run(page, [
            { name: 'a.txt', type: 'text/plain', text: 'one' },
            { name: 'b.txt', type: 'text/plain', text: 'two' },
          ]);
          if (again.tokens) await finalize(page, again.tokens);
          return again.tokens?.length ?? again.code;
        })
        .toBe(2);
    });

    it('refuses a wrong CSRF token, unknown purposes and unsafe endpoints', async () => {
      const wrongCsrf = await run(
        page,
        [{ name: 'a.txt', type: 'text/plain' }],
        {
          csrf: csrfFor('mallory'),
        },
      );
      expect(wrongCsrf.code).toBe('CSRF_REJECTED');
      const unknown = await run(page, [{ name: 'a.txt', type: 'text/plain' }], {
        purpose: 'secrets',
      });
      expect(unknown.code).toMatch(/^[A-Z_]+$/);
      expect(unknown.tokens).toBeUndefined();
      const requests: string[] = [];
      page.on('request', (request) => requests.push(request.url()));
      for (const options of [
        { endpoint: 'https://evil.example/uploads' },
        { endpoint: '//evil.example/uploads' },
        { endpoint: '/a/../b' },
        { purpose: '../escape' },
        { purpose: 'a.b.c' },
      ]) {
        const refused = await run(
          page,
          [{ name: 'a.txt', type: 'text/plain' }],
          options,
        );
        expect(refused.code).toBe('INVALID_OPTIONS');
      }
      expect(requests.filter((url) => !url.endsWith('/favicon.ico'))).toEqual(
        [],
      );
    });

    it('keeps another identity away from the tokens', async () => {
      const outcome = await run(page, [
        { name: 'mine.txt', type: 'text/plain' },
      ]);
      const other = await openPage('bob');
      const stolen = await finalize(other, outcome.tokens ?? []);
      expect(stolen).toEqual([{ ok: false, code: 'UPLOAD_NOT_FOUND' }]);
      expect((await finalize(page, outcome.tokens ?? []))[0]?.ok).toBe(true);
      await other.context().close();
    });
  },
);

describe('browser upload messages', () => {
  it('maps codes to closed messages', () => {
    expect(browserUploadMessage(new BrowserUploadError('FILE_TOO_LARGE'))).toBe(
      'The file is too large.',
    );
    expect(browserUploadMessage(new BrowserUploadError('HTTP_500'))).toBe(
      'Please try again.',
    );
    expect(browserUploadMessage(new Error('x'))).toBe('Please try again.');
    expect(new BrowserUploadError('ABORTED').message).toBe(
      'Upload failed (ABORTED)',
    );
  });
});
