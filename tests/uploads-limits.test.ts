import 'reflect-metadata';
import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Module,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, get } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  UploadsModule,
  UploadsService,
  configureUploads,
  sendDownload,
} from '../packages/uploads/dist/index.js';
import type { UploadQuotaOptions } from '../packages/uploads/dist/index.js';
import { defineForm, finalizeFileField } from '../packages/forms/dist/index.js';
import {
  ORIGIN,
  PNG,
  csrfFor,
  identity,
  json,
  rawUpload,
  send,
} from './support/uploads-http.js';

function header(request: object, name: string): string | undefined {
  const value: unknown = Reflect.get(
    Reflect.get(request, 'headers') as object,
    name,
  );
  return typeof value === 'string' ? value : undefined;
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const avatarForm = defineForm({
  fields: { caption: '' },
  files: { avatar: { max: 1 } },
});

/** A real Express app with configurable quotas and a forms-backed route. */
async function start(quotas: UploadQuotaOptions) {
  const directory = await mkdtemp(join(tmpdir(), 'nestvexa-upload-limits-'));
  @Controller('profile')
  class ProfileController {
    constructor(
      @Inject(UploadsService) private readonly uploads: UploadsService,
    ) {}
    /** Form state with a file field, finalized through @nestvexa/forms. */
    @Post()
    @HttpCode(200)
    async save(
      @Req() request: object,
      @Body() body: { caption: string; avatar: string },
    ) {
      const state = avatarForm.update(avatarForm.create(), body);
      const { state: validated, result } = await avatarForm.validate(state);
      if (!result.ok) return { ok: false, errors: validated.errors };
      const files = await finalizeFileField(
        avatarForm,
        validated,
        'avatar',
        (token) =>
          this.uploads.finalize(request, token, { purpose: 'avatars' }),
      );
      if (!files.ok) return { ok: false, errors: files.errors };
      return {
        ok: true,
        caption: result.value['caption'],
        files: files.files.map((file) => ({
          size: file.size,
          contentType: file.contentType,
        })),
      };
    }
  }
  @Module({
    imports: [
      UploadsModule.register({
        origin: ORIGIN,
        directory,
        sweepIntervalMs: 60_000,
        quotas: { requestsPerMinute: 10_000, ...quotas },
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
        authorize: () => true,
        purposes: {
          avatars: { types: ['png'], maxFileSize: 1024, maxFiles: 10 },
        },
      }),
    ],
    controllers: [ProfileController],
  })
  class AppModule {}
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app: INestApplication = moduleRef.createNestApplication({
    logger: false,
  });
  await configureUploads(app);
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  cleanups.push(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const upload = (user: string, tenant?: string, body = PNG) =>
    rawUpload(
      base,
      user,
      'avatars',
      'a.png',
      body,
      tenant === undefined ? {} : { 'x-test-tenant': tenant },
    );
  // The tenant is part of the identity: only the same binding and tenant may cancel.
  const cancel = (user: string, token: string, tenant?: string) =>
    send(base, 'DELETE', `/_nestvexa/uploads/files/${token}`, {
      headers: identity(user, tenant),
    });
  return { base, upload, cancel, service: app.get(UploadsService) };
}
const token = (reply: { json(): Record<string, unknown> }) =>
  String(reply.json()['token']);

describe('tenant and process-wide upload quotas', () => {
  it('exhausts the tenant file quota across identities and releases it on cancel', async () => {
    const { upload, cancel } = await start({ tenantFiles: 2 });
    const first = await upload('alice', 'acme');
    const second = await upload('bob', 'acme');
    expect([first.status, second.status]).toEqual([201, 201]);
    const third = await upload('carol', 'acme');
    expect(third.status).toBe(429);
    expect(third.json()).toEqual({ statusCode: 429, code: 'QUOTA_EXCEEDED' });
    // Another tenant, and an identity without tenant, are unaffected.
    expect((await upload('dave', 'globex')).status).toBe(201);
    expect((await upload('erin')).status).toBe(201);
    // Without the tenant the same user is another identity and cannot cancel.
    expect((await cancel('alice', token(first))).status).toBe(404);
    expect((await cancel('alice', token(first), 'acme')).status).toBe(204);
    expect((await upload('carol', 'acme')).status).toBe(201);
  });
  it('exhausts the tenant byte quota', async () => {
    const { upload } = await start({ tenantBytes: PNG.byteLength * 2 + 10 });
    expect((await upload('alice', 'acme')).status).toBe(201);
    expect((await upload('bob', 'acme')).status).toBe(201);
    const over = await upload('carol', 'acme');
    expect(over.status).toBe(429);
    expect(over.json()['code']).toBe('QUOTA_EXCEEDED');
    expect((await upload('carol', 'globex')).status).toBe(201);
  });
  it('exhausts the process-wide file quota for every identity and tenant', async () => {
    const { upload, cancel, service } = await start({ totalFiles: 3 });
    const replies = [
      await upload('alice', 'acme'),
      await upload('bob', 'globex'),
      await upload('carol'),
    ];
    expect(replies.map((reply) => reply.status)).toEqual([201, 201, 201]);
    expect(service.pendingCount).toBe(3);
    for (const [user, tenant] of [
      ['dave', 'initech'],
      ['erin', undefined],
      ['alice', 'acme'],
    ] as const) {
      const refused = await upload(user, tenant);
      expect(refused.status).toBe(429);
      expect(refused.json()['code']).toBe('QUOTA_EXCEEDED');
    }
    expect(service.pendingCount).toBe(3);
    const first = replies[0];
    if (!first) throw new Error('missing upload');
    expect((await cancel('alice', token(first), 'acme')).status).toBe(204);
    expect((await upload('dave', 'initech')).status).toBe(201);
  });
  it('exhausts the process-wide byte quota and frees it when a form finalizes the file', async () => {
    const { base, upload } = await start({
      totalBytes: PNG.byteLength * 2 + 10,
    });
    const first = await upload('alice');
    expect(first.status).toBe(201);
    expect((await upload('bob', 'acme')).status).toBe(201);
    const over = await upload('carol', 'globex');
    expect(over.status).toBe(429);
    expect(over.json()['code']).toBe('QUOTA_EXCEEDED');
    // Finalizing through the forms file field commits the file and releases
    // its temporary bytes.
    const saved = await json(base, 'POST', '/profile', 'alice', {
      caption: 'me',
      avatar: token(first),
    });
    expect(saved.json()).toEqual({
      ok: true,
      caption: 'me',
      files: [{ size: PNG.byteLength, contentType: 'image/png' }],
    });
    expect((await upload('carol', 'globex')).status).toBe(201);
  });
});

describe('uploads in @nestvexa/forms state', () => {
  it('maps finalize failures and malformed references to field errors', async () => {
    const { base, upload } = await start({});
    const mine = await upload('alice');
    const theirs = await upload('bob');
    // Another identity's token: not found for alice, reported on the field.
    const foreign = await json(base, 'POST', '/profile', 'alice', {
      caption: 'x',
      avatar: token(theirs),
    });
    expect(foreign.json()).toEqual({
      ok: false,
      errors: { avatar: ['Upload the file again.'] },
    });
    const malformed = await json(base, 'POST', '/profile', 'alice', {
      caption: 'x',
      avatar: '../../etc/passwd',
    });
    expect(malformed.json()).toEqual({
      ok: false,
      errors: { avatar: ['Upload the file again.'] },
    });
    const ok = await json(base, 'POST', '/profile', 'alice', {
      caption: 'x',
      avatar: token(mine),
    });
    expect(ok.json()['ok']).toBe(true);
    const replay = await json(base, 'POST', '/profile', 'alice', {
      caption: 'x',
      avatar: token(mine),
    });
    expect(replay.json()).toEqual({
      ok: false,
      errors: { avatar: ['This file was already submitted.'] },
    });
  });
});

/** Plain Node server running sendDownload over a controllable source. */
async function downloadServer(
  source: () => Readable,
  size: number,
  idleTimeoutMs?: number,
) {
  const finished: Promise<void>[] = [];
  const server: Server = createServer((request, response) => {
    finished.push(
      sendDownload(request, response, {
        filename: 'data.bin',
        contentType: 'application/octet-stream',
        size,
        open: () => Promise.resolve(source()),
        ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
      }),
    );
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, finished };
}
function open(url: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    get(url, resolve).on('error', reject);
  });
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('download streaming', () => {
  it('pauses the source while a slow reader applies backpressure and completes on resume', async () => {
    const total = 64 * 1024 * 1024;
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    let produced = 0;
    let pauses = 0;
    let source: Readable | undefined;
    const { url, finished } = await downloadServer(() => {
      source = new Readable({
        read() {
          if (produced >= total) {
            this.push(null);
            return;
          }
          produced += chunk.byteLength;
          this.push(chunk);
        },
      });
      source.on('pause', () => pauses++);
      return source;
    }, total);
    const response = await open(url);
    expect(response.statusCode).toBe(200);
    response.pause();
    await sleep(500);
    const whileStalled = produced;
    await sleep(300);
    // The server stopped pulling: production is bounded by socket and stream buffers.
    expect(produced).toBe(whileStalled);
    expect(produced).toBeLessThan(total);
    expect(pauses).toBeGreaterThan(0);
    expect(source?.isPaused()).toBe(true);
    let received = 0;
    response.on('data', (data: Buffer) => {
      received += data.byteLength;
    });
    await new Promise<void>((resolve, reject) => {
      response.once('end', () => resolve());
      response.once('error', reject);
      response.resume();
    });
    expect(received).toBe(total);
    await Promise.all(finished);
  });
  it('destroys the transfer when the client stops reading past the idle timeout', async () => {
    const total = 64 * 1024 * 1024;
    const chunk = Buffer.alloc(64 * 1024, 0x62);
    let produced = 0;
    let source: Readable | undefined;
    const { url, finished } = await downloadServer(
      () => {
        source = new Readable({
          read() {
            produced += chunk.byteLength;
            this.push(produced > total ? null : chunk);
          },
        });
        return source;
      },
      total,
      200,
    );
    const response = await open(url);
    response.pause();
    const closed = new Promise<void>((resolve) =>
      response.once('close', () => resolve()),
    );
    response.on('error', () => undefined);
    const started = Date.now();
    // The response headers arrived, so sendDownload is already running.
    expect(finished).toHaveLength(1);
    await Promise.all(finished);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(source?.destroyed).toBe(true);
    response.resume();
    await closed;
    expect(response.complete).toBe(false);
  });
  it('destroys the transfer when the source stalls past the idle timeout', async () => {
    let source: Readable | undefined;
    const { url, finished } = await downloadServer(
      () => {
        let sent = false;
        source = new Readable({
          read() {
            // One chunk, then the storage backend hangs.
            if (!sent) {
              sent = true;
              this.push(Buffer.from('partial'));
            }
          },
        });
        return source;
      },
      1024,
      150,
    );
    const response = await open(url);
    let received = '';
    response.setEncoding('utf8');
    response.on('data', (data: string) => {
      received += data;
    });
    response.on('error', () => undefined);
    await new Promise<void>((resolve) =>
      response.once('close', () => resolve()),
    );
    await Promise.all(finished);
    expect(received).toBe('partial');
    expect(response.complete).toBe(false);
    expect(source?.destroyed).toBe(true);
  });
});
