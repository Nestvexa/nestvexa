import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import {
  Action,
  BigIntSynthesizer,
  Computed,
  DateSynthesizer,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  State,
  Url,
  consumeLiveFlash,
  downloadLive,
  flashLive,
  paginate,
} from '../packages/live/dist/index.js';
import { definition } from '../packages/live/dist/metadata.js';
import { safeFilename } from '../packages/live/dist/effects.js';

const origin = 'http://localhost:3100';
const csrf = 'effects-host-csrf-01234567890123456789012';
const resources: {
  app: INestApplication;
  root: string;
  renderer: HbsEngine;
}[] = [];
afterEach(async () => {
  for (const { app, root, renderer } of resources.splice(0)) {
    await app.close();
    await renderer.dispose();
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep))
      throw new Error('Unexpected fixture directory');
    await rm(root, { recursive: true, force: true });
  }
});

interface Result {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}
function send(
  url: string,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  body?: object,
): Promise<Result> {
  return new Promise((done, reject) => {
    const request = httpRequest(url, { method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () =>
        done({
          status: response.statusCode ?? 500,
          headers: response.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    request.on('error', reject);
    request.end(body ? JSON.stringify(body) : undefined);
  });
}

async function fixture(platform: 'express' | 'fastify') {
  const root = await mkdtemp(join(tmpdir(), 'nestvexa-effects-'));
  await writeFile(
    join(root, 'report.hbs'),
    '<p>{{created}} {{big}} {{year}}</p>',
  );
  const renderer = new HbsEngine({ root });
  await renderer.initialize();
  const session: Record<string, unknown> = {};

  @LiveComponent({ name: 'report', view: 'report' })
  class Report {
    @State({ synthesizer: DateSynthesizer, writable: true })
    created = new Date('2026-01-02T03:04:05.000Z');
    @State({ synthesizer: BigIntSynthesizer }) big = 9007199254740993n;
    @Computed() get year(): number {
      return this.created.getUTCFullYear();
    }
    @Action() bump(): void {
      this.big += 1n;
      this.created = new Date(this.created.getTime() + 86_400_000);
    }
    @Action() exportFile(): void {
      downloadLive(this, {
        filename: '../q3 "report"\u0007ü.csv',
        contentType: 'text/csv; charset=utf-8',
        body: 'a,b\r\n1,2\r\n',
      });
      flashLive(this, 'Report exported');
    }
    @Action() twoDownloads(): void {
      downloadLive(this, { filename: 'a.txt', body: 'a' });
      downloadLive(this, { filename: 'b.txt', body: 'b' });
    }
  }
  const module = await Test.createTestingModule({
    imports: [
      LiveModule.register({
        components: [Report],
        renderer,
        origin,
        resolveIdentity: (request) => {
          const headers = Reflect.get(request, 'headers') as Record<
            string,
            string | undefined
          >;
          if (!Reflect.has(request, 'session'))
            Object.defineProperty(request, 'session', { value: session });
          return {
            binding:
              headers['x-user'] === 'bob'
                ? 'tenant/session/bob'
                : 'tenant/session/alice',
            csrfToken: csrf,
          };
        },
        authorize: () => true,
      }),
    ],
  }).compile();
  const app =
    platform === 'fastify'
      ? module.createNestApplication(new FastifyAdapter(), { logger: false })
      : module.createNestApplication({ logger: false });
  resources.push({ app, root, renderer });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const runtime = app.get(LiveRuntime);
  const html = (await runtime.mount(Report, { headers: {}, session })).value;
  const snapshot = /data-nv-snapshot="([^"]+)"/.exec(html)?.[1] ?? '';
  const post = (action: string, revision: number, updates: object = {}) =>
    send(
      `${base}/_nestvexa/live/report/${action}`,
      'POST',
      {
        origin,
        'content-type': 'application/json',
        'x-nestvexa-csrf': csrf,
      },
      {
        protocol: 'nestvexa-live/1',
        requestId: randomUUID(),
        snapshot,
        revision,
        updates,
        input: null,
      },
    );
  return { base, html, post, session, runtime, snapshot };
}

describe('state synthesizers', () => {
  it('round-trips Date and BigInt values and rejects malformed JSON forms', () => {
    const date = new Date('2026-11-01T10:00:00.000Z');
    expect(DateSynthesizer.hydrate(DateSynthesizer.dehydrate(date))).toEqual(
      date,
    );
    expect(DateSynthesizer.hydrate('2026-11-01T10:00:00Z')).toEqual(date);
    for (const bad of [
      '2026-02-30T00:00:00.000Z',
      '2026-11-01',
      '2026-11-01T10:00:00+02:00',
      12,
      null,
    ])
      expect(() => DateSynthesizer.hydrate(bad)).toThrow();
    expect(() => DateSynthesizer.dehydrate(new Date('invalid'))).toThrow();
    expect(BigIntSynthesizer.hydrate('-123456789012345678901234567890')).toBe(
      -123456789012345678901234567890n,
    );
    for (const bad of ['01', '1.5', '1e3', ' 1', 'x', 7, '9'.repeat(79)])
      expect(() => BigIntSynthesizer.hydrate(bad)).toThrow();
  });

  it('rejects synthesizers combined with URL, session or prop state', () => {
    @LiveComponent({ name: 'bad-synth', view: 'v' })
    class Bad {
      @Url()
      @State({ synthesizer: DateSynthesizer, writable: true })
      when = new Date();
    }
    expect(() => definition(Bad)).toThrow(/cannot also be @Url/);
    expect(() =>
      State({ synthesizer: { name: 'x' } as never })({}, 'field'),
    ).toThrow(/synthesizer/);
  });
});

describe('pagination', () => {
  it('clamps untrusted pages and windows links', () => {
    expect(paginate({ page: 99, perPage: 10, total: 25 })).toMatchObject({
      page: 3,
      pages: 3,
      offset: 20,
      from: 21,
      to: 25,
      hasNext: false,
      previous: 2,
    });
    expect(paginate({ page: -4, perPage: 10, total: 0 })).toMatchObject({
      page: 1,
      pages: 1,
      from: 0,
      to: 0,
    });
    const links = paginate({ page: 10, perPage: 1, total: 20 }).links.map(
      (link) => (link.gap ? '…' : link.page),
    );
    expect(links).toEqual([1, '…', 8, 9, 10, 11, 12, '…', 20]);
    expect(() => paginate({ page: 1, perPage: 0, total: 1 })).toThrow(
      RangeError,
    );
    expect(() => paginate({ page: 1, perPage: 10, total: -1 })).toThrow(
      RangeError,
    );
  });
});

describe('download filenames', () => {
  it('strips paths, quotes and control characters', () => {
    expect(safeFilename('../q3 "report"\u0007ü.csv')).toBe('q3 reportü.csv');
    expect(() => safeFilename('../..')).toThrow(/empty/);
  });
});

describe.each(['express', 'fastify'] as const)(
  'Live effects: %s',
  (platform) => {
    it('stores typed state as JSON and hydrates it for actions and computed values', async () => {
      const f = await fixture(platform);
      expect(f.html).toContain(
        '2026-01-02T03:04:05.000Z 9007199254740993 2026',
      );
      const bumped = await f.post('bump', 0);
      expect(bumped.status).toBe(201);
      const body = JSON.parse(bumped.text) as {
        state: Record<string, unknown>;
      };
      expect(body.state).toEqual({
        created: '2026-01-03T03:04:05.000Z',
        big: '9007199254740994',
      });
      const invalid = await f.post('_sync', 1, { created: 'not a date' });
      expect(invalid.status).toBe(422);
      expect(JSON.parse(invalid.text)).toMatchObject({ code: 'STATE_TYPE' });
      const synced = await f.post('_sync', 1, {
        created: '2030-05-06T07:08:09.000Z',
      });
      expect(synced.status).toBe(201);
      expect(JSON.parse(synced.text).html).toContain('2030');
    });

    it('serves a single-use attachment only to the same identity and persists flash', async () => {
      const f = await fixture(platform);
      const exported = await f.post('exportFile', 0);
      expect(exported.status).toBe(201);
      const body = JSON.parse(exported.text) as {
        download: { url: string; filename: string };
      };
      expect(body.download.filename).toBe('q3 reportü.csv');
      expect(body.download.url).toMatch(
        /^\/_nestvexa\/live\/report\/_download\/[A-Za-z0-9_-]{43}$/,
      );
      expect(f.session['nestvexa:flash']).toEqual(['Report exported']);
      const stolen = await send(f.base + body.download.url, 'GET', {
        'x-user': 'bob',
      });
      expect(stolen.status).toBe(404);
      const fetched = await send(f.base + body.download.url, 'GET', {});
      expect(fetched.status).toBe(200);
      expect(fetched.text).toBe('a,b\r\n1,2\r\n');
      expect(fetched.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(fetched.headers['content-disposition']).toBe(
        `attachment; filename="q3 report_.csv"; filename*=UTF-8''q3%20report%C3%BC.csv`,
      );
      expect(fetched.headers['x-content-type-options']).toBe('nosniff');
      expect(fetched.headers['cache-control']).toBe('no-store');
      expect(String(fetched.headers['content-security-policy'])).toContain(
        'sandbox',
      );
      const replay = await send(f.base + body.download.url, 'GET', {});
      expect(replay.status).toBe(404);
      const malformed = await send(
        f.base + '/_nestvexa/live/report/_download/short',
        'GET',
        {},
      );
      expect(malformed.status).toBe(404);
      expect(consumeLiveFlash({ session: f.session })).toEqual([
        'Report exported',
      ]);
      expect(consumeLiveFlash({ session: f.session })).toEqual([]);
    });

    it('rejects more than one download per action without leaking details', async () => {
      const f = await fixture(platform);
      const failed = await f.post('twoDownloads', 0);
      expect(failed.status).toBe(500);
      expect(failed.text).not.toContain('download');
    });
  },
);
