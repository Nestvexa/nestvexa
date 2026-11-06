import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import {
  Action,
  DateSynthesizer,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  State,
  checkWritablePaths,
  describeLiveState,
  parseWritablePaths,
} from '../packages/live/dist/index.js';
import type { JsonValue } from '../packages/live/dist/index.js';
import {
  application,
  cleanup,
  envelope,
  marker,
  platforms,
  policies,
  renderer,
  send,
} from './support/live-fixture.js';

afterEach(cleanup);

describe('nested writable path allowlist grammar', () => {
  it('accepts identifier paths and freezes the copy', () => {
    const paths = parseWritablePaths(['city', 'geo.lat', 'geo.lng']);
    expect(paths).toEqual(['city', 'geo.lat', 'geo.lng']);
    expect(Object.isFrozen(paths)).toBe(true);
  });
  it.each([
    [[]],
    ['city'],
    [[1]],
    [['']],
    [['a..b']],
    [['items.0']],
    [['a.*']],
    [['__proto__']],
    [['geo.constructor']],
    [['a.prototype.b']],
    [['a b']],
    [['a-b']],
    [['a.b.c.d.e.f.g.h.i']],
    [['city', 'city']],
    [['geo', 'geo.lat']],
    [['geo.lat', 'geo']],
    [Array.from({ length: 65 }, (_, index) => `f${index}`)],
  ])('rejects %j', (value) => {
    expect(() => parseWritablePaths(value)).toThrow();
  });
  it('rejects writable paths combined with a synthesizer', () => {
    expect(() =>
      State({ writable: ['day'], synthesizer: DateSynthesizer }),
    ).toThrow('cannot be combined with a synthesizer');
  });
  it('permits validate callbacks on path-restricted fields', () => {
    expect(() =>
      State({ writable: ['city'], validate: () => true }),
    ).not.toThrow();
  });
});

describe('nested writable path comparison', () => {
  const stored: JsonValue = {
    city: 'Cairo',
    zip: '11511',
    geo: { lat: 30, lng: 31, label: 'pin' },
    tags: ['a'],
    role: 'member',
  };
  const paths = ['city', 'geo.lat', 'geo.lng', 'tags'];
  const change = (patch: (value: Record<string, unknown>) => void) => {
    const next = structuredClone(stored) as Record<string, unknown>;
    patch(next);
    return next as JsonValue;
  };
  it.each([
    ['unchanged value', change(() => undefined), 'ok'],
    [
      'allowed leaf',
      change((v) => {
        v['city'] = 'Giza';
      }),
      'ok',
    ],
    [
      'allowed nested leaves',
      change((v) => {
        v['geo'] = { lat: 1, lng: 2, label: 'pin' };
      }),
      'ok',
    ],
    [
      'allowed array leaf',
      change((v) => {
        v['tags'] = ['a', 'b'];
      }),
      'ok',
    ],
    [
      'locked sibling',
      change((v) => {
        v['role'] = 'admin';
      }),
      'locked',
    ],
    [
      'locked nested sibling',
      change((v) => {
        v['geo'] = { lat: 30, lng: 31, label: 'moved' };
      }),
      'locked',
    ],
    [
      'added key',
      change((v) => {
        v['admin'] = true;
      }),
      'locked',
    ],
    [
      'removed key',
      change((v) => {
        delete v['zip'];
      }),
      'locked',
    ],
    [
      'added nested key',
      change((v) => {
        v['geo'] = { lat: 30, lng: 31, label: 'pin', extra: 1 };
      }),
      'locked',
    ],
    [
      'parent replaced by scalar',
      change((v) => {
        v['geo'] = 'nowhere';
      }),
      'locked',
    ],
    [
      'allowed leaf kind change',
      change((v) => {
        v['city'] = 7;
      }),
      'type',
    ],
    [
      'allowed leaf to null',
      change((v) => {
        v['city'] = null;
      }),
      'type',
    ],
    [
      'allowed array leaf to object',
      change((v) => {
        v['tags'] = { 0: 'a' };
      }),
      'type',
    ],
  ])('%s', (_name, next, verdict) => {
    expect(checkWritablePaths(stored, next, paths)).toBe(verdict);
  });
});

@LiveComponent({ name: 'profile-paths', view: 'profile' })
class Profile {
  @State({ writable: ['city', 'geo.lat', 'tags'] })
  address = {
    city: 'Cairo',
    zip: '11511',
    geo: { lat: 30, lng: 31 },
    tags: ['home'],
  };
  @State({
    writable: ['nickname'],
    validate: (value) =>
      !!value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof value['nickname'] === 'string' &&
      value['nickname'].length <= 8,
  })
  account = { nickname: 'eve', role: 'member' };
  @State() actions = 0;
  @Action()
  touch(): void {
    this.actions++;
  }
}

@Controller()
class Pages {
  constructor(@Inject(LiveRuntime) private readonly live: LiveRuntime) {}
  @Get('profile')
  async profile(@Req() req: object) {
    return { html: (await this.live.mount(Profile, req)).value };
  }
}

async function boot(platform: (typeof platforms)[number]) {
  const env = await renderer({
    profile:
      '<p>{{address.city}}|{{address.zip}}|{{address.geo.lat}}|{{account.nickname}}|{{account.role}}</p>',
  });
  return application(
    platform,
    [
      LiveModule.registerAsync({
        components: [Profile],
        imports: [env.module],
        useFactory: () => policies(env.engine),
      }),
    ],
    [Pages],
    env.resource,
  );
}
async function reference(app: INestApplication) {
  const page = await send(app, '/profile');
  const html = page.json()['html'];
  if (typeof html !== 'string') throw new Error('Missing mount HTML');
  return marker(html);
}
const baseAddress = () => ({
  city: 'Cairo',
  zip: '11511',
  geo: { lat: 30, lng: 31 },
  tags: ['home'],
});

it('describes path-restricted fields for integrations', () => {
  const description = describeLiveState(new Profile(), 'address');
  expect(description).toEqual({
    writable: true,
    writablePaths: ['city', 'geo.lat', 'tags'],
    synthesized: false,
  });
  expect(describeLiveState(new Profile(), 'actions')).toEqual({
    writable: false,
    synthesized: false,
  });
});

describe.each(platforms)('nested writable paths over %s', (platform) => {
  it('applies allowlisted nested leaves through $sync and actions', async () => {
    const app = await boot(platform);
    const ref = await reference(app);
    const synced = await send(
      app,
      '/_nestvexa/live/profile-paths/_sync',
      envelope(ref, {
        updates: {
          address: {
            ...baseAddress(),
            city: 'Giza',
            geo: { lat: 29.9, lng: 31 },
            tags: ['home', 'work'],
          },
        },
      }),
    );
    expect(synced.status).toBe(201);
    const body = synced.json();
    expect(body['html']).toContain('Giza|11511|29.9|eve|member');
    const next = {
      snapshot: String(body['snapshot']),
      revision: ref.revision + 1,
    };
    const acted = await send(
      app,
      '/_nestvexa/live/profile-paths/touch',
      envelope(next, {
        updates: { account: { nickname: 'evie', role: 'member' } },
      }),
    );
    expect(acted.status).toBe(201);
    expect(acted.json()['html']).toContain('Giza|11511|29.9|evie|member');
  }, 60_000);

  it.each([
    [
      'locked sibling',
      { address: { ...baseAddress(), zip: '00000' } },
      422,
      'STATE_LOCKED',
    ],
    [
      'locked nested sibling',
      { address: { ...baseAddress(), geo: { lat: 30, lng: 0 } } },
      422,
      'STATE_LOCKED',
    ],
    [
      'injected key',
      { address: { ...baseAddress(), admin: true } },
      422,
      'STATE_LOCKED',
    ],
    [
      'removed key',
      { address: { city: 'Giza', geo: { lat: 30, lng: 31 }, tags: ['home'] } },
      422,
      'STATE_LOCKED',
    ],
    [
      'allowed leaf kind change',
      { address: { ...baseAddress(), city: 1 } },
      422,
      'STATE_TYPE',
    ],
    ['whole field kind change', { address: 'Giza' }, 422, 'STATE_TYPE'],
    [
      'role escalation',
      { account: { nickname: 'eve', role: 'admin' } },
      422,
      'STATE_LOCKED',
    ],
    [
      'validate callback still runs',
      { account: { nickname: 'much-too-long', role: 'member' } },
      422,
      'STATE_INVALID',
    ],
    ['read-only field', { actions: 5 }, 422, 'STATE_LOCKED'],
  ])(
    'rejects %s before component code runs',
    async (_name, updates, status, code) => {
      const app = await boot(platform);
      const ref = await reference(app);
      const reply = await send(
        app,
        '/_nestvexa/live/profile-paths/touch',
        envelope(ref, { updates }),
      );
      expect(reply.status).toBe(status);
      expect(reply.json()['code']).toBe(code);
      // The rejected request consumed nothing: the same revision still works.
      const retry = await send(
        app,
        '/_nestvexa/live/profile-paths/touch',
        envelope(ref),
      );
      expect(retry.status).toBe(201);
      expect(retry.json()['state']).toMatchObject({
        actions: 1,
        address: baseAddress(),
        account: { nickname: 'eve', role: 'member' },
      });
    },
  );
});
