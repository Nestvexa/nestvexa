import 'reflect-metadata';
import { Controller, Get, Inject, Post, Put, Req } from '@nestjs/common';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  InertiaModule,
  InertiaPage,
  InertiaService,
  InertiaValidationException,
  defer,
  deepMerge,
  location,
  merge,
  once,
  redirect,
  scroll,
} from '../packages/inertia/dist/index.js';
import type { INestApplication } from '@nestjs/common';
import {
  Browser,
  boot,
  closeAll,
  cookieSessionAdapter,
  header,
  send,
} from './inertia-support.js';
import type { HttpResult, Platform } from './inertia-support.js';

interface Fixture {
  readonly name: string;
  readonly source: readonly string[];
  readonly app?: 'shared-keys';
  readonly serverVersion: string;
  readonly prime?: { readonly method: string; readonly path: string };
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
  };
  readonly response: {
    readonly status: number;
    readonly headers?: Readonly<Record<string, string>>;
    readonly headerPrefixes?: Readonly<Record<string, string>>;
    readonly absentHeaders?: readonly string[];
    readonly body?: string;
    readonly bodyIncludes?: string;
    readonly json?: unknown;
  };
}

const directory = join(import.meta.dirname, 'fixtures', 'inertia');
const fixtures: Fixture[] = await Promise.all(
  (await readdir(directory))
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map(
      async (file) =>
        JSON.parse(await readFile(join(directory, file), 'utf8')) as Fixture,
    ),
);

/** Records factories that must never run for the vector to be faithful. */
const forbidden: string[] = [];
const event = {
  id: 80,
  title: 'Birthday party',
  start_date: '2019-06-02',
  description: "Come out and celebrate Jonathan's 36th birthday party!",
};

@Controller()
class GoldenController {
  @Get('events/80')
  @InertiaPage('Event')
  show() {
    return { event };
  }

  @Get('events/80/encrypted')
  @InertiaPage('Event', { encryptHistory: true })
  encrypted() {
    return { event };
  }

  @Get('events')
  @InertiaPage('Events')
  events() {
    return {
      events: () => [{ id: 80, title: 'Birthday party' }],
      categories: () => {
        forbidden.push('categories');
        return ['music'];
      },
    };
  }

  @Get('posts')
  @InertiaPage('Posts/Index')
  posts() {
    const never = (name: string) => () => {
      forbidden.push(name);
      return name;
    };
    return {
      user: { name: 'Jonathan' },
      comments: defer(never('comments')),
      analytics: defer(never('analytics')),
      relatedPosts: defer(never('relatedPosts'), 'sidebar'),
    };
  }

  @Get('users')
  @InertiaPage('Users/Index')
  users() {
    return {
      permissions: defer(() => {
        throw new Error('permission backend unavailable');
      }).rescue(),
    };
  }

  @Get('feed')
  @InertiaPage('Feed/Index')
  feed() {
    return {
      user: { name: 'Jonathan' },
      posts: merge([{ id: 1, title: 'First Post' }]).matchOn('id'),
      notifications: merge([{ id: 2, message: 'New comment' }])
        .prepend()
        .matchOn('id'),
      conversations: deepMerge({
        data: [
          { id: 1, title: 'Support Chat', participants: ['John', 'Jane'] },
        ],
      }).matchOn('data.id'),
    };
  }

  @Get('billing/plans')
  @InertiaPage('Billing/Plans')
  plans() {
    return {
      plans: once(() => [
        { id: 1, name: 'Basic' },
        { id: 2, name: 'Pro' },
      ]),
    };
  }

  @Get('billing/upgrade')
  @InertiaPage('Billing/Upgrade')
  upgrade() {
    return {
      currentPlan: { id: 1, name: 'Basic' },
      plans: once(() => {
        forbidden.push('plans');
        return [];
      }),
    };
  }

  @Get('posts/scroll')
  @InertiaPage('Posts/Index')
  scroll() {
    return {
      posts: scroll(
        () => ({
          data: [
            { id: 1, title: 'First Post' },
            { id: 2, title: 'Second Post' },
          ],
        }),
        {
          metadata: {
            pageName: 'page',
            previousPage: null,
            nextPage: 2,
            currentPage: 1,
          },
        },
      ),
    };
  }

  @Put('users/1')
  update() {
    return redirect('/users');
  }

  @Get('billing/portal')
  portal() {
    return location('https://billing.example.com/portal');
  }

  @Post('action')
  action() {
    return redirect('/article#section');
  }

  @Get('action')
  actionGet() {
    return redirect('/article#section');
  }

  @Get('user/123')
  @InertiaPage('User/Edit')
  edit() {
    return {
      user: { name: 'Jonathan' },
      foo: merge({ data: [{ id: 1 }, { id: 2 }] }).append('data', 'id'),
      bar: merge({ data: { items: [{ uuid: 1 }, { uuid: 2 }] } }).prepend(
        'data.items',
        'uuid',
      ),
    };
  }

  @Post('users/invalid')
  invalid() {
    throw new InertiaValidationException({
      name: ['The name field is required.'],
      email: 'Not a valid email address.',
    });
  }

  @Get('users/create')
  @InertiaPage('Users/Create')
  create() {
    return {};
  }
}

@Controller()
class SharedKeysController {
  constructor(
    @Inject(InertiaService) private readonly inertia: InertiaService,
  ) {}

  @Post('users/clear')
  clear(@Req() request: object) {
    this.inertia.clearHistory(request);
    return redirect('/users');
  }

  @Get('users')
  @InertiaPage('User/Edit')
  edit() {
    return {};
  }
}

const versionFrom = (request: object): string => {
  const value = (request as { headers: Record<string, unknown> }).headers[
    'x-golden-server-version'
  ];
  return typeof value === 'string' ? value : '';
};

async function goldenApp(
  platform: Platform,
  variant: 'golden' | 'shared-keys',
) {
  const session =
    platform === 'fastify' ? { session: cookieSessionAdapter() } : {};
  return boot(
    platform,
    [
      InertiaModule.forRoot({
        version: versionFrom,
        rootView: (context) => context.body,
        exposeSharedPropKeys: variant === 'shared-keys',
        redirects: { allowedOrigins: ['https://billing.example.com'] },
        ...session,
      }),
    ],
    [variant === 'golden' ? GoldenController : SharedKeysController],
    { expressSession: platform === 'express' },
  );
}

function compare(fixture: Fixture, result: HttpResult): void {
  const expected = fixture.response;
  expect(result.status, fixture.name).toBe(expected.status);
  for (const [name, value] of Object.entries(expected.headers ?? {}))
    expect(header(result, name), `${fixture.name}: ${name}`).toBe(value);
  for (const [name, value] of Object.entries(expected.headerPrefixes ?? {}))
    expect(header(result, name) ?? '', `${fixture.name}: ${name}`).toMatch(
      new RegExp(`^${value.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}`),
    );
  for (const name of expected.absentHeaders ?? [])
    expect(
      header(result, name),
      `${fixture.name}: absent ${name}`,
    ).toBeUndefined();
  if (expected.body !== undefined) expect(result.body).toBe(expected.body);
  if (expected.bodyIncludes !== undefined)
    expect(result.body).toContain(expected.bodyIncludes);
  if (expected.json !== undefined)
    expect(JSON.parse(result.body)).toStrictEqual(expected.json);
}

describe.each(['express', 'fastify'] as const)(
  'Inertia v3 golden vectors on %s',
  (platform) => {
    const apps: Record<'golden' | 'shared-keys', INestApplication | undefined> =
      {
        golden: undefined,
        'shared-keys': undefined,
      };

    beforeAll(async () => {
      apps.golden = await goldenApp(platform, 'golden');
      apps['shared-keys'] = await goldenApp(platform, 'shared-keys');
    });
    afterAll(closeAll);

    it('loads every fixture with an upstream citation', () => {
      expect(fixtures.length).toBeGreaterThanOrEqual(17);
      for (const fixture of fixtures) {
        expect(fixture.source.length, fixture.name).toBeGreaterThan(0);
        expect(fixture.source.join(' '), fixture.name).toMatch(
          /inertiajs\.com\/docs\/v3|inertia-laravel v3\.6\.0|@inertiajs\/core 3\.10\.0/,
        );
      }
    });

    it.each(fixtures.map((fixture) => [fixture.name, fixture] as const))(
      '%s',
      async (_name, fixture) => {
        const app = apps[fixture.app ?? 'golden'];
        if (!app) throw new Error('Golden app did not start');
        forbidden.length = 0;
        const versionHeader = {
          'x-golden-server-version': fixture.serverVersion,
        };
        const browser = new Browser(app);
        const sid =
          platform === 'fastify'
            ? { cookie: `sid=golden${Math.random().toString(36).slice(2)}` }
            : {};
        if (fixture.prime) {
          const primed = await browser.send(fixture.prime.path, {
            method: fixture.prime.method,
            headers: { ...versionHeader, ...sid },
          });
          expect([302, 303]).toContain(primed.status);
        }
        const result = await browser.send(fixture.request.path, {
          method: fixture.request.method,
          headers: { ...fixture.request.headers, ...versionHeader, ...sid },
        });
        compare(fixture, result);
        expect(
          forbidden,
          `${fixture.name}: lazily excluded factories ran`,
        ).toStrictEqual([]);
      },
    );

    it('serves the same golden vector to independent requests', async () => {
      const app = apps.golden;
      if (!app) throw new Error('Golden app did not start');
      const [first, second] = await Promise.all([
        send(app, '/events/80'),
        send(app, '/events/80'),
      ]);
      expect(first.body).toBe(second.body);
    });
  },
);
