import 'reflect-metadata';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  UploadError,
  UploadsModule,
  UploadsService,
  configureUploads,
} from '../packages/uploads/dist/index.js';
import type { FinalizedUpload } from '../packages/uploads/dist/index.js';
import {
  ORIGIN,
  PDF,
  PNG,
  csrfFor,
  identity,
  json,
  multipart,
  rawUpload,
  send,
  sha256,
} from './support/uploads-http.js';

const CHUNK = 16 * 1024;

function header(request: object, name: string): string | undefined {
  const value: unknown = Reflect.get(
    Reflect.get(request, 'headers') as object,
    name,
  );
  return typeof value === 'string' ? value : undefined;
}

async function eventually(
  check: () => boolean | Promise<boolean>,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(await check()).toBe(true);
}
async function partFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).filter((name) => name.endsWith('.part'));
  } catch {
    return [];
  }
}

for (const platform of ['express', 'fastify'] as const)
  describe(`uploads over real ${platform} HTTP`, () => {
    let app: INestApplication;
    let base: string;
    let directory: string;
    let service: InstanceType<typeof UploadsService>;
    const finalized = new Map<string, FinalizedUpload>();

    beforeAll(async () => {
      directory = await mkdtemp(
        join(tmpdir(), `nestvexa-uploads-${platform}-`),
      );
      @Controller('host')
      class HostController {
        constructor(
          @Inject(UploadsService) private readonly uploads: UploadsService,
        ) {}
        @Post('finalize')
        @HttpCode(200)
        async finalize(
          @Req() request: object,
          @Body() body: { token: string; purpose: string },
        ) {
          const file = await this.uploads.finalize(request, body.token, {
            purpose: body.purpose,
          });
          finalized.set(file.key, file);
          return file;
        }
        @Get('download/:shard/:name')
        async download(
          @Req() request: object,
          @Res() response: object,
          @Param('shard') shard: string,
          @Param('name') name: string,
        ) {
          const file = finalized.get(`${shard}/${name}`);
          if (!file) throw new UnauthorizedException();
          await this.uploads.download(request, response, file);
        }
        @Post('form')
        async form(
          @Req() request: object,
          @Res({ passthrough: true }) response: object,
        ) {
          const result = await this.uploads.receiveForm(
            request,
            { purpose: 'docs' },
            response,
          );
          const files = [];
          for (const file of result.files)
            files.push(
              await this.uploads.finalize(request, file.token, {
                purpose: 'docs',
              }),
            );
          return { fields: result.fields, files };
        }
      }
      @Module({
        imports: [
          UploadsModule.register({
            origin: ORIGIN,
            directory,
            chunkSize: CHUNK,
            idleTimeoutMs: 400,
            sweepIntervalMs: 60_000,
            quotas: { identityBytes: 1024 * 1024, requestsPerMinute: 10_000 },
            resolveIdentity(request: object) {
              const user = header(request, 'x-test-user');
              if (!user) throw new UnauthorizedException();
              const tenant = header(request, 'x-test-tenant');
              return {
                binding: `test-user:${user}:binding`,
                csrfToken: csrfFor(user),
                ...(tenant === undefined ? {} : { tenant }),
              };
            },
            authorize: (_identity, purpose) => purpose !== 'restricted',
            purposes: {
              images: {
                types: ['png', 'jpeg', 'gif', 'webp'],
                maxFileSize: 64 * 1024,
                maxFiles: 3,
              },
              docs: {
                types: ['pdf', 'txt', 'csv', 'png'],
                maxFileSize: 128 * 1024,
                maxFiles: 3,
              },
              notes: { types: ['txt'], maxFileSize: 1024, allowEmpty: true },
              big: {
                types: ['png', 'pdf'],
                maxFileSize: 900 * 1024,
                maxFiles: 5,
              },
              restricted: { types: ['png'], maxFileSize: 1024 },
            },
          }),
        ],
        controllers: [HostController],
      })
      class AppModule {}
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app =
        platform === 'fastify'
          ? moduleRef.createNestApplication(new FastifyAdapter())
          : moduleRef.createNestApplication();
      await configureUploads(app);
      await app.listen(0, '127.0.0.1');
      base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
      service = app.get(UploadsService);
    });
    afterAll(async () => {
      await app?.close();
      await rm(directory, { recursive: true, force: true });
    });

    /** Invariant: every pending local upload/session owns exactly one temporary file. */
    async function noLeaks(): Promise<void> {
      await eventually(
        async () =>
          (await partFiles(service.temporaryDirectory)).length ===
          service.pendingCount,
      );
    }
    async function upload(
      user: string,
      purpose: string,
      name: string,
      body: Buffer,
    ) {
      const reply = await rawUpload(base, user, purpose, name, body);
      return reply;
    }
    async function finalize(user: string, token: string, purpose: string) {
      return json(base, 'POST', '/host/finalize', user, { token, purpose });
    }

    it('uploads, finalizes once and downloads with safe headers and ranges', async () => {
      const reply = await upload('alice', 'images', 'Photo.PNG', PNG);
      expect(reply.status).toBe(201);
      const receipt = reply.json();
      expect(receipt).toMatchObject({
        purpose: 'images',
        name: 'Photo.PNG',
        size: PNG.byteLength,
        contentType: 'image/png',
      });
      expect(String(receipt['token'])).toMatch(/^nvu_[A-Za-z0-9_-]{43}$/);
      expect(reply.headers['cache-control']).toBe('no-store');
      const done = await finalize('alice', String(receipt['token']), 'images');
      expect(done.status).toBe(200);
      const file = done.json();
      expect(file).toMatchObject({
        contentType: 'image/png',
        size: PNG.byteLength,
        sha256: sha256(PNG),
        scan: 'not-configured',
        storage: 'local',
      });
      expect(String(file['key'])).toMatch(
        /^[A-Za-z0-9_-]{2}\/[A-Za-z0-9_-]{43}$/,
      );
      // Stored outside any webroot under the configured private directory.
      expect(
        existsSync(
          join(directory, 'objects', ...String(file['key']).split('/')),
        ),
      ).toBe(true);
      await noLeaks();

      const again = await finalize('alice', String(receipt['token']), 'images');
      expect(again.status).toBe(409);
      expect(again.json()['code']).toBe('UPLOAD_ALREADY_FINALIZED');

      const path = `/host/download/${String(file['key'])}`;
      const full = await send(base, 'GET', path);
      expect(full.status).toBe(200);
      expect(full.body.equals(PNG)).toBe(true);
      expect(full.headers['content-type']).toBe('image/png');
      expect(full.headers['x-content-type-options']).toBe('nosniff');
      expect(full.headers['content-disposition']).toBe(
        `attachment; filename="Photo.PNG"; filename*=UTF-8''Photo.PNG`,
      );
      expect(full.headers['content-security-policy']).toContain('sandbox');
      expect(full.headers['accept-ranges']).toBe('bytes');
      const first = await send(base, 'GET', path, {
        headers: { range: 'bytes=0-3' },
      });
      expect(first.status).toBe(206);
      expect(first.headers['content-range']).toBe(
        `bytes 0-3/${PNG.byteLength}`,
      );
      expect(first.body.equals(PNG.subarray(0, 4))).toBe(true);
      const suffix = await send(base, 'GET', path, {
        headers: { range: 'bytes=-5' },
      });
      expect(suffix.status).toBe(206);
      expect(suffix.body.equals(PNG.subarray(-5))).toBe(true);
      const open = await send(base, 'GET', path, {
        headers: { range: `bytes=${PNG.byteLength - 2}-` },
      });
      expect(open.body.equals(PNG.subarray(-2))).toBe(true);
      const clamp = await send(base, 'GET', path, {
        headers: { range: 'bytes=4-999999' },
      });
      expect(clamp.status).toBe(206);
      expect(clamp.headers['content-range']).toBe(
        `bytes 4-${PNG.byteLength - 1}/${PNG.byteLength}`,
      );
      const beyond = await send(base, 'GET', path, {
        headers: { range: `bytes=${PNG.byteLength}-` },
      });
      expect(beyond.status).toBe(416);
      expect(beyond.headers['content-range']).toBe(`bytes */${PNG.byteLength}`);
      expect(
        (await send(base, 'GET', path, { headers: { range: 'bytes=-0' } }))
          .status,
      ).toBe(416);
      for (const ignored of [
        'bytes=0-1,4-5',
        'bytes=5-2',
        'items=0-1',
        'bytes=x-y',
      ])
        expect(
          (await send(base, 'GET', path, { headers: { range: ignored } }))
            .status,
        ).toBe(200);
      const etag = full.headers['etag'];
      expect(etag).toMatch(/^"[a-f0-9]{32}"$/);
      expect(
        (
          await send(base, 'GET', path, {
            headers: { range: 'bytes=0-1', 'if-range': '"stale"' },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await send(base, 'GET', path, {
            headers: { range: 'bytes=0-1', 'if-range': String(etag) },
          })
        ).status,
      ).toBe(206);
      expect(
        (
          await send(base, 'GET', path, {
            headers: { 'if-none-match': String(etag) },
          })
        ).status,
      ).toBe(304);
    });

    it('preserves unicode names in RFC 5987 Content-Disposition and refuses spoofing names', async () => {
      const name = 'تقرير الربع.pdf';
      const reply = await upload('uni', 'docs', name, PDF);
      expect(reply.status).toBe(201);
      const file = (
        await finalize('uni', String(reply.json()['token']), 'docs')
      ).json();
      const download = await send(
        base,
        'GET',
        `/host/download/${String(file['key'])}`,
      );
      expect(download.headers['content-disposition']).toBe(
        `attachment; filename="_____ _____.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`,
      );
      for (const bad of [
        'x\u202Egnp.exe.png',
        'bad\u0000.png',
        'a\r\n.png',
        'zero\u200bwidth.png',
        '.hidden.png',
        'trailing.png.',
        ' space.png',
      ])
        expect((await upload('uni', 'images', bad, PNG)).json()['code']).toBe(
          'INVALID_FILENAME',
        );
    });

    it('refuses traversal, double extensions, missing extensions and disallowed types', async () => {
      for (const name of [
        '../../etc/passwd.png',
        '..\\..\\boot.png',
        'a/b.png',
        'C:\\Users\\x.png',
        'stream.png:evil',
      ])
        expect((await upload('bob', 'images', name, PNG)).json()['code']).toBe(
          'INVALID_FILENAME',
        );
      expect(
        (await upload('bob', 'images', 'shell.php.png', PNG)).json()['code'],
      ).toBe('DANGEROUS_EXTENSION');
      expect(
        (await upload('bob', 'images', 'invoice.pdf.exe', PNG)).json()['code'],
      ).toBe('DANGEROUS_EXTENSION');
      expect(
        (await upload('bob', 'images', 'icon.svg', PNG)).json()['code'],
      ).toBe('DANGEROUS_EXTENSION');
      expect(
        (await upload('bob', 'images', 'page.html', PNG)).json()['code'],
      ).toBe('DANGEROUS_EXTENSION');
      expect(
        (await upload('bob', 'images', 'README', PNG)).json()['code'],
      ).toBe('MISSING_EXTENSION');
      const pdf = await upload('bob', 'images', 'doc.pdf', PDF);
      expect(pdf.status).toBe(415);
      expect(pdf.json()['code']).toBe('TYPE_NOT_ALLOWED');
      await noLeaks();
    });

    it('checks declared MIME and magic bytes and denies executables or markup', async () => {
      const spoofed = await upload('carol', 'images', 'cat.png', PDF);
      expect(spoofed.status).toBe(415);
      expect(spoofed.json()['code']).toBe('CONTENT_MISMATCH');
      const declared = await rawUpload(
        base,
        'carol',
        'docs',
        'paper.pdf',
        PDF,
        { 'x-nestvexa-upload-type': 'image/png' },
      );
      expect(declared.json()['code']).toBe('MIME_MISMATCH');
      const compatible = await rawUpload(
        base,
        'carol',
        'docs',
        'paper.pdf',
        PDF,
        { 'x-nestvexa-upload-type': 'application/pdf' },
      );
      expect(compatible.status).toBe(201);
      const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 1)]);
      expect(
        (await upload('carol', 'images', 'setup.png', exe)).json()['code'],
      ).toBe('DANGEROUS_CONTENT');
      const html = Buffer.from(
        '\uFEFF  <!DOCTYPE html><script>alert(1)</script>',
      );
      expect(
        (await upload('carol', 'docs', 'notes.txt', html)).json()['code'],
      ).toBe('DANGEROUS_CONTENT');
      const svg = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
      );
      expect(
        (await upload('carol', 'docs', 'chart.csv', svg)).json()['code'],
      ).toBe('DANGEROUS_CONTENT');
      const binaryText = Buffer.from([0x61, 0x00, 0x62]);
      expect(
        (await upload('carol', 'docs', 'data.txt', binaryText)).json()['code'],
      ).toBe('CONTENT_MISMATCH');
      const invalidUtf8 = Buffer.from([0x61, 0xc3, 0x28]);
      expect(
        (await upload('carol', 'docs', 'data.csv', invalidUtf8)).json()['code'],
      ).toBe('CONTENT_MISMATCH');
      const pngAsText = await upload('carol', 'docs', 'image.txt', PNG);
      expect(pngAsText.json()['code']).toBe('CONTENT_MISMATCH');
      const csv = await upload(
        'carol',
        'docs',
        'people.csv',
        Buffer.from('name,city\nÅsa,Malmö\n'),
      );
      expect(csv.status).toBe(201);
      await noLeaks();
    });

    it('handles 0-byte uploads, length requirements, content coding and oversize bodies', async () => {
      const empty = await upload(
        'dave',
        'images',
        'empty.png',
        Buffer.alloc(0),
      );
      expect(empty.status).toBe(422);
      expect(empty.json()['code']).toBe('EMPTY_FILE');
      const emptyNote = await upload(
        'dave',
        'notes',
        'empty.txt',
        Buffer.alloc(0),
      );
      expect(emptyNote.status).toBe(201);
      expect(emptyNote.json()['size']).toBe(0);
      expect(
        (
          await finalize('dave', String(emptyNote.json()['token']), 'notes')
        ).json()['size'],
      ).toBe(0);
      // Declared oversize is refused before reading any body bytes.
      const oversized = await send(base, 'POST', '/_nestvexa/uploads/files', {
        headers: {
          ...identity('dave'),
          'content-type': 'application/octet-stream',
          'content-length': String(10 * 1024 * 1024 * 1024),
          'x-nestvexa-upload-purpose': 'images',
          'x-nestvexa-upload-name': 'huge.png',
        },
        parts: [PNG],
        abortAfterParts: true,
      });
      expect([413, -1]).toContain(oversized.status);
      if (oversized.status === 413)
        expect(oversized.json()['code']).toBe('FILE_TOO_LARGE');
      const chunked = await send(base, 'POST', '/_nestvexa/uploads/files', {
        headers: {
          ...identity('dave'),
          'content-type': 'application/octet-stream',
          'transfer-encoding': 'chunked',
          'x-nestvexa-upload-purpose': 'images',
          'x-nestvexa-upload-name': 'stream.png',
        },
        // A complete (empty) chunked body keeps the connection readable for the 411.
        body: '',
      });
      expect(chunked.status).toBe(411);
      expect(chunked.json()['code']).toBe('LENGTH_REQUIRED');
      const gzip = await rawUpload(base, 'dave', 'images', 'packed.png', PNG, {
        'content-encoding': 'gzip',
      });
      expect(gzip.status).toBe(415);
      expect(gzip.json()['code']).toBe('CONTENT_ENCODING');
      // Fastify itself refuses unregistered media types; Express reaches the upload check.
      const form = await rawUpload(base, 'dave', 'images', 'x.png', PNG, {
        'content-type': 'image/png',
      });
      expect(form.status).toBe(415);
      await noLeaks();
    });

    it('rejects missing CSRF, foreign origins, unknown or forbidden purposes and other identities', async () => {
      const noCsrf = await send(base, 'POST', '/_nestvexa/uploads/files', {
        headers: {
          'x-test-user': 'erin',
          origin: ORIGIN,
          'content-type': 'application/octet-stream',
          'content-length': String(PNG.byteLength),
          'x-nestvexa-upload-purpose': 'images',
          'x-nestvexa-upload-name': 'a.png',
        },
        body: PNG,
      });
      expect(noCsrf.status).toBe(403);
      expect(noCsrf.json()['code']).toBe('CSRF_REJECTED');
      const foreign = await rawUpload(base, 'erin', 'images', 'a.png', PNG, {
        origin: 'https://evil.example',
      });
      expect(foreign.json()['code']).toBe('ORIGIN_REJECTED');
      const anonymous = await send(base, 'POST', '/_nestvexa/uploads/files', {
        headers: {
          origin: ORIGIN,
          'content-type': 'application/octet-stream',
          'content-length': '1',
        },
        body: 'x',
      });
      expect(anonymous.status).toBe(401);
      expect((await upload('erin', 'nope', 'a.png', PNG)).json()['code']).toBe(
        'UNKNOWN_PURPOSE',
      );
      expect(
        (await upload('erin', 'restricted', 'a.png', PNG)).json()['code'],
      ).toBe('UPLOAD_FORBIDDEN');
      const reply = await upload('erin', 'images', 'mine.png', PNG);
      const token = String(reply.json()['token']);
      // Replay by another identity: indistinguishable from a missing token.
      const replay = await finalize('mallory', token, 'images');
      expect(replay.status).toBe(404);
      expect(replay.json()['code']).toBe('UPLOAD_NOT_FOUND');
      const tenantSwap = await send(base, 'POST', '/host/finalize', {
        headers: {
          ...identity('erin', 'other-tenant'),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ token, purpose: 'images' }),
      });
      expect(tenantSwap.status).toBe(404);
      const wrongPurpose = await finalize('erin', token, 'docs');
      expect(wrongPurpose.status).toBe(403);
      expect(wrongPurpose.json()['code']).toBe('PURPOSE_MISMATCH');
      const malformed = await finalize('erin', 'nvu_short', 'images');
      expect(malformed.json()['code']).toBe('INVALID_UPLOAD_TOKEN');
      // The rightful owner can still finalize after the failed attempts.
      expect((await finalize('erin', token, 'images')).status).toBe(200);
    });

    it('expires temporary tokens and sweeps their files', async () => {
      const reply = await upload('frank', 'images', 'old.png', PNG);
      const token = String(reply.json()['token']);
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 16 * 60_000);
      try {
        const expired = await finalize('frank', token, 'images');
        expect(expired.status).toBe(410);
        expect(expired.json()['code']).toBe('UPLOAD_EXPIRED');
      } finally {
        clock.mockRestore();
      }
      const second = await upload('frank', 'images', 'old2.png', PNG);
      expect(second.status).toBe(201);
      expect(service.pendingCount).toBeGreaterThanOrEqual(1);
      expect(
        await service.sweep(Date.now() + 16 * 60_000),
      ).toBeGreaterThanOrEqual(1);
      expect(service.pendingCount).toBe(0);
      expect(await partFiles(service.temporaryDirectory)).toHaveLength(0);
      expect(
        (await finalize('frank', String(second.json()['token']), 'images'))
          .status,
      ).toBe(404);
    });

    it('enforces per-purpose counts and per-identity byte quotas, released by cancellation', async () => {
      const tokens: string[] = [];
      for (let index = 0; index < 3; index++) {
        const reply = await upload('gina', 'images', `p${index}.png`, PNG);
        expect(reply.status).toBe(201);
        tokens.push(String(reply.json()['token']));
      }
      const fourth = await upload('gina', 'images', 'p4.png', PNG);
      expect(fourth.status).toBe(429);
      expect(fourth.json()['code']).toBe('TOO_MANY_FILES');
      const cancelled = await json(
        base,
        'DELETE',
        `/_nestvexa/uploads/files/${tokens[0]}`,
        'gina',
      );
      expect(cancelled.status).toBe(204);
      expect((await finalize('gina', String(tokens[0]), 'images')).status).toBe(
        404,
      );
      expect((await upload('gina', 'images', 'p5.png', PNG)).status).toBe(201);
      // Byte quota: 1 MiB per identity across purposes.
      const big = Buffer.concat([PDF, Buffer.alloc(600 * 1024, 0x20)]);
      const one = await upload('hank', 'big', 'one.pdf', big);
      expect(one.status).toBe(201);
      const two = await upload('hank', 'big', 'two.pdf', big);
      expect(two.status).toBe(429);
      expect(two.json()['code']).toBe('QUOTA_EXCEEDED');
      await json(
        base,
        'DELETE',
        `/_nestvexa/uploads/files/${String(one.json()['token'])}`,
        'hank',
      );
      expect((await upload('hank', 'big', 'two.pdf', big)).status).toBe(201);
    });

    it('runs chunked sessions with order, offset, digest and resume checks', async () => {
      const data = Buffer.concat([PDF, Buffer.alloc(CHUNK * 2 + 1234, 0x41)]);
      const chunks = [0, 1, 2].map((index) =>
        data.subarray(index * CHUNK, (index + 1) * CHUNK),
      );
      const created = await json(
        base,
        'POST',
        '/_nestvexa/uploads/sessions',
        'ivy',
        {
          purpose: 'docs',
          name: 'large.pdf',
          type: 'application/pdf',
          size: data.byteLength,
        },
      );
      expect(created.status).toBe(201);
      const session = created.json();
      expect(session).toMatchObject({
        mode: 'chunked',
        chunkSize: CHUNK,
        received: 0,
        nextIndex: 0,
      });
      const id = String(session['session']);
      const put = (
        index: number,
        body: Buffer,
        offset = index * CHUNK,
        hash?: string,
      ) =>
        send(base, 'PUT', `/_nestvexa/uploads/sessions/${id}/chunks/${index}`, {
          headers: {
            ...identity('ivy'),
            'content-type': 'application/octet-stream',
            'content-length': String(body.byteLength),
            'x-nestvexa-chunk-offset': String(offset),
            ...(hash === undefined ? {} : { 'x-nestvexa-chunk-sha256': hash }),
          },
          body,
        });
      const chunk0 = chunks[0] ?? Buffer.alloc(0);
      const chunk1 = chunks[1] ?? Buffer.alloc(0);
      const chunk2 = chunks[2] ?? Buffer.alloc(0);
      expect((await put(1, chunk1)).json()['code']).toBe('CHUNK_OUT_OF_ORDER');
      expect((await put(0, chunk0, 5)).json()['code']).toBe('CHUNK_OFFSET');
      expect((await put(0, chunk0.subarray(1))).json()['code']).toBe(
        'CHUNK_SIZE',
      );
      expect((await put(0, chunk0, 0, sha256(chunk1))).json()['code']).toBe(
        'CHUNK_DIGEST',
      );
      expect(
        (
          await json(base, 'GET', `/_nestvexa/uploads/sessions/${id}`, 'ivy')
        ).json()['received'],
      ).toBe(0);
      const ok0 = await put(0, chunk0, 0, sha256(chunk0));
      expect(ok0.status).toBe(200);
      expect(ok0.json()).toMatchObject({ received: CHUNK, nextIndex: 1 });
      expect((await put(0, chunk0, 0, sha256(chunk0))).json()['code']).toBe(
        'CHUNK_ALREADY_RECEIVED',
      );
      expect((await put(2, chunk2)).json()['code']).toBe('CHUNK_OUT_OF_ORDER');
      // Other identities cannot see or extend the session.
      expect(
        (
          await json(
            base,
            'GET',
            `/_nestvexa/uploads/sessions/${id}`,
            'mallory',
          )
        ).status,
      ).toBe(404);
      // Interrupted chunk: partial bytes are discarded and the session resumes.
      const interrupted = await send(
        base,
        'PUT',
        `/_nestvexa/uploads/sessions/${id}/chunks/1`,
        {
          headers: {
            ...identity('ivy'),
            'content-type': 'application/octet-stream',
            'content-length': String(chunk1.byteLength),
            'x-nestvexa-chunk-offset': String(CHUNK),
          },
          parts: [chunk1.subarray(0, 1000)],
          abortAfterParts: true,
        },
      );
      expect(interrupted.status).toBe(-1);
      await eventually(async () => {
        const status = await json(
          base,
          'GET',
          `/_nestvexa/uploads/sessions/${id}`,
          'ivy',
        );
        return status.json()['received'] === CHUNK;
      });
      // Once the server has observed the disconnect the session is idle again.
      await eventually(async () => {
        const early = await json(
          base,
          'POST',
          `/_nestvexa/uploads/sessions/${id}/complete`,
          'ivy',
          {},
        );
        return early.json()['code'] === 'UPLOAD_INCOMPLETE';
      });
      expect((await put(1, chunk1, CHUNK, sha256(chunk1))).status).toBe(200);
      expect(
        (await put(2, chunk2, 2 * CHUNK, sha256(chunk2))).json(),
      ).toMatchObject({ received: data.byteLength });
      const wrong = await json(
        base,
        'POST',
        `/_nestvexa/uploads/sessions/${id}/complete`,
        'ivy',
        { digest: sha256(data) },
      );
      expect(wrong.json()['code']).toBe('DIGEST_MISMATCH');
      const combined = sha256(
        Buffer.concat(chunks.map((chunk) => Buffer.from(sha256(chunk), 'hex'))),
      );
      const completed = await json(
        base,
        'POST',
        `/_nestvexa/uploads/sessions/${id}/complete`,
        'ivy',
        { digest: combined },
      );
      expect(completed.status).toBe(200);
      const receipt = completed.json();
      expect(receipt).toMatchObject({
        size: data.byteLength,
        contentType: 'application/pdf',
      });
      // The session id is single use.
      expect(
        (await json(base, 'GET', `/_nestvexa/uploads/sessions/${id}`, 'ivy'))
          .status,
      ).toBe(404);
      const file = (
        await finalize('ivy', String(receipt['token']), 'docs')
      ).json();
      expect(file['sha256']).toBe(sha256(data));
      const download = await send(
        base,
        'GET',
        `/host/download/${String(file['key'])}`,
        {
          headers: { range: `bytes=${CHUNK - 2}-${CHUNK + 1}` },
        },
      );
      expect(download.status).toBe(206);
      expect(download.body.equals(data.subarray(CHUNK - 2, CHUNK + 2))).toBe(
        true,
      );
    });

    it('rejects declared-versus-actual size abuse and cancels sessions', async () => {
      const tooBig = await json(
        base,
        'POST',
        '/_nestvexa/uploads/sessions',
        'jack',
        {
          purpose: 'docs',
          name: 'bomb.pdf',
          size: 50 * 1024 * 1024 * 1024,
        },
      );
      expect(tooBig.status).toBe(413);
      const extra = await json(
        base,
        'POST',
        '/_nestvexa/uploads/sessions',
        'jack',
        {
          purpose: 'docs',
          name: 'small.pdf',
          size: 10,
          userId: 'admin',
        },
      );
      expect(extra.json()['code']).toBe('INVALID_REQUEST');
      const created = await json(
        base,
        'POST',
        '/_nestvexa/uploads/sessions',
        'jack',
        { purpose: 'docs', name: 'small.pdf', size: 10 },
      );
      const id = String(created.json()['session']);
      const larger = Buffer.alloc(11, 0x25);
      const sent = await send(
        base,
        'PUT',
        `/_nestvexa/uploads/sessions/${id}/chunks/0`,
        {
          headers: {
            ...identity('jack'),
            'content-type': 'application/octet-stream',
            'content-length': String(larger.byteLength),
            'x-nestvexa-chunk-offset': '0',
          },
          body: larger,
        },
      );
      expect([400, -1]).toContain(sent.status);
      if (sent.status === 400) expect(sent.json()['code']).toBe('CHUNK_SIZE');
      const cancelled = await json(
        base,
        'DELETE',
        `/_nestvexa/uploads/sessions/${id}`,
        'jack',
      );
      expect(cancelled.status).toBe(204);
      expect(
        (await json(base, 'GET', `/_nestvexa/uploads/sessions/${id}`, 'jack'))
          .status,
      ).toBe(404);
      await noLeaks();
    });

    it('cleans up interrupted and stalled single uploads', async () => {
      const before = service.pendingCount;
      const body = Buffer.concat([PNG, Buffer.alloc(30_000, 1)]);
      const interrupted = await send(base, 'POST', '/_nestvexa/uploads/files', {
        headers: {
          ...identity('kate'),
          'content-type': 'application/octet-stream',
          'content-length': String(body.byteLength),
          'x-nestvexa-upload-purpose': 'images',
          'x-nestvexa-upload-name': 'cut.png',
        },
        parts: [body.subarray(0, 10_000)],
        abortAfterParts: true,
      });
      expect(interrupted.status).toBe(-1);
      await eventually(() => service.pendingCount === before);
      await noLeaks();
      // Slow client: no bytes for longer than idleTimeoutMs.
      const stalled = await send(base, 'POST', '/_nestvexa/uploads/files', {
        headers: {
          ...identity('kate'),
          'content-type': 'application/octet-stream',
          'content-length': String(body.byteLength),
          'x-nestvexa-upload-purpose': 'images',
          'x-nestvexa-upload-name': 'slow.png',
        },
        parts: [body.subarray(0, 100)],
        partDelayMs: 1500,
      });
      expect([408, -1]).toContain(stalled.status);
      await eventually(() => service.pendingCount === before);
      await noLeaks();
    });

    it('accepts the no-JavaScript multipart form with CSRF first and refuses abuse', async () => {
      const good = multipart([
        { name: '_csrf', value: csrfFor('liam') },
        { name: 'title', value: 'Quarterly' },
        {
          name: 'files',
          filename: 'report.pdf',
          type: 'application/pdf',
          data: PDF,
        },
        { name: 'files', filename: 'logo.png', type: 'image/png', data: PNG },
        {
          name: 'files',
          filename: '',
          type: 'application/octet-stream',
          data: Buffer.alloc(0),
        },
      ]);
      const post = (
        form: { boundary: string; body: Buffer },
        user = 'liam',
        extra: Record<string, string> = {},
      ) =>
        send(base, 'POST', '/host/form', {
          headers: {
            'x-test-user': user,
            origin: ORIGIN,
            'content-type': `multipart/form-data; boundary=${form.boundary}`,
            'content-length': String(form.body.byteLength),
            ...extra,
          },
          body: form.body,
        });
      const ok = await post(good);
      expect(ok.status).toBe(201);
      const result = ok.json() as {
        fields: Record<string, string>;
        files: { name: string; sha256: string }[];
      };
      expect(result.fields).toEqual({ title: 'Quarterly' });
      expect(result.files.map((file) => file.name)).toEqual([
        'report.pdf',
        'logo.png',
      ]);
      expect(result.files[1]?.sha256).toBe(sha256(PNG));
      const noToken = multipart([
        {
          name: 'files',
          filename: 'a.pdf',
          type: 'application/pdf',
          data: PDF,
        },
      ]);
      expect((await post(noToken)).json()['code']).toBe('CSRF_REJECTED');
      const late = multipart([
        {
          name: 'files',
          filename: 'a.pdf',
          type: 'application/pdf',
          data: PDF,
        },
        { name: '_csrf', value: csrfFor('liam') },
      ]);
      expect((await post(late)).json()['code']).toBe('CSRF_REJECTED');
      const wrong = multipart([
        { name: '_csrf', value: csrfFor('other') },
        {
          name: 'files',
          filename: 'a.pdf',
          type: 'application/pdf',
          data: PDF,
        },
      ]);
      expect((await post(wrong)).json()['code']).toBe('CSRF_REJECTED');
      expect(
        (await post(good, 'liam', { origin: 'https://evil.example' })).json()[
          'code'
        ],
      ).toBe('ORIGIN_REJECTED');
      const many = multipart([
        { name: '_csrf', value: csrfFor('mia') },
        ...[1, 2, 3, 4].map((index) => ({
          name: 'files',
          filename: `f${index}.pdf`,
          type: 'application/pdf',
          data: PDF,
        })),
      ]);
      const tooMany = await post(many, 'mia');
      expect(tooMany.status).toBe(413);
      expect(tooMany.json()['code']).toBe('TOO_MANY_FILES');
      const evil = multipart([
        { name: '_csrf', value: csrfFor('mia') },
        {
          name: 'files',
          filename: '../../evil.pdf',
          type: 'application/pdf',
          data: PDF,
        },
      ]);
      expect((await post(evil, 'mia')).json()['code']).toBe('INVALID_FILENAME');
      // Streaming limit without Content-Length: aborted while reading.
      const huge = multipart([
        { name: '_csrf', value: csrfFor('mia') },
        {
          name: 'files',
          filename: 'huge.pdf',
          type: 'application/pdf',
          data: Buffer.concat([PDF, Buffer.alloc(200 * 1024, 0x20)]),
        },
      ]);
      const streamed = await send(base, 'POST', '/host/form', {
        headers: {
          'x-test-user': 'mia',
          origin: ORIGIN,
          'content-type': `multipart/form-data; boundary=${huge.boundary}`,
          'transfer-encoding': 'chunked',
        },
        parts: Array.from(
          { length: Math.ceil(huge.body.byteLength / 16384) },
          (_value, index) =>
            huge.body.subarray(index * 16384, (index + 1) * 16384),
        ),
        partDelayMs: 1,
      });
      expect([413, -1]).toContain(streamed.status);
      if (streamed.status === 413)
        expect(streamed.json()['code']).toBe('FILE_TOO_LARGE');
      await noLeaks();
    });

    it('treats finalize as single use under concurrency and revalidates stored bytes', async () => {
      const reply = await upload('nina', 'images', 'race.png', PNG);
      const token = String(reply.json()['token']);
      const results = await Promise.all([
        finalize('nina', token, 'images'),
        finalize('nina', token, 'images'),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
      // A temporary file changed on disk after upload is refused at finalize.
      await service.sweep(Date.now() + 60 * 60_000);
      const second = await upload('nina', 'images', 'tamper.png', PNG);
      const parts = await partFiles(service.temporaryDirectory);
      expect(parts).toHaveLength(1);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        join(service.temporaryDirectory, parts[0] ?? ''),
        Buffer.concat([
          PNG.subarray(0, 8),
          Buffer.from('changed-bytes-same-size'),
        ]).subarray(0, PNG.byteLength),
      );
      const tampered = await finalize(
        'nina',
        String(second.json()['token']),
        'images',
      );
      expect(tampered.status).toBe(409);
      expect(tampered.json()['code']).toBe('UPLOAD_TAMPERED');
      expect(await partFiles(service.temporaryDirectory)).toHaveLength(0);
    });

    it('surfaces failures as UploadError codes for host routes', () => {
      const error = new UploadError(413, 'FILE_TOO_LARGE');
      expect(error.getStatus()).toBe(413);
      expect(error.getResponse()).toEqual({
        statusCode: 413,
        code: 'FILE_TOO_LARGE',
      });
    });
  });

describe('upload lifecycle cleanup', () => {
  it('removes pending temporary files on application shutdown and stale directories on start', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'nestvexa-uploads-shutdown-'),
    );
    const options = {
      origin: ORIGIN,
      directory,
      tokenTtlMs: 10_000,
      resolveIdentity: (request: object) => {
        const user = header(request, 'x-test-user') ?? 'anon';
        return {
          binding: `test-user:${user}:binding`,
          csrfToken: csrfFor(user),
        };
      },
      authorize: () => true,
      purposes: { images: { types: ['png' as const], maxFileSize: 4096 } },
    };
    // A crashed earlier process left a temporary directory behind.
    const { mkdir, utimes, writeFile } = await import('node:fs/promises');
    const stale = join(directory, 'tmp', '1234-abcdefabcdef');
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, 'orphan.part'), 'x');
    const old = new Date(Date.now() - 60_000);
    await utimes(stale, old, old);
    const moduleRef = await Test.createTestingModule({
      imports: [UploadsModule.register(options)],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    expect(existsSync(stale)).toBe(false);
    const service = app.get(UploadsService);
    const reply = await rawUpload(base, 'olga', 'images', 'keep.png', PNG);
    expect(reply.status).toBe(201);
    const temporary = service.temporaryDirectory;
    expect((await stat(temporary)).isDirectory()).toBe(true);
    expect(await partFiles(temporary)).toHaveLength(1);
    await app.close();
    expect(existsSync(temporary)).toBe(false);
    await rm(directory, { recursive: true, force: true });
  });

  it('validates module options strictly', () => {
    const base = {
      origin: ORIGIN,
      directory: tmpdir(),
      resolveIdentity: () => ({
        binding: 'x'.repeat(16),
        csrfToken: 'y'.repeat(32),
      }),
      authorize: () => true,
      purposes: { images: { types: ['png' as const], maxFileSize: 1024 } },
    };
    expect(() =>
      UploadsModule.register({ ...base, origin: 'http://uploads.test/path' }),
    ).toThrow(/origin/);
    expect(() =>
      UploadsModule.register({ ...base, directory: 'relative/dir' }),
    ).toThrow(/absolute/);
    expect(() =>
      UploadsModule.register({ ...base, endpoint: '/../x' }),
    ).toThrow(/endpoint/);
    expect(() => UploadsModule.register({ ...base, purposes: {} })).toThrow(
      /purpose/,
    );
    expect(() =>
      UploadsModule.register({
        ...base,
        purposes: { 'bad purpose': { types: ['png'], maxFileSize: 1 } },
      }),
    ).toThrow(/purpose/);
    expect(() =>
      UploadsModule.register({
        ...base,
        purposes: { images: { types: ['exe' as 'png'], maxFileSize: 1 } },
      }),
    ).toThrow(/Unknown built-in/);
    expect(() =>
      UploadsModule.register({
        ...base,
        purposes: { images: { types: ['png'], maxFileSize: 0 } },
      }),
    ).toThrow(/maxFileSize/);
    expect(() =>
      UploadsModule.register({
        ...base,
        purposes: { images: { types: ['png'], maxFileSize: 1, direct: true } },
      }),
    ).toThrow(/presign/);
    expect(() =>
      UploadsModule.register({
        ...base,
        quotas: { identityFiles: 1, perUser: 2 } as { identityFiles: number },
      }),
    ).toThrow(/Unknown upload quota/);
    expect(() => UploadsModule.register({ ...base, chunkSize: 10 })).toThrow(
      /chunkSize/,
    );
    expect(() =>
      UploadsModule.register({ ...base, unknown: true } as typeof base),
    ).toThrow(/Unknown uploads option/);
    expect(() =>
      UploadsModule.register({
        ...base,
        purposes: {
          scripts: {
            types: [
              {
                name: 'script',
                extensions: ['js'],
                mime: 'text/javascript',
                text: true,
              },
            ],
            maxFileSize: 1,
          },
        },
      }),
    ).toThrow(/refused extension/);
  });
});
