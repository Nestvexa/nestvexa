import 'reflect-metadata';
import { Injectable, Module, UnauthorizedException } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ActionGroup,
  ActionInput,
  ActionsModule,
  ServerAction,
} from '../packages/actions/dist/index.js';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import {
  Action,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  State,
} from '../packages/live/dist/index.js';
import {
  UploadsModule,
  configureUploads,
} from '../packages/uploads/dist/index.js';

// SEC-008: CORS posture. Nestvexa registers no CORS handling of its own, so by
// default no Live, action or upload route grants a cross-origin read and every
// state-changing route enforces its exact-origin check. That check is
// independent of CORS: even when a host turns on permissive credentialed CORS
// (a misconfiguration), cross-origin writes are still refused.

const origin = 'http://app.example.test';
const evil = 'https://evil.example';
const liveCsrf = 'cors-live-csrf-0123456789abcdefghijklmnop';
const actionCsrf = 'cors-action-csrf-0123456789abcdefghijklm';
const uploadCsrf = 'cors-upload-csrf-0123456789abcdefghijklm';
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('cors-test-png-body'),
]);

const effects = { live: 0, action: 0, uploadAuthorize: 0, actionAuthorize: 0 };

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}
function send(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string | Buffer,
): Promise<Reply> {
  return new Promise((done, reject) => {
    const outgoing = httpRequest(
      url,
      { method, headers: { connection: 'close', ...headers } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () =>
          done({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

function corsHeaders(reply: Reply): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(reply.headers).filter(([name]) =>
      name.startsWith('access-control-'),
    ),
  );
}

@LiveComponent({ name: 'cors-counter', view: 'cors-counter' })
class CorsCounter {
  @State() count = 0;
  @Action() increment(): void {
    effects.live++;
    this.count++;
  }
}

@Injectable()
@ActionGroup('cors')
class CorsActions {
  @ServerAction({ id: 'transfer' })
  transfer(@ActionInput() input: { amount: number }) {
    effects.action++;
    return { moved: input.amount };
  }
}

const resources: { app: INestApplication; root: string; engine: HbsEngine }[] =
  [];
afterEach(async () => {
  for (const { app, root, engine } of resources.splice(0)) {
    await app.close();
    await engine.dispose();
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep))
      throw new Error('Unexpected fixture directory');
    await rm(root, { recursive: true, force: true });
  }
});

async function start(platform: 'express' | 'fastify', hostCors?: 'permissive') {
  const root = await mkdtemp(join(tmpdir(), 'nestvexa-cors-'));
  await writeFile(join(root, 'cors-counter.hbs'), '<p>{{count}}</p>');
  const engine = new HbsEngine({ root });
  await engine.initialize();
  @Module({
    imports: [
      LiveModule.register({
        components: [CorsCounter],
        renderer: engine,
        origin,
        resolveIdentity: () => ({
          binding: 'cors/session/alice',
          csrfToken: liveCsrf,
        }),
        authorize: () => true,
      }),
      ActionsModule.register({
        groups: [CorsActions],
        origin,
        resolveIdentity: () => ({ subject: 'alice', csrfToken: actionCsrf }),
        authorize: () => {
          effects.actionAuthorize++;
          return true;
        },
      }),
      UploadsModule.register({
        origin,
        directory: join(root, 'uploads'),
        resolveIdentity(request: object) {
          const headers = Reflect.get(request, 'headers') as Record<
            string,
            string | undefined
          >;
          if (headers['x-test-user'] !== 'alice')
            throw new UnauthorizedException();
          return { binding: 'cors-user:alice:binding', csrfToken: uploadCsrf };
        },
        authorize: () => {
          effects.uploadAuthorize++;
          return true;
        },
        purposes: { images: { types: ['png'], maxFileSize: 64 * 1024 } },
      }),
    ],
  })
  class CorsApp {}
  const module = await Test.createTestingModule({
    imports: [CorsApp],
  }).compile();
  const app =
    platform === 'fastify'
      ? module.createNestApplication(new FastifyAdapter(), { logger: false })
      : module.createNestApplication({ logger: false });
  resources.push({ app, root, engine });
  if (hostCors === 'permissive')
    app.enableCors({ origin: true, credentials: true });
  await configureUploads(app);
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  const runtime = app.get(LiveRuntime);

  async function live(from: string | undefined): Promise<Reply> {
    const html = (await runtime.mount(CorsCounter, { headers: {} })).value;
    const snapshot = /data-nv-snapshot="([^"]+)"/.exec(html)?.[1] ?? '';
    return send(
      `${base}/_nestvexa/live/cors-counter/increment`,
      'POST',
      {
        ...(from === undefined ? {} : { origin: from }),
        'content-type': 'application/json',
        cookie: 'sid=victim-session',
        'x-nestvexa-csrf': liveCsrf,
      },
      JSON.stringify({
        protocol: 'nestvexa-live/1',
        requestId: randomUUID(),
        snapshot,
        revision: 0,
        updates: {},
        input: null,
      }),
    );
  }
  function action(from: string | undefined): Promise<Reply> {
    return send(
      `${base}/_nestvexa/actions/cors/transfer`,
      'POST',
      {
        ...(from === undefined ? {} : { origin: from }),
        'content-type': 'application/json',
        cookie: 'sid=victim-session',
        'x-nestvexa-csrf': actionCsrf,
      },
      JSON.stringify({ input: { amount: 100 } }),
    );
  }
  function upload(from: string | undefined): Promise<Reply> {
    return send(
      `${base}/_nestvexa/uploads/files`,
      'POST',
      {
        ...(from === undefined ? {} : { origin: from }),
        cookie: 'sid=victim-session',
        'x-test-user': 'alice',
        'x-nestvexa-csrf': uploadCsrf,
        'content-type': 'application/octet-stream',
        'content-length': String(PNG.byteLength),
        'x-nestvexa-upload-purpose': 'images',
        'x-nestvexa-upload-name': 'pixel.png',
      },
      PNG,
    );
  }
  function preflight(path: string, from: string): Promise<Reply> {
    return send(`${base}${path}`, 'OPTIONS', {
      origin: from,
      'access-control-request-method': 'POST',
      'access-control-request-headers':
        'content-type,x-nestvexa-csrf,x-nestvexa-upload-purpose',
    });
  }
  return { live, action, upload, preflight };
}

const routes = [
  '/_nestvexa/live/cors-counter/increment',
  '/_nestvexa/actions/cors/transfer',
  '/_nestvexa/uploads/files',
  '/_nestvexa/uploads/sessions',
];

describe.each(['express', 'fastify'] as const)(
  'CORS posture on %s',
  (platform) => {
    it('grants no cross-origin access by default: preflights get no CORS headers', async () => {
      const app = await start(platform);
      for (const path of routes)
        for (const from of [
          evil,
          'null',
          'http://app.example.test.evil.example',
        ])
          expect(corsHeaders(await app.preflight(path, from))).toEqual({});
    });

    it('refuses credentialed cross-origin writes before any handler or policy runs', async () => {
      const app = await start(platform);
      const before = { ...effects };
      for (const from of [
        evil,
        'null',
        'http://app.example.test.evil.example',
        'https://app.example.test',
        'http://app.example.test:8080',
        undefined,
      ]) {
        for (const reply of [
          await app.live(from),
          await app.action(from),
          await app.upload(from),
        ]) {
          expect(reply.status).toBe(403);
          expect(corsHeaders(reply)).toEqual({});
        }
      }
      expect(effects).toEqual(before);
      // Control: the identical same-origin requests succeed.
      expect((await app.live(origin)).status).toBe(201);
      expect((await app.action(origin)).status).toBe(200);
      expect((await app.upload(origin)).status).toBe(201);
      expect(effects.live).toBe(before.live + 1);
      expect(effects.action).toBe(before.action + 1);
    });

    it('still refuses cross-origin writes when the host enables permissive credentialed CORS', async () => {
      const app = await start(platform, 'permissive');
      // The host's (misconfigured) CORS layer is active: it reflects the origin.
      const preflight = await app.preflight(routes[0] ?? '', evil);
      expect(preflight.headers['access-control-allow-origin']).toBe(evil);
      expect(preflight.headers['access-control-allow-credentials']).toBe(
        'true',
      );
      const before = { ...effects };
      // Even with a stolen, valid CSRF token, the exact-origin check holds.
      for (const reply of [
        await app.live(evil),
        await app.action(evil),
        await app.upload(evil),
      ])
        expect(reply.status).toBe(403);
      expect(effects).toEqual(before);
    });
  },
);
