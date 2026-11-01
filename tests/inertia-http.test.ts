import 'reflect-metadata';
import {
  Body,
  Catch,
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Patch,
  Post,
  Put,
  Req,
  Res,
  UseFilters,
} from '@nestjs/common';
import type {
  ArgumentsHost,
  ExceptionFilter,
  PipeTransform,
} from '@nestjs/common';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import {
  HttpSsrGateway,
  InertiaModule,
  InertiaPage,
  InertiaService,
  InertiaSsrError,
  UseInertia,
  always,
  back,
  defer,
  inertia,
  inertiaValidationExceptionFactory,
  merge,
  once,
  optional,
  redirect,
  scroll,
  viewRootView,
} from '../packages/inertia/dist/index.js';
import type { INestApplication } from '@nestjs/common';
import {
  boot,
  browser,
  closeAll,
  header,
  htmlPage,
  inertiaHeaders,
  json,
  send,
  sessionOption,
} from './inertia-support.js';
import type { Platform } from './inertia-support.js';

const calls: Record<string, number> = {};
const count = (name: string) => {
  calls[name] = (calls[name] ?? 0) + 1;
};
const reset = () => {
  for (const key of Object.keys(calls)) delete calls[key];
};

let clock = 1_800_000_000_000;
const moduleOnce = once(() => {
  count('moduleOnce');
  return ['shared', 'once'];
});

@Injectable()
class ValidateUser implements PipeTransform<unknown> {
  transform(value: unknown): unknown {
    const body = (
      typeof value === 'object' && value !== null ? value : {}
    ) as Record<string, unknown>;
    const name = body['name'];
    const errors = [];
    if (typeof name !== 'string' || name.trim() === '')
      errors.push({
        property: 'name',
        constraints: {
          isNotEmpty: 'The name field is required.',
          minLength: 'Too short.',
        },
      });
    if (body['address'] !== undefined)
      errors.push({
        property: 'address',
        children: [
          {
            property: 'city',
            constraints: { isNotEmpty: 'City is required.' },
          },
        ],
      });
    if (errors.length) throw inertiaValidationExceptionFactory(errors);
    return value;
  }
}

@Controller()
class FeatureController {
  constructor(
    @Inject(InertiaService) private readonly inertia: InertiaService,
  ) {}

  @Get('lazy')
  @InertiaPage('Lazy')
  lazy() {
    return {
      regular: () => {
        count('regular');
        return 'regular';
      },
      eager: 'eager',
      optional: optional(() => {
        count('optional');
        return 'optional';
      }),
      deferred: defer(async () => {
        count('deferred');
        return 'deferred';
      }, 'group'),
      always: always(() => {
        count('always');
        return 'always';
      }),
      account: {
        user: () => {
          count('account.user');
          return { name: 'Ada' };
        },
        permissions: () => {
          count('account.permissions');
          return ['admin'];
        },
      },
    };
  }

  @Get('feed')
  @InertiaPage('Feed')
  feed() {
    return {
      items: merge(() => [{ id: 1 }]).matchOn('id'),
      list: scroll(() => ({ data: [{ id: 3 }] }), {
        wrapper: 'data',
        metadata: (value: { data: unknown[] }) => ({
          pageName: 'page',
          previousPage: 1,
          nextPage: value.data.length ? 3 : null,
          currentPage: 2,
        }),
      }),
      later: scroll(() => ({ data: [] }), {
        metadata: {
          pageName: 'p',
          previousPage: null,
          nextPage: null,
          currentPage: 1,
        },
      }).defer('scroll'),
    };
  }

  @Get('once')
  @InertiaPage('Once')
  once() {
    return {
      rates: once(() => {
        count('rates');
        return [1, 2];
      }).until(60),
      roles: once(() => {
        count('roles');
        return ['owner'];
      }).as('roleList'),
      fresh: once(() => {
        count('fresh');
        return 'fresh';
      }).fresh(),
      expires: once(() => 'x').until(new Date(1_900_000_000_000)),
      stats: defer(() => {
        count('stats');
        return { visits: 3 };
      }).once(),
      moduleOnce,
    };
  }

  @Get('dates')
  @InertiaPage('Dates', { preserveBigIntegers: true })
  dates() {
    return {
      when: new Date(Date.UTC(2026, 10, 1, 12)),
      big: 900719925474099988n,
      small: 7,
    };
  }

  @Get('page/:id')
  page(@Req() request: object) {
    this.inertia.share(request, 'requestShared', 'from-request');
    return inertia('Page', { id: 'p' }, { flash: { highlight: 1 } });
  }

  @Post('flash')
  flash(@Req() request: object) {
    this.inertia.flash(request, 'message', 'Saved!');
    this.inertia.flash(request, { newUserId: 7 });
    return redirect('/page/1');
  }

  @Post('fragment')
  fragment() {
    return redirect('/page/2', { preserveFragment: true });
  }

  @Post('users')
  store(@Body(ValidateUser) body: { name: string }) {
    return redirect(`/users/create?created=${encodeURIComponent(body.name)}`);
  }

  @Put('users/1')
  update(@Body(ValidateUser) body: { name: string }) {
    return back({ fallback: `/users/${encodeURIComponent(body.name)}` });
  }

  @Patch('users/1')
  patch() {
    return redirect('/users/create', { status: 301 });
  }

  @Get('users/create')
  @InertiaPage('Users/Create')
  create() {
    return {};
  }

  @Get('imperative')
  async imperative(@Req() request: object, @Res() response: object) {
    await this.inertia.render(
      request,
      response,
      'Imperative',
      { ok: true },
      { status: 202 },
    );
  }
}

@Catch(NotFoundException)
class InertiaNotFoundFilter implements ExceptionFilter<NotFoundException> {
  constructor(
    @Inject(InertiaService) private readonly inertia: InertiaService,
  ) {}
  async catch(_error: NotFoundException, host: ArgumentsHost) {
    const http = host.switchToHttp();
    await this.inertia.render(
      http.getRequest<object>(),
      http.getResponse<object>(),
      'Error',
      { status: 404 },
      { status: 404 },
    );
  }
}

@Controller('errors')
class ErrorController {
  @Get('plain')
  @InertiaPage('Never')
  plain() {
    throw new NotFoundException();
  }

  @Get('page')
  @UseFilters(InertiaNotFoundFilter)
  @InertiaPage('Never')
  page() {
    throw new NotFoundException();
  }
}

async function featureApp(
  platform: Platform,
  extra: Record<string, unknown> = {},
) {
  return boot(
    platform,
    [
      InertiaModule.forRoot({
        version: 'v1',
        title: (page) => `Nestvexa ${page.component}`,
        entry: { scripts: ['/build/app.js'], styles: ['/build/app.css'] },
        nonce: () => 'n0nce',
        share: (request) => {
          count('share');
          const user = (request as { headers: Record<string, unknown> })
            .headers['x-user'];
          return {
            appName: 'Demo',
            'auth.user': typeof user === 'string' ? { name: user } : null,
          };
        },
        now: () => clock,
        onRescue: () => count('rescue'),
        ...sessionOption(platform),
        ...extra,
      }),
    ],
    [FeatureController, ErrorController],
    { expressSession: platform === 'express' },
  );
}

describe.each(['express', 'fastify'] as const)(
  'Inertia HTTP behaviour on %s',
  (platform) => {
    let app: INestApplication;
    beforeAll(async () => {
      app = await featureApp(platform);
    });
    afterAll(closeAll);
    afterEach(reset);

    it('renders a complete HTML document for the initial visit', async () => {
      const result = await send(app, '/lazy');
      expect(result.status).toBe(200);
      expect(header(result, 'content-type')).toMatch(/^text\/html/);
      expect(header(result, 'vary')).toContain('X-Inertia');
      expect(result.body).toMatch(
        /^<!doctype html><html lang="en"><head><meta charset="utf-8">/,
      );
      expect(result.body).toContain('<title>Nestvexa Lazy</title>');
      expect(result.body).toContain(
        '<link rel="stylesheet" href="/build/app.css">',
      );
      expect(result.body).toContain(
        '<script type="module" src="/build/app.js" nonce="n0nce"></script>',
      );
      expect(result.body).toContain('<div id="app"></div></body></html>');
      const page = htmlPage(result);
      expect(page['component']).toBe('Lazy');
      expect(page['version']).toBe('v1');
      expect(page['sharedProps']).toStrictEqual(['errors', 'appName', 'auth']);
    });

    it('evaluates regular props, never optional or deferred props, on a full visit', async () => {
      const page = json(
        await send(app, '/lazy', { headers: inertiaHeaders('v1') }),
      );
      expect(page['props']).toStrictEqual({
        errors: {},
        appName: 'Demo',
        auth: { user: null },
        account: { user: { name: 'Ada' }, permissions: ['admin'] },
        regular: 'regular',
        eager: 'eager',
        always: 'always',
      });
      expect(page['deferredProps']).toStrictEqual({ group: ['deferred'] });
      expect(calls).toStrictEqual({
        share: 1,
        regular: 1,
        always: 1,
        'account.user': 1,
        'account.permissions': 1,
      });
    });

    it('evaluates only selected props on a partial reload (plus always props)', async () => {
      const result = await send(app, '/lazy', {
        headers: {
          ...inertiaHeaders('v1'),
          'x-inertia-partial-component': 'Lazy',
          'x-inertia-partial-data': 'deferred,optional',
        },
      });
      const page = json(result);
      expect(page['props']).toStrictEqual({
        errors: {},
        optional: 'optional',
        deferred: 'deferred',
        always: 'always',
      });
      expect(page).not.toHaveProperty('deferredProps');
      expect(calls).toStrictEqual({
        share: 1,
        optional: 1,
        deferred: 1,
        always: 1,
      });
    });

    it('supports nested dot paths and except lists, always props ignore except', async () => {
      const page = json(
        await send(app, '/lazy', {
          headers: {
            ...inertiaHeaders('v1'),
            'x-inertia-partial-component': 'Lazy',
            'x-inertia-partial-data': 'account.user,always,regular',
            'x-inertia-partial-except': 'regular,always',
          },
        }),
      );
      expect(page['props']).toStrictEqual({
        errors: {},
        account: { user: { name: 'Ada' } },
        always: 'always',
      });
      expect(calls['account.permissions']).toBeUndefined();
      expect(calls['regular']).toBeUndefined();
    });

    it('ignores partial headers for another component and for non-Inertia requests', async () => {
      const mismatch = json(
        await send(app, '/lazy', {
          headers: {
            ...inertiaHeaders('v1'),
            'x-inertia-partial-component': 'Other',
            'x-inertia-partial-data': 'optional',
          },
        }),
      );
      expect(Object.keys(mismatch['props'] as object)).toContain('regular');
      expect(mismatch['props']).not.toHaveProperty('optional');
      const html = htmlPage(
        await send(app, '/lazy', {
          headers: {
            'x-inertia-partial-component': 'Lazy',
            'x-inertia-partial-data': 'optional',
          },
        }),
      );
      expect(html['props']).not.toHaveProperty('optional');
      expect(html['props']).toHaveProperty('regular', 'regular');
    });

    it('emits merge, scroll and deferred-scroll metadata and honours reset and merge intent', async () => {
      const full = json(
        await send(app, '/feed', { headers: inertiaHeaders('v1') }),
      );
      expect(full['mergeProps']).toStrictEqual([
        'items',
        'list.data',
        'later.data',
      ]);
      expect(full['matchPropsOn']).toStrictEqual(['items.id']);
      expect(full['deferredProps']).toStrictEqual({ scroll: ['later'] });
      expect(full['scrollProps']).toStrictEqual({
        list: {
          pageName: 'page',
          previousPage: 1,
          nextPage: 3,
          currentPage: 2,
          reset: false,
        },
      });
      const prepend = json(
        await send(app, '/feed', {
          headers: {
            ...inertiaHeaders('v1'),
            'x-inertia-partial-component': 'Feed',
            'x-inertia-partial-data': 'list',
            'x-inertia-infinite-scroll-merge-intent': 'prepend',
          },
        }),
      );
      expect(prepend['prependProps']).toStrictEqual(['list.data']);
      expect(prepend).not.toHaveProperty('mergeProps');
      const resetPage = json(
        await send(app, '/feed', {
          headers: {
            ...inertiaHeaders('v1'),
            'x-inertia-partial-component': 'Feed',
            'x-inertia-partial-data': 'list,items',
            'x-inertia-reset': 'list,items',
          },
        }),
      );
      expect(resetPage).not.toHaveProperty('mergeProps');
      expect(resetPage).not.toHaveProperty('matchPropsOn');
      expect(
        (resetPage['scrollProps'] as Record<string, { reset: boolean }>)['list']
          ?.reset,
      ).toBe(true);
      // A follow-up append visit is not affected by the earlier prepend intent.
      const again = json(
        await send(app, '/feed', { headers: inertiaHeaders('v1') }),
      );
      expect(again['mergeProps']).toStrictEqual([
        'items',
        'list.data',
        'later.data',
      ]);
    });

    it('describes once props with keys and expiry and skips them when the client holds them', async () => {
      clock = 1_800_000_000_000;
      const first = json(
        await send(app, '/once', { headers: inertiaHeaders('v1') }),
      );
      expect(first['onceProps']).toStrictEqual({
        rates: { prop: 'rates', expiresAt: 1_800_000_060_000 },
        roleList: { prop: 'roles', expiresAt: null },
        fresh: { prop: 'fresh', expiresAt: null },
        expires: { prop: 'expires', expiresAt: 1_900_000_000_000 },
        stats: { prop: 'stats', expiresAt: null },
        moduleOnce: { prop: 'moduleOnce', expiresAt: null },
      });
      expect(first['deferredProps']).toStrictEqual({ default: ['stats'] });
      expect(calls).toMatchObject({
        rates: 1,
        roles: 1,
        fresh: 1,
        moduleOnce: 1,
      });
      expect(calls['stats']).toBeUndefined();
      reset();
      const next = json(
        await send(app, '/once', {
          headers: {
            ...inertiaHeaders('v1'),
            'x-inertia-except-once-props':
              'rates,roleList,fresh,stats,moduleOnce',
          },
        }),
      );
      expect(Object.keys(next['props'] as object).sort()).toStrictEqual([
        'appName',
        'auth',
        'errors',
        'expires',
        'fresh',
      ]);
      expect(next).not.toHaveProperty('deferredProps');
      expect(calls).toStrictEqual({ share: 1, fresh: 1 });
      reset();
      const partial = json(
        await send(app, '/once', {
          headers: {
            ...inertiaHeaders('v1'),
            'x-inertia-partial-component': 'Once',
            'x-inertia-partial-data': 'rates',
            'x-inertia-except-once-props': 'rates',
          },
        }),
      );
      expect(partial['props']).toStrictEqual({ errors: {}, rates: [1, 2] });
      expect(partial['onceProps']).toStrictEqual({
        rates: { prop: 'rates', expiresAt: 1_800_000_060_000 },
      });
    });

    it('serializes Dates as ISO strings and bigint with the upstream marker when enabled', async () => {
      const page = json(
        await send(app, '/dates', { headers: inertiaHeaders('v1') }),
      );
      expect(page['props']).toStrictEqual({
        errors: {},
        appName: 'Demo',
        auth: { user: null },
        when: '2026-11-01T12:00:00.000Z',
        big: { $bigint: '900719925474099988' },
        small: 7,
      });
      expect(page['preserveBigIntegers']).toBe(true);
    });

    it('flashes data across a redirect exactly once', async () => {
      const client = browser(app, platform);
      const redirected = await client.send('/flash', {
        method: 'POST',
        headers: inertiaHeaders('v1'),
      });
      expect(redirected.status).toBe(302);
      expect(header(redirected, 'location')).toBe('/page/1');
      const page = json(
        await client.send('/page/1', { headers: inertiaHeaders('v1') }),
      );
      expect(page['flash']).toStrictEqual({
        message: 'Saved!',
        newUserId: 7,
        highlight: 1,
      });
      expect((page['props'] as Record<string, unknown>)['requestShared']).toBe(
        'from-request',
      );
      const again = json(
        await client.send('/page/1', { headers: inertiaHeaders('v1') }),
      );
      expect(again['flash']).toStrictEqual({ highlight: 1 });
    });

    it('keeps flash data through a version-mismatch 409 for the follow-up visit', async () => {
      const client = browser(app, platform);
      await client.send('/flash', {
        method: 'POST',
        headers: inertiaHeaders('v1'),
      });
      const conflict = await client.send('/page/1', {
        headers: inertiaHeaders('stale'),
      });
      expect(conflict.status).toBe(409);
      const page = htmlPage(await client.send('/page/1'));
      expect(page['flash']).toStrictEqual({
        message: 'Saved!',
        newUserId: 7,
        highlight: 1,
      });
    });

    it('carries preserveFragment over a redirect', async () => {
      const client = browser(app, platform);
      const redirected = await client.send('/fragment', {
        method: 'POST',
        headers: inertiaHeaders('v1'),
      });
      expect(redirected.status).toBe(302);
      const page = json(
        await client.send('/page/2', { headers: inertiaHeaders('v1') }),
      );
      expect(page['preserveFragment']).toBe(true);
      const later = json(
        await client.send('/page/2', { headers: inertiaHeaders('v1') }),
      );
      expect(later).not.toHaveProperty('preserveFragment');
    });

    it('redirects validation failures back with errors that are shown once', async () => {
      const client = browser(app, platform);
      const base = new URL(await app.getUrl());
      const referer = `http://127.0.0.1:${base.port}/users/create?step=2`;
      const failed = await client.send('/users', {
        method: 'POST',
        headers: { ...inertiaHeaders('v1'), referer },
        body: { name: '', address: {} },
      });
      expect(failed.status).toBe(302);
      expect(header(failed, 'location')).toBe('/users/create?step=2');
      const page = json(
        await client.send('/users/create?step=2', {
          headers: inertiaHeaders('v1'),
        }),
      );
      expect(
        (page['props'] as Record<string, unknown>)['errors'],
      ).toStrictEqual({
        name: 'The name field is required.',
        'address.city': 'City is required.',
      });
      const cleared = json(
        await client.send('/users/create?step=2', {
          headers: inertiaHeaders('v1'),
        }),
      );
      expect(
        (cleared['props'] as Record<string, unknown>)['errors'],
      ).toStrictEqual({});
    });

    it('uses 303 after PUT validation failures and falls back when the referer is foreign', async () => {
      const client = browser(app, platform);
      const failed = await client.send('/users/1', {
        method: 'PUT',
        headers: {
          ...inertiaHeaders('v1'),
          referer: 'https://evil.example/phish',
        },
        body: { name: ' ' },
      });
      expect(failed.status).toBe(303);
      expect(header(failed, 'location')).toBe('/');
      const ok = await client.send('/users/1', {
        method: 'PUT',
        headers: inertiaHeaders('v1'),
        body: { name: 'Ada' },
      });
      expect(ok.status).toBe(303);
      const patch = await client.send('/users/1', {
        method: 'PATCH',
        headers: inertiaHeaders('v1'),
      });
      expect(patch.status).toBe(301);
    });

    it('checks versions only on Inertia GET requests', async () => {
      const conflict = await send(app, '/lazy?x=1', {
        headers: inertiaHeaders('old'),
      });
      expect(conflict.status).toBe(409);
      expect(header(conflict, 'x-inertia-location')).toBe('/lazy?x=1');
      expect(header(conflict, 'x-inertia-version')).toBe('v1');
      expect(header(conflict, 'x-inertia')).toBeUndefined();
      expect(calls['regular']).toBeUndefined();
      const missing = await send(app, '/lazy', { headers: inertiaHeaders() });
      expect(missing.status).toBe(409);
      const post = await send(app, '/flash', {
        method: 'POST',
        headers: inertiaHeaders('old'),
      });
      expect(post.status).not.toBe(409);
    });

    it('renders through the HTTP adapter imperatively with a custom status', async () => {
      const result = await send(app, '/imperative', {
        headers: inertiaHeaders('v1'),
      });
      expect(result.status).toBe(202);
      expect(header(result, 'x-inertia')).toBe('true');
      expect(json(result)['component']).toBe('Imperative');
    });

    it('leaves non-Inertia errors to Nest and lets a host filter render an Inertia error page', async () => {
      const plain = await send(app, '/errors/plain', {
        headers: inertiaHeaders('v1'),
      });
      expect(plain.status).toBe(404);
      expect(header(plain, 'x-inertia')).toBeUndefined();
      const page = await send(app, '/errors/page', {
        headers: inertiaHeaders('v1'),
      });
      expect(page.status).toBe(404);
      expect(header(page, 'x-inertia')).toBe('true');
      expect(json(page)).toMatchObject({
        component: 'Error',
        props: { status: 404 },
      });
    });
  },
);

describe('Inertia application roots', () => {
  afterAll(closeAll);

  @Controller()
  class RootsController {
    @Get('admin/users')
    @InertiaPage('Admin/Users', { app: 'react' })
    users() {
      return { users: [] };
    }
    @Get('vue/home')
    @InertiaPage('Home')
    vue() {
      return {};
    }
    @Get('home')
    @InertiaPage('Home')
    home() {
      return {};
    }
  }

  it('selects roots by decorator and path and namespaces versions across roots', async () => {
    const app = await boot(
      'express',
      [
        InertiaModule.forRoot({
          apps: {
            react: {
              id: 'react-root',
              version: 'r1',
              entry: { scripts: ['/react.js'] },
            },
            vue: {
              id: 'vue-root',
              version: () => Promise.resolve(2),
              paths: ['/vue'],
              entry: { scripts: ['/vue.js'] },
            },
            hbs: { version: 'h1' },
          },
          defaultApp: 'hbs',
        }),
      ],
      [RootsController],
    );
    const react = await send(app, '/admin/users');
    expect(react.body).toContain(
      '<script type="module" src="/react.js"></script>',
    );
    expect(htmlPage(react, 'react-root')['version']).toBe('react:r1');
    expect(react.body).toContain('<div id="react-root"></div>');
    const vue = await send(app, '/vue/home');
    expect(htmlPage(vue, 'vue-root')['version']).toBe('vue:2');
    expect(htmlPage(await send(app, '/home'))['version']).toBe('hbs:h1');
    const cross = await send(app, '/vue/home', {
      headers: inertiaHeaders('react:r1'),
    });
    expect(cross.status).toBe(409);
    expect(header(cross, 'x-inertia-version')).toBe('vue:2');
    const same = await send(app, '/vue/home', {
      headers: inertiaHeaders('vue:2'),
    });
    expect(same.status).toBe(200);
  });

  it('does not loop when a falsy numeric version makes the client omit the header', async () => {
    const app = await boot(
      'express',
      [InertiaModule.forRoot({ version: 0 })],
      [RootsController],
    );
    const page = await send(app, '/home', { headers: inertiaHeaders() });
    expect(page.status).toBe(200);
    expect(json(page)['version']).toBe(0);
    const stale = await send(app, '/home', { headers: inertiaHeaders('1') });
    expect(stale.status).toBe(409);
  });

  it('rejects unknown roots and ambiguous defaults at configuration time', () => {
    expect(() => InertiaModule.forRoot({ apps: { a: {}, b: {} } })).toThrow(
      /defaultApp/,
    );
    expect(() => InertiaModule.forRoot({ apps: { 'bad key': {} } })).toThrow(
      /app key/,
    );
    expect(() => InertiaModule.forRoot({ id: '1bad' })).toThrow(/DOM id/);
    expect(() =>
      InertiaModule.forRoot({ redirects: { fallback: '//evil' } }),
    ).toThrow(/fallback/);
    expect(() =>
      InertiaModule.forRoot({
        redirects: { allowedOrigins: ['javascript:alert(1)'] },
      }),
    ).toThrow();
    expect(() =>
      InertiaModule.forRoot({ entry: { scripts: ['javascript:alert(1)'] } }),
    ).toThrow(/entry/);
  });
});

describe('Inertia root templates and SSR', () => {
  let root: string;
  let engine: HbsEngine;
  let ssrServer: Server | undefined;
  const ssrCalls: string[] = [];
  let ssrMode: 'ok' | 'fail' | 'garbage' = 'ok';

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'nestvexa-inertia-'));
    await writeFile(
      join(root, 'inertia-root.hbs'),
      '<!doctype html><html><head><title>{{inertiaTitle}} | {{siteName}}</title>{{inertiaAssets}}{{inertiaHead}}</head><body class="hbs">{{inertiaBody}}</body></html>',
    );
    engine = new HbsEngine({ root });
    await engine.initialize();
    ssrServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        if (request.url === '/health') {
          response.setHeader('Content-Type', 'application/json');
          response.end('{"status":"OK"}');
          return;
        }
        const body = Buffer.concat(chunks).toString('utf8');
        ssrCalls.push(body);
        response.setHeader('Content-Type', 'application/json');
        if (ssrMode === 'fail') {
          response.statusCode = 500;
          response.end(
            JSON.stringify({
              error: 'window is not defined',
              type: 'browser-api',
              hint: 'h',
              timestamp: 't',
            }),
          );
          return;
        }
        if (ssrMode === 'garbage') {
          response.end('{"head":"nope"}');
          return;
        }
        const page = JSON.parse(body) as { component: string };
        response.end(
          JSON.stringify({
            head: [`<title>SSR ${page.component}</title>`],
            body: `<script data-page="app" type="application/json">${body.replace(/\//g, '\\/')}</script><div data-server-rendered="true" id="app"><h1>${page.component}</h1></div>`,
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      ssrServer?.listen(0, '127.0.0.1', resolve),
    );
  });

  afterAll(async () => {
    await closeAll();
    await engine.dispose();
    await new Promise<void>((resolve) => ssrServer?.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  @Controller()
  class SsrController {
    @Get('ssr')
    @InertiaPage('Events/Show')
    show() {
      return { title: 'Party' };
    }
  }

  function ssrUrl(): string {
    const address = ssrServer?.address();
    if (!address || typeof address === 'string')
      throw new Error('SSR fixture not listening');
    return `http://127.0.0.1:${address.port}`;
  }

  it('renders the root document through a Nestvexa view engine (HBS)', async () => {
    const app = await boot(
      'fastify',
      [
        InertiaModule.forRoot({
          rootView: viewRootView(engine, 'inertia-root'),
          title: 'Events',
          entry: { scripts: ['/app.js'] },
        }),
      ],
      [SsrController],
    );
    const result = await send(app, '/ssr');
    expect(result.body).toContain('<title>Events | </title>');
    expect(result.body).toContain(
      '<body class="hbs"><script data-page="app" type="application/json">',
    );
    expect(result.body).toContain(
      '<script type="module" src="/app.js"></script>',
    );
    expect(htmlPage(result)['props']).toStrictEqual({
      errors: {},
      title: 'Party',
    });
  });

  it('uses SSR markup, falls back on failures and never calls SSR for XHR visits', async () => {
    const failures: unknown[] = [];
    const gateway = new HttpSsrGateway({ url: ssrUrl(), timeoutMs: 2000 });
    expect(await gateway.health()).toBe(true);
    const app = await boot(
      'express',
      [
        InertiaModule.forRoot({
          ssr: { renderer: gateway, onError: (error) => failures.push(error) },
        }),
      ],
      [SsrController],
    );
    ssrMode = 'ok';
    const rendered = await send(app, '/ssr');
    expect(rendered.body).toContain('<title>SSR Events/Show</title>');
    expect(rendered.body).toContain(
      '<div data-server-rendered="true" id="app"><h1>Events/Show</h1></div>',
    );
    expect(JSON.parse(ssrCalls.at(-1) ?? '{}')).toMatchObject({
      component: 'Events/Show',
      url: '/ssr',
    });
    const before = ssrCalls.length;
    await send(app, '/ssr', { headers: inertiaHeaders('') });
    expect(ssrCalls.length).toBe(before);
    ssrMode = 'fail';
    const fallback = await send(app, '/ssr');
    expect(fallback.status).toBe(200);
    expect(fallback.body).toContain('<div id="app"></div>');
    expect(fallback.body).not.toContain('window is not defined');
    expect(failures.at(-1)).toBeInstanceOf(InertiaSsrError);
    expect((failures.at(-1) as InertiaSsrError).type).toBe('browser-api');
    ssrMode = 'garbage';
    await send(app, '/ssr');
    expect((failures.at(-1) as InertiaSsrError).type).toBe('invalid-response');
  });

  it('falls back when the SSR server is unreachable and fails closed in strict mode', async () => {
    const failures: InertiaSsrError[] = [];
    const unreachable = new HttpSsrGateway({
      url: 'http://127.0.0.1:9',
      timeoutMs: 1000,
    });
    expect(await unreachable.health()).toBe(false);
    const app = await boot(
      'express',
      [
        InertiaModule.forRoot({
          ssr: {
            renderer: unreachable,
            onError: (error) => failures.push(error as InertiaSsrError),
          },
        }),
      ],
      [SsrController],
    );
    const result = await send(app, '/ssr');
    expect(result.status).toBe(200);
    expect(htmlPage(result)['component']).toBe('Events/Show');
    expect(failures[0]?.type).toBe('connection');
    const strict = await boot(
      'express',
      [
        InertiaModule.forRoot({
          ssr: { renderer: unreachable, mode: 'strict' },
        }),
      ],
      [SsrController],
    );
    const failed = await send(strict, '/ssr');
    expect(failed.status).toBe(500);
    expect(failed.body).not.toContain('127.0.0.1:9');
  });
});

describe('Inertia module registration', () => {
  afterAll(closeAll);

  @Controller()
  class DecoratedController {
    @Post('plain')
    plain() {
      return redirect('/target');
    }
    @Post('inertia')
    @UseInertia()
    marked() {
      return redirect('/target');
    }
    @Get('async')
    @InertiaPage('Async')
    page() {
      return {};
    }
  }

  @Injectable()
  class VersionSource {
    readonly value = 'async-v9';
  }
  @Module({ providers: [VersionSource], exports: [VersionSource] })
  class VersionModule {}

  it('supports forRootAsync with injected configuration', async () => {
    const app = await boot(
      'fastify',
      [
        InertiaModule.forRootAsync({
          imports: [VersionModule],
          inject: [VersionSource],
          useFactory: (source: VersionSource) => ({ version: source.value }),
        }),
      ],
      [DecoratedController],
    );
    expect(htmlPage(await send(app, '/async'))['version']).toBe('async-v9');
  });

  it('applies the interceptor only to decorated routes in decorated mode', async () => {
    const app = await boot(
      'express',
      [InertiaModule.forRoot({ interceptor: 'decorated' })],
      [DecoratedController],
    );
    const plain = await send(app, '/plain', {
      method: 'POST',
      headers: inertiaHeaders(''),
    });
    expect(plain.status).toBe(201);
    expect(header(plain, 'location')).toBeUndefined();
    const marked = await send(app, '/inertia', {
      method: 'POST',
      headers: inertiaHeaders(''),
    });
    expect(marked.status).toBe(302);
    expect(header(marked, 'location')).toBe('/target');
  });
});
