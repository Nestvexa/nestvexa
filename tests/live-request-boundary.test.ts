/**
 * PROT-008 request boundary over real HTTP on Express and Fastify: the
 * per-identity rate limit answers `429 RATE_LIMIT` with `Retry-After` and the
 * closed error body before any component code runs, and Live routes accept
 * POST only (other methods never reach a component).
 */
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Action,
  LiveComponent,
  LiveRuntime,
  NestvexaModule,
  State,
  configureNestvexa,
} from '../packages/nestvexa/dist/index.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const origin = 'http://127.0.0.1:3842';
const csrf = 'boundary-csrf-0123456789abcdefghijklmn';
const executions: string[] = [];

@LiveComponent({ name: 'boundary-probe', view: 'boundary-probe' })
class BoundaryProbe {
  @State() count = 0;
  @Action() increment(): void {
    executions.push('increment');
    this.count++;
  }
}

function header(request: object, name: string): string {
  const headers: unknown = Reflect.get(request, 'headers');
  const value: unknown =
    typeof headers === 'object' && headers !== null
      ? Reflect.get(headers, name)
      : undefined;
  return typeof value === 'string' ? value : 'anonymous';
}

/** Raw HTTP so HEAD/PATCH/DELETE bodies and headers are seen exactly. */
function send(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}> {
  return new Promise((resolvePromise, reject) => {
    const outgoing = httpRequest(url, { method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () =>
        resolvePromise({
          status: response.statusCode ?? 0,
          headers: response.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

describe.each(['express', 'fastify'] as const)(
  'Live request boundary: %s',
  (platform) => {
    async function start(maxRequestsPerMinute: number) {
      const root = await mkdtemp(join(tmpdir(), 'nestvexa-boundary-'));
      cleanup.push(async () => {
        if (dirname(resolve(root)) !== resolve(tmpdir()))
          throw new Error('Unsafe cleanup');
        await rm(root, { recursive: true, force: true });
      });
      await writeFile(join(root, 'boundary-probe.hbs'), '<p>{{count}}</p>');
      const module = await Test.createTestingModule({
        imports: [
          NestvexaModule.forRoot(
            { views: { root }, live: { enabled: true } },
            {
              components: [BoundaryProbe],
              useFactory: () => ({
                origin,
                maxRequestsPerMinute,
                // One binding per test user: limits are per identity.
                resolveIdentity: (request: object) => ({
                  binding: `boundary-session-${header(request, 'x-user')}`,
                  csrfToken: csrf,
                }),
                authorize: () => true,
              }),
            },
          ),
        ],
      }).compile();
      const app: INestApplication =
        platform === 'fastify'
          ? module.createNestApplication(new FastifyAdapter(), {
              logger: false,
            })
          : module.createNestApplication({ logger: false });
      await configureNestvexa(app);
      await app.listen(0, '127.0.0.1');
      cleanup.push(() => app.close());
      const base = await app.getUrl();
      const mount = async (user: string) => {
        const html = (
          await app
            .get(LiveRuntime)
            .mount(BoundaryProbe, { headers: { 'x-user': user } })
        ).value;
        return /data-nv-snapshot="([^"]+)"/.exec(html)?.[1] ?? '';
      };
      const post = (user: string, snapshot: string, path = 'increment') =>
        send(
          `${base}/_nestvexa/live/boundary-probe/${path}`,
          'POST',
          {
            origin,
            'content-type': 'application/json',
            'x-nestvexa-csrf': csrf,
            'x-user': user,
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
      return { base, mount, post };
    }

    it('answers 429 RATE_LIMIT with Retry-After before running the component', async () => {
      const { mount, post } = await start(2);
      executions.length = 0;
      // The mount and the first action use the budget of 2 for this identity.
      const snapshot = await mount('alice');
      const first = await post('alice', snapshot);
      expect(first.status).toBe(201);
      expect(executions).toEqual(['increment']);
      // Same stale envelope: rate limiting happens before state is read.
      const limited = await post('alice', snapshot);
      expect(limited.status).toBe(429);
      expect(JSON.parse(limited.text)).toEqual({
        statusCode: 429,
        code: 'RATE_LIMIT',
      });
      expect(String(limited.headers['content-type'])).toMatch(
        /^application\/json/,
      );
      const retryAfter = Number(limited.headers['retry-after']);
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(60);
      expect(limited.text).not.toContain(csrf);
      expect(limited.text).not.toContain('boundary-session');
      expect(executions).toEqual(['increment']);
      // The internal synchronization route shares the same budget.
      expect((await post('alice', snapshot, '_sync')).status).toBe(429);
      expect(executions).toEqual(['increment']);
      // Another identity keeps its own budget.
      const other = await post('bob', await mount('bob'));
      expect(other.status).toBe(201);
      expect(executions).toEqual(['increment', 'increment']);
    });

    it('rejects non-POST methods on Live routes without running the component', async () => {
      const { base, mount } = await start(1_000);
      const snapshot = await mount('carol');
      executions.length = 0;
      const body = JSON.stringify({
        protocol: 'nestvexa-live/1',
        requestId: randomUUID(),
        snapshot,
        revision: 0,
        updates: {},
        input: null,
      });
      const headers = {
        origin,
        'content-type': 'application/json',
        'x-nestvexa-csrf': csrf,
        'x-user': 'carol',
      };
      // Bodiless requests: an unread body would let either server close the
      // socket early, and Fastify rejects an empty JSON body with 400 before
      // routing. The method alone must already be refused.
      const bodiless = {
        origin,
        'x-nestvexa-csrf': csrf,
        'x-user': 'carol',
        'content-length': '0',
      };
      for (const path of ['increment', '_sync'])
        for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE']) {
          const reply = await send(
            `${base}/_nestvexa/live/boundary-probe/${path}`,
            method,
            bodiless,
          );
          expect(reply.status, `${method} ${path}`).toBe(404);
          expect(reply.text).not.toContain('data-nv-snapshot');
          expect(reply.headers['x-nestvexa-protocol']).toBeUndefined();
        }
      // The download route is GET-only; POST does not reach it.
      expect(
        (
          await send(
            `${base}/_nestvexa/live/boundary-probe/_download/${'a'.repeat(43)}`,
            'POST',
            headers,
            body,
          )
        ).status,
      ).toBe(404);
      expect(executions).toEqual([]);
    });
  },
);
