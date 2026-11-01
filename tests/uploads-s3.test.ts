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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  ClamdScanner,
  EMPTY_SHA256,
  S3Storage,
  UploadsModule,
  UploadsService,
  canonicalRequest,
  presignUrl,
  sha256Hex,
  signRequest,
} from '../packages/uploads/dist/index.js';
import type {
  FinalizedUpload,
  ScanVerdict,
  UploadScanner,
} from '../packages/uploads/dist/index.js';
import { startFakeS3 } from './support/fake-s3.js';
import type { FakeS3 } from './support/fake-s3.js';
import {
  ORIGIN,
  PDF,
  PNG,
  csrfFor,
  json,
  rawUpload,
  send,
  sha256,
} from './support/uploads-http.js';

/**
 * AWS published SigV4 vectors: the aws-sig-v4-test-suite ("service" scope,
 * 20150830T123600Z) and the S3 "Signature Calculations" documentation examples
 * (examplebucket, 20130524T000000Z).
 */
describe('SigV4 against AWS published test vectors', () => {
  const suite = {
    credentials: {
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    },
    region: 'us-east-1',
    service: 'service',
    date: new Date('2015-08-30T12:36:00Z'),
  };
  it.each([
    [
      'get-vanilla',
      'GET',
      'https://example.amazonaws.com/',
      '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    ],
    [
      'get-vanilla-query-order-key-case',
      'GET',
      'https://example.amazonaws.com/?Param2=value2&Param1=value1',
      'b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500',
    ],
    [
      'post-vanilla',
      'POST',
      'https://example.amazonaws.com/',
      '5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b',
    ],
  ])('%s', (_name, method, url, signature) => {
    const headers = signRequest({
      ...suite,
      method,
      url: new URL(url),
      headers: { host: 'example.amazonaws.com' },
      payloadHash: EMPTY_SHA256,
    });
    expect(headers['authorization']).toBe(
      `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=${signature}`,
    );
  });
  it('builds the get-vanilla canonical request', () => {
    const request = canonicalRequest(
      'GET',
      new URL('https://example.amazonaws.com/'),
      { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
      EMPTY_SHA256,
    );
    expect(sha256Hex(request.text)).toBe(
      'bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63',
    );
  });
  const s3 = {
    credentials: {
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    },
    region: 'us-east-1',
    service: 's3',
    date: new Date('2013-05-24T00:00:00Z'),
  };
  it('signs the S3 GET Object (Range) example', () => {
    const headers = signRequest({
      ...s3,
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { range: 'bytes=0-9' },
      payloadHash: EMPTY_SHA256,
    });
    expect(headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });
  it('signs the S3 PUT Object example with a reserved character in the key', () => {
    const headers = signRequest({
      ...s3,
      method: 'PUT',
      url: new URL('https://examplebucket.s3.amazonaws.com/test$file.text'),
      headers: {
        date: 'Fri, 24 May 2013 00:00:00 GMT',
        'x-amz-storage-class': 'REDUCED_REDUNDANCY',
      },
      payloadHash: sha256Hex('Welcome to Amazon S3.'),
    });
    expect(headers['authorization']).toContain(
      'SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
    );
  });
  it.each([
    [
      '?lifecycle',
      'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543',
    ],
    [
      '?max-keys=2&prefix=J',
      '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7',
    ],
  ])('signs the S3 bucket example %s', (query, signature) => {
    const headers = signRequest({
      ...s3,
      method: 'GET',
      url: new URL(`https://examplebucket.s3.amazonaws.com/${query}`),
      headers: {},
      payloadHash: EMPTY_SHA256,
    });
    expect(headers['authorization']).toContain(`Signature=${signature}`);
  });
  it('produces the S3 presigned URL example', () => {
    const url = presignUrl({
      ...s3,
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      expiresInSeconds: 86400,
    });
    expect(url.href).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });
  it('rejects invalid scopes, lifetimes and header injection', () => {
    expect(() =>
      presignUrl({
        ...s3,
        method: 'GET',
        url: new URL('https://x.test/a'),
        expiresInSeconds: 604801,
      }),
    ).toThrow();
    expect(() =>
      signRequest({
        ...s3,
        region: 'US EAST',
        method: 'GET',
        url: new URL('https://x.test/a'),
        headers: {},
        payloadHash: EMPTY_SHA256,
      }),
    ).toThrow();
    expect(() =>
      signRequest({
        ...s3,
        method: 'GET',
        url: new URL('https://x.test/a'),
        headers: { 'x-amz-meta': 'a\r\nb' },
        payloadHash: EMPTY_SHA256,
      }),
    ).toThrow();
  });
});

const credentials = {
  accessKeyId: 'NESTVEXATESTKEY',
  secretAccessKey: 'nestvexa-test-secret-key-0123456789',
};
const key = (suffix: string) => `ab/${suffix.padEnd(43, 'x').slice(0, 43)}`;

describe('S3Storage against the in-process S3-compatible test double', () => {
  let fake: FakeS3;
  let storage: S3Storage;
  let directory: string;
  beforeAll(async () => {
    fake = await startFakeS3({
      bucket: 'nestvexa-test',
      region: 'eu-test-1',
      ...credentials,
    });
    storage = new S3Storage({
      endpoint: fake.url,
      region: 'eu-test-1',
      bucket: 'nestvexa-test',
      credentials,
      prefix: 'uploads/',
    });
    directory = await mkdtemp(join(tmpdir(), 'nestvexa-s3-storage-'));
  });
  afterAll(async () => {
    await fake.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function collect(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream)
      chunks.push(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array),
      );
    return Buffer.concat(chunks);
  }
  it('puts, stats, reads ranges and deletes with signed requests', async () => {
    const path = join(directory, 'object.pdf');
    await writeFile(path, PDF);
    const stored = await storage.put(key('one'), {
      path,
      size: PDF.byteLength,
      sha256: sha256(PDF),
      contentType: 'application/pdf',
    });
    expect(stored).toEqual({ key: key('one'), size: PDF.byteLength });
    expect(fake.objects.get(`uploads/${key('one')}`)?.body.equals(PDF)).toBe(
      true,
    );
    expect(fake.objects.get(`uploads/${key('one')}`)?.contentType).toBe(
      'application/pdf',
    );
    expect(await storage.stat(key('one'))).toEqual({ size: PDF.byteLength });
    expect((await collect(await storage.open(key('one')))).equals(PDF)).toBe(
      true,
    );
    expect(
      (
        await collect(await storage.open(key('one'), { start: 1, end: 4 }))
      ).equals(PDF.subarray(1, 5)),
    ).toBe(true);
    await storage.delete(key('one'));
    expect(await storage.stat(key('one'))).toBeUndefined();
    await expect(storage.open(key('one'))).rejects.toMatchObject({
      code: 'UPLOAD_NOT_FOUND',
    });
  });
  it('fails closed on wrong credentials or a mismatched payload digest', async () => {
    const path = join(directory, 'bad.pdf');
    await writeFile(path, PDF);
    const wrong = new S3Storage({
      endpoint: fake.url,
      region: 'eu-test-1',
      bucket: 'nestvexa-test',
      credentials: { ...credentials, secretAccessKey: 'wrong-secret-value' },
    });
    await expect(
      wrong.put(key('two'), {
        path,
        size: PDF.byteLength,
        sha256: sha256(PDF),
        contentType: 'application/pdf',
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await expect(
      storage.put(key('two'), {
        path,
        size: PDF.byteLength,
        sha256: sha256(PNG),
        contentType: 'application/pdf',
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(fake.objects.has(`uploads/${key('two')}`)).toBe(false);
  });
  it('presigns exact-size PUTs and expiring GETs with safe response headers', async () => {
    const target = await storage.presignUpload(key('three'), {
      contentType: 'image/png',
      size: PNG.byteLength,
      expiresInSeconds: 60,
    });
    expect(target.url).not.toContain(credentials.secretAccessKey);
    expect(target.headers).toEqual({ 'content-type': 'image/png' });
    const put = (body: Buffer, type = 'image/png') =>
      send(target.url, 'PUT', target.url, {
        headers: {
          'content-type': type,
          'content-length': String(body.byteLength),
        },
        body,
      });
    expect((await put(Buffer.concat([PNG, Buffer.from('x')]))).status).toBe(
      403,
    );
    expect(await put(PNG, 'text/html')).toMatchObject({ status: 403 });
    expect((await put(PNG)).status).toBe(200);
    const url = await storage.presignDownload(key('three'), {
      filename: 'résumé "final".png',
      contentType: 'image/png',
    });
    const download = await send(url, 'GET', url);
    expect(download.status).toBe(200);
    expect(download.body.equals(PNG)).toBe(true);
    expect(download.headers['content-disposition']).toBe(
      `attachment; filename="r_sum_ _final_.png"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.png`,
    );
    const original = fake.now;
    fake.now = () => Date.now() + 10 * 60_000;
    try {
      expect((await send(url, 'GET', url)).status).toBe(403);
    } finally {
      fake.now = original;
    }
    const tampered = url.replace(
      'response-content-type=image%2Fpng',
      'response-content-type=text%2Fhtml',
    );
    expect((await send(tampered, 'GET', tampered)).status).toBe(403);
  });
  it('refuses unsafe configuration and keys', async () => {
    expect(
      () =>
        new S3Storage({
          endpoint: 'ftp://x.test',
          region: 'r',
          bucket: 'nestvexa-test',
          credentials,
        }),
    ).toThrow();
    expect(
      () =>
        new S3Storage({
          endpoint: 'https://user:pw@x.test',
          region: 'r',
          bucket: 'nestvexa-test',
          credentials,
        }),
    ).toThrow();
    expect(
      () =>
        new S3Storage({
          endpoint: fake.url,
          region: 'r',
          bucket: 'Bad_Bucket',
          credentials,
        }),
    ).toThrow();
    expect(
      () =>
        new S3Storage({
          endpoint: fake.url,
          region: 'r',
          bucket: 'nestvexa-test',
          credentials,
          prefix: '../',
        }),
    ).toThrow();
    expect(() => storage.url('../../etc/passwd')).toThrow(/storage key/);
    await expect(storage.stat('http://169.254.169.254/latest')).rejects.toThrow(
      /storage key/,
    );
  });
});

class FakeClamd {
  server: Server;
  port = 0;
  constructor() {
    this.server = createServer((socket) => {
      let buffer = Buffer.alloc(0);
      let commandRead = false;
      const data: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!commandRead) {
          const end = buffer.indexOf(0);
          if (end < 0) return;
          if (buffer.subarray(0, end).toString() !== 'zINSTREAM')
            return socket.end('UNKNOWN COMMAND\0');
          commandRead = true;
          buffer = buffer.subarray(end + 1);
        }
        while (buffer.byteLength >= 4) {
          const length = buffer.readUInt32BE(0);
          if (length === 0) {
            const content = Buffer.concat(data).toString('latin1');
            socket.end(
              content.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')
                ? 'stream: Win.Test.EICAR_HDB-1 FOUND\0'
                : content.includes('SCAN-ERROR')
                  ? 'INSTREAM size limit exceeded. ERROR\0'
                  : 'stream: OK\0',
            );
            return;
          }
          if (buffer.byteLength < 4 + length) return;
          data.push(buffer.subarray(4, 4 + length));
          buffer = buffer.subarray(4 + length);
        }
      });
    });
  }
  async start(): Promise<number> {
    await new Promise<void>((resolve) =>
      this.server.listen(0, '127.0.0.1', resolve),
    );
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    this.port = address.port;
    return this.port;
  }
}

describe('direct-to-storage uploads, finalize revalidation and scanner hooks', () => {
  let fake: FakeS3;
  let clamd: FakeClamd;
  let app: INestApplication;
  let base: string;
  let directory: string;
  let service: UploadsService;
  const finalized = new Map<string, FinalizedUpload>();
  const verdicts: { next?: ScanVerdict | undefined } = {};
  beforeAll(async () => {
    fake = await startFakeS3({
      bucket: 'nestvexa-direct',
      region: 'eu-test-1',
      ...credentials,
    });
    clamd = new FakeClamd();
    const port = await clamd.start();
    directory = await mkdtemp(join(tmpdir(), 'nestvexa-direct-'));
    const clam = new ClamdScanner({ port, timeoutMs: 5000 });
    // Delegate to clamd unless a test forces a verdict (to model scanner faults).
    const scanner: UploadScanner = {
      name: 'test-clamd',
      async scan(file, signal) {
        const forced = verdicts.next;
        verdicts.next = undefined;
        return forced ?? clam.scan(file, signal);
      },
    };
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
      @Get('presigned/:shard/:name')
      async presigned(
        @Param('shard') shard: string,
        @Param('name') name: string,
      ) {
        const file = finalized.get(`${shard}/${name}`);
        if (!file) throw new UnauthorizedException();
        return { url: await this.uploads.presignDownload(file) };
      }
    }
    @Module({
      imports: [
        UploadsModule.register({
          origin: ORIGIN,
          directory,
          storage: new S3Storage({
            endpoint: fake.url,
            region: 'eu-test-1',
            bucket: 'nestvexa-direct',
            credentials,
            prefix: 'app/',
          }),
          scanner,
          resolveIdentity(request: object) {
            const headers = Reflect.get(request, 'headers') as Record<
              string,
              string | undefined
            >;
            const user = headers['x-test-user'];
            if (!user) throw new UnauthorizedException();
            return {
              binding: `test-user:${user}:binding`,
              csrfToken: csrfFor(user),
            };
          },
          authorize: () => true,
          purposes: {
            direct: {
              types: ['png', 'pdf'],
              maxFileSize: 64 * 1024,
              direct: true,
            },
            scanned: {
              types: ['txt', 'png'],
              maxFileSize: 64 * 1024,
              requireScan: true,
            },
          },
        }),
      ],
      controllers: [HostController],
    })
    class AppModule {}
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    service = app.get(UploadsService);
  });
  afterAll(async () => {
    await app?.close();
    await fake?.close();
    await new Promise<void>((resolve) => clamd.server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  it('presigns a direct upload, verifies the stored object on completion and finalizes without credentials in the browser', async () => {
    const created = await json(
      base,
      'POST',
      '/_nestvexa/uploads/sessions',
      'sam',
      {
        purpose: 'direct',
        name: 'scan.pdf',
        type: 'application/pdf',
        size: PDF.byteLength,
      },
    );
    expect(created.status).toBe(201);
    const session = created.json() as {
      session: string;
      mode: string;
      url: string;
      headers: Record<string, string>;
    };
    expect(session.mode).toBe('direct');
    expect(session.url.startsWith(`${fake.url}/nestvexa-direct/app/`)).toBe(
      true,
    );
    expect(JSON.stringify(session)).not.toContain(credentials.secretAccessKey);
    // Completing before the browser PUT is refused.
    expect(
      (
        await json(
          base,
          'POST',
          `/_nestvexa/uploads/sessions/${session.session}/complete`,
          'sam',
          {},
        )
      ).json()['code'],
    ).toBe('UPLOAD_INCOMPLETE');
    const put = await send(session.url, 'PUT', session.url, {
      headers: { ...session.headers, 'content-length': String(PDF.byteLength) },
      body: PDF,
    });
    expect(put.status).toBe(200);
    const completed = await json(
      base,
      'POST',
      `/_nestvexa/uploads/sessions/${session.session}/complete`,
      'sam',
      {},
    );
    expect(completed.status).toBe(200);
    const token = String(completed.json()['token']);
    expect(
      (
        await json(base, 'POST', '/host/finalize', 'mallory', {
          token,
          purpose: 'direct',
        })
      ).status,
    ).toBe(404);
    const done = await json(base, 'POST', '/host/finalize', 'sam', {
      token,
      purpose: 'direct',
    });
    expect(done.status).toBe(200);
    const file = done.json();
    expect(file).toMatchObject({
      storage: 's3',
      sha256: sha256(PDF),
      scan: 'clean',
      contentType: 'application/pdf',
    });
    expect(
      fake.objects.get(`app/${String(file['key'])}`)?.body.equals(PDF),
    ).toBe(true);
    const range = await send(
      base,
      'GET',
      `/host/download/${String(file['key'])}`,
      { headers: { range: 'bytes=0-3' } },
    );
    expect(range.status).toBe(206);
    expect(range.body.toString()).toBe('%PDF');
    const presigned = (
      await send(base, 'GET', `/host/presigned/${String(file['key'])}`)
    ).json();
    const fetched = await send(
      String(presigned['url']),
      'GET',
      String(presigned['url']),
    );
    expect(fetched.body.equals(PDF)).toBe(true);
    expect(fetched.headers['content-disposition']).toBe(
      `attachment; filename="scan.pdf"; filename*=UTF-8''scan.pdf`,
    );
  });

  it('refuses direct objects whose bytes do not match the declaration and deletes them', async () => {
    const created = (
      await json(base, 'POST', '/_nestvexa/uploads/sessions', 'sam', {
        purpose: 'direct',
        name: 'fake.png',
        type: 'image/png',
        size: PDF.byteLength,
      })
    ).json() as { session: string; url: string };
    expect(
      (
        await send(created.url, 'PUT', created.url, {
          headers: {
            'content-type': 'image/png',
            'content-length': String(PDF.byteLength),
          },
          body: PDF,
        })
      ).status,
    ).toBe(200);
    const completed = await json(
      base,
      'POST',
      `/_nestvexa/uploads/sessions/${created.session}/complete`,
      'sam',
      {},
    );
    expect(completed.json()['code']).toBe('CONTENT_MISMATCH');
    const objectPath = new URL(created.url).pathname.replace(
      '/nestvexa-direct/',
      '',
    );
    expect(fake.objects.has(decodeURIComponent(objectPath))).toBe(false);
  });

  it('blocks infected files, reports scanner failures and never claims a scan without one', async () => {
    const eicar = Buffer.from(
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
    );
    const infected = await rawUpload(
      base,
      'tom',
      'scanned',
      'eicar.txt',
      eicar,
    );
    expect(infected.status).toBe(201);
    const blocked = await json(base, 'POST', '/host/finalize', 'tom', {
      token: String(infected.json()['token']),
      purpose: 'scanned',
    });
    expect(blocked.status).toBe(422);
    expect(blocked.json()['code']).toBe('UPLOAD_INFECTED');
    expect(
      (
        await json(base, 'POST', '/host/finalize', 'tom', {
          token: String(infected.json()['token']),
          purpose: 'scanned',
        })
      ).status,
    ).toBe(404);
    const clean = await rawUpload(
      base,
      'tom',
      'scanned',
      'notes.txt',
      Buffer.from('plain notes'),
    );
    const ok = await json(base, 'POST', '/host/finalize', 'tom', {
      token: String(clean.json()['token']),
      purpose: 'scanned',
    });
    expect(ok.json()['scan']).toBe('clean');
    const faulty = await rawUpload(
      base,
      'tom',
      'scanned',
      'fault.txt',
      Buffer.from('SCAN-ERROR here'),
    );
    const failed = await json(base, 'POST', '/host/finalize', 'tom', {
      token: String(faulty.json()['token']),
      purpose: 'scanned',
    });
    expect(failed.status).toBe(503);
    expect(failed.json()['code']).toBe('SCAN_FAILED');
    // A scanner error is retryable: the temporary upload remains until it expires.
    verdicts.next = { status: 'clean' };
    expect(
      (
        await json(base, 'POST', '/host/finalize', 'tom', {
          token: String(faulty.json()['token']),
          purpose: 'scanned',
        })
      ).json()['scan'],
    ).toBe('clean');
    expect(
      (await readdir(service.temporaryDirectory)).filter((name) =>
        name.endsWith('.part'),
      ),
    ).toHaveLength(service.pendingCount);
  });

  it('requires a configured scanner for requireScan purposes', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'nestvexa-noscan-'));
    const moduleRef = await Test.createTestingModule({
      imports: [
        UploadsModule.register({
          origin: ORIGIN,
          directory: plain,
          resolveIdentity: () => ({
            binding: 'test-user:solo:binding',
            csrfToken: csrfFor('solo'),
          }),
          authorize: () => true,
          purposes: {
            scanned: { types: ['txt'], maxFileSize: 1024, requireScan: true },
          },
        }),
      ],
    }).compile();
    const local = moduleRef.createNestApplication();
    await local.listen(0, '127.0.0.1');
    const url = (await local.getUrl()).replace('[::1]', '127.0.0.1');
    const uploads = local.get(UploadsService);
    const reply = await rawUpload(
      url,
      'solo',
      'scanned',
      'a.txt',
      Buffer.from('hello'),
    );
    const request = { headers: { 'x-test-user': 'solo' } };
    await expect(
      uploads.finalize(request, String(reply.json()['token']), {
        purpose: 'scanned',
      }),
    ).rejects.toMatchObject({ code: 'SCANNER_REQUIRED' });
    await local.close();
    await rm(plain, { recursive: true, force: true });
  });

  it('ClamdScanner reports connection failures as scan errors', async () => {
    const scanner = new ClamdScanner({ port: 1, timeoutMs: 2000 });
    const verdict = await scanner.scan(
      {
        name: 'x.txt',
        contentType: 'text/plain',
        size: 1,
        sha256: '',
        open: async () => Readable.from([Buffer.from('x')]),
      },
      new AbortController().signal,
    );
    expect(verdict.status).toBe('error');
  });
});
