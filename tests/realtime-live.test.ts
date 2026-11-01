import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import {
  Action,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  RealtimeChannels,
  State,
} from '../packages/live/dist/index.js';
import { definition } from '../packages/live/dist/metadata.js';
import { parseLiveResponse } from '../packages/client/dist/index.js';
import { createTokenSigner } from '../packages/realtime/dist/index.js';

const origin = 'http://localhost:3100';
const csrf = 'realtime-live-csrf-012345678901234567890';
const binding = 'tenant/session/alice';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
});

describe('@RealtimeChannels metadata', () => {
  it('requires one zero-argument method', () => {
    expect(() =>
      RealtimeChannels()({}, 'channels', { value: (value: unknown) => value }),
    ).toThrow(/zero-argument/);
    @LiveComponent({ name: 'rt-ok', view: 'v' })
    class Ok {
      @RealtimeChannels() channels(): string[] {
        return ['a'];
      }
    }
    expect(definition(Ok).realtime).toBe('channels');
  });
});

describe('Live realtime tokens', () => {
  it('signs declared channels at mount and on every response; omits unauthorized channels', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nestvexa-rt-live-'));
    await writeFile(join(root, 'feed.hbs'), '<p>{{count}}</p>');
    const renderer = new HbsEngine({ root });
    await renderer.initialize();
    const signer = createTokenSigner({
      secrets: ['live-realtime-secret-0123456789abcdefgh'],
    });
    const signed: string[][] = [];
    @LiveComponent({ name: 'feed', view: 'feed' })
    class Feed {
      @State() count = 0;
      @State() room = 'public';
      @RealtimeChannels() async channels(): Promise<string[]> {
        return [`room:${this.room}`];
      }
      @Action() leave(): void {
        this.room = 'forbidden';
        this.count++;
      }
    }
    const module = await Test.createTestingModule({
      imports: [
        LiveModule.register({
          components: [Feed],
          renderer,
          origin,
          resolveIdentity: () => ({ binding, csrfToken: csrf }),
          authorize: () => true,
          realtime: {
            sign: (identity, channels) => {
              signed.push([...channels]);
              const allowed = channels.filter(
                (channel) => channel !== 'room:forbidden',
              );
              return allowed.length
                ? signer.sign(identity.binding, allowed)
                : undefined;
            },
          },
        }),
      ],
    }).compile();
    const app: INestApplication = module.createNestApplication({
      logger: false,
    });
    await app.listen(0, '127.0.0.1');
    cleanup.push(async () => {
      await app.close();
      await renderer.dispose();
      await rm(root, { recursive: true, force: true });
    });
    const html = (await app.get(LiveRuntime).mount(Feed, { headers: {} }))
      .value;
    const token = /data-nv-realtime="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(signer.verify(token, binding).channels).toEqual(['room:public']);
    const snapshot = /data-nv-snapshot="([^"]+)"/.exec(html)?.[1] ?? '';
    const base = await app.getUrl();
    const response = await new Promise<string>((resolve, reject) => {
      const request = httpRequest(
        `${base}/_nestvexa/live/feed/leave`,
        {
          method: 'POST',
          headers: {
            origin,
            'content-type': 'application/json',
            'x-nestvexa-csrf': csrf,
          },
        },
        (reply) => {
          let body = '';
          reply.on('data', (chunk: Buffer) => (body += chunk.toString()));
          reply.on('end', () => resolve(body));
        },
      );
      request.on('error', reject);
      request.end(
        JSON.stringify({
          protocol: 'nestvexa-live/1',
          requestId: randomUUID(),
          snapshot,
          revision: 0,
          updates: {},
          input: null,
        }),
      );
    });
    const body = JSON.parse(response) as Record<string, unknown>;
    expect(body).not.toHaveProperty('realtime');
    expect(signed).toEqual([['room:public'], ['room:forbidden']]);
  });

  it('validates realtime tokens in client responses', () => {
    const envelope = {
      protocol: 'nestvexa-live/1',
      requestId: 'r',
      component: { id: 'c', name: 'feed', revision: 1 },
      snapshot: 's',
      state: {},
      html: '',
    };
    const token = 'eyJjIjpbImEiXX0.' + 'A'.repeat(43);
    expect(parseLiveResponse({ ...envelope, realtime: token }).realtime).toBe(
      token,
    );
    for (const bad of ['', 'no-dot', 'a.b', 7, `${token}.extra`])
      expect(() => parseLiveResponse({ ...envelope, realtime: bad })).toThrow();
  });
});
