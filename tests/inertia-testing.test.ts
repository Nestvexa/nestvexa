import 'reflect-metadata';
import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import { afterAll, describe, expect, it } from 'vitest';
import {
  InertiaModule,
  InertiaPage,
  InertiaService,
  InertiaSessionKey,
  back,
  defer,
  optional,
} from '../packages/inertia/dist/index.js';
import type { InertiaModuleOptions } from '../packages/inertia/dist/index.js';
import {
  AssertableInertiaPage,
  InertiaAssertionError,
  assertInertia,
  inertiaHeaders,
  readInertiaPage,
} from '../packages/inertia/dist/testing.js';
import {
  boot,
  browser,
  closeAll,
  header,
  send,
  sessionOption,
} from './inertia-support.js';
import type { Platform } from './inertia-support.js';

let mutations = 0;

@Controller()
class TestingController {
  constructor(
    @Inject(InertiaService) private readonly inertia: InertiaService,
  ) {}

  @Get('users')
  @InertiaPage('Users/Index')
  users(@Req() request: object) {
    this.inertia.flash(request, 'notice', 'Hello');
    return {
      users: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
      ],
      filters: { q: '' },
      stats: defer(() => ({ total: 2 }), 'sidebar'),
      extra: optional(() => 'only on demand'),
    };
  }

  @Get('missing')
  @InertiaPage('Missing', { status: 404 })
  notFound() {
    return {};
  }

  /** Mutates and returns nothing: Inertia requests are sent back. */
  @Post('mutate')
  mutate() {
    mutations += 1;
  }

  @Put('mutate')
  replace() {
    mutations += 1;
  }

  @Post('explicit-back')
  explicitBack() {
    return back();
  }

  @Post('owns-response')
  ownsResponse(
    @Res() response: { status(code: number): { send(body: string): void } },
  ) {
    setTimeout(() => response.status(200).send('handled'), 5);
  }

  @Post('no-content')
  @HttpCode(204)
  noContent() {
    mutations += 1;
  }

  @Get('empty-page')
  @InertiaPage('Empty')
  emptyPage() {
    return undefined;
  }

  /** Test control: plants a value as the stored previous URL. */
  @Post('plant')
  plant(@Req() request: { session?: Record<string, unknown> }) {
    if (request.session)
      Object.defineProperty(request.session, InertiaSessionKey.previousUrl, {
        value: '//evil.example/steal',
        writable: true,
        enumerable: true,
        configurable: true,
      });
    return { ok: true };
  }
}

async function app(platform: Platform, options: InertiaModuleOptions = {}) {
  return boot(
    platform,
    [InertiaModule.forRoot({ ...sessionOption(platform), ...options })],
    [TestingController],
    { expressSession: true },
  );
}

afterAll(closeAll);

describe('Inertia testing helpers', { timeout: 60_000 }, () => {
  it('builds the official client headers', () => {
    expect(
      inertiaHeaders({
        version: 3,
        partial: { component: 'Users/Index', only: ['a', 'b'], except: ['c'] },
        reset: ['a'],
        errorBag: 'login',
        exceptOnceProps: ['plans'],
        prefetch: true,
      }),
    ).toEqual({
      'X-Inertia': 'true',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'text/html, application/xhtml+xml',
      'X-Inertia-Version': '3',
      'X-Inertia-Partial-Component': 'Users/Index',
      'X-Inertia-Partial-Data': 'a,b',
      'X-Inertia-Partial-Except': 'c',
      'X-Inertia-Reset': 'a',
      'X-Inertia-Error-Bag': 'login',
      'X-Inertia-Except-Once-Props': 'plans',
      Purpose: 'prefetch',
    });
  });

  it('reads pages from v3 script elements, legacy attributes, JSON bodies and Headers objects', () => {
    const page = {
      component: 'Home',
      props: { errors: {}, text: '</script><b>&amp;' },
      url: '/',
      version: '1',
    };
    const script = `<html><script type="application/json" data-page="root">${JSON.stringify(page).replace(/</g, '\\u003c').replace(/\//g, '\\/')}</script></html>`;
    expect(readInertiaPage(script, { id: 'root' }).page).toEqual(page);
    const escaped = JSON.stringify(page)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
    expect(
      readInertiaPage(`<div id="app" data-page="${escaped}"></div>`).page,
    ).toEqual(page);
    const fromHeaders = readInertiaPage({
      headers: new Headers({ 'x-inertia': 'true' }),
      text: JSON.stringify(page),
    });
    expect(fromHeaders).toEqual({ page, kind: 'json' });
    expect(
      readInertiaPage({
        headers: { 'content-type': 'application/json' },
        body: page,
      }).kind,
    ).toBe('json');
  });

  it('refuses responses that carry no page object', () => {
    const cases: unknown[] = [
      '<html><body>plain</body></html>',
      { headers: { 'x-inertia': 'true' }, text: 'not json' },
      { headers: { 'x-inertia': 'true' }, text: '{"props":{}}' },
      { headers: { 'x-inertia': 'true' }, text: '[1]' },
      { headers: { 'x-inertia': 'true' } },
      '<script data-page="other" type="application/json">{}</script>',
    ];
    for (const value of cases)
      expect(() =>
        readInertiaPage(value as Parameters<typeof readInertiaPage>[0]),
      ).toThrow(InertiaAssertionError);
  });

  for (const platform of ['express', 'fastify'] as const) {
    it(`asserts component, props, flash and deferred props over HTTP (${platform})`, async () => {
      const server = await app(platform);
      const client = browser(server, platform);
      const document = await client.send('/users');
      const first = assertInertia(
        { headers: document.headers, text: document.body },
        'Users/Index',
      );
      expect(first.kind).toBe('document');
      first
        .url('/users')
        .version('')
        .has('users', 2)
        .has('filters')
        .where('users.1.name', 'Grace')
        .where('users', (users: unknown) => Array.isArray(users))
        .missing('extra')
        .deferred('stats', 'sidebar')
        .hasNoErrors()
        .flash('notice', 'Hello');
      expect(first.prop<{ q: string }>('filters')).toEqual({ q: '' });

      const partial = await client.send('/users', {
        headers: inertiaHeaders({
          partial: { component: 'Users/Index', only: ['stats', 'extra'] },
        }),
      });
      assertInertia({ headers: partial.headers, text: partial.body })
        .component('Users/Index')
        .where('stats', { total: 2 })
        .where('extra', 'only on demand')
        .missing('users');
    });
  }

  it('fails with readable messages', async () => {
    const page = new AssertableInertiaPage(
      {
        component: 'Users/Index',
        props: { errors: { email: 'Bad' }, users: [{ name: 'Ada' }], n: 1 },
        url: '/users',
        version: 'v1',
        flash: { ok: true },
        deferredProps: { default: ['later'] },
      },
      'json',
    );
    const message = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        expect(error).toBeInstanceOf(InertiaAssertionError);
        return (error as Error).message;
      }
      throw new Error('expected an assertion failure');
    };
    expect(message(() => page.component('Home'))).toBe(
      'Expected Inertia component "Home", got "Users/Index"',
    );
    expect(message(() => page.url('/x'))).toContain('"/users"');
    expect(message(() => page.version('v2'))).toContain('"v1"');
    expect(message(() => page.has('users', 3))).toContain('3 entries, got 1');
    expect(message(() => page.has('n', 1))).toContain('non-collection');
    expect(message(() => page.prop('users.1.name'))).toContain(
      '"users.1.name" to exist',
    );
    expect(message(() => page.prop('users.x'))).toContain('to exist');
    expect(message(() => page.prop('__proto__'))).toContain('to exist');
    expect(message(() => page.missing('users.0'))).toContain('to be missing');
    expect(message(() => page.where('users.0.name', 'Grace'))).toContain(
      'to equal "Grace", got "Ada"',
    );
    expect(
      message(() => page.where('n', (value: unknown) => value === 2)),
    ).toContain('predicate');
    expect(message(() => page.hasErrors('name'))).toContain('"name"');
    expect(message(() => page.hasNoErrors())).toContain('"email"');
    expect(message(() => page.flash('missing'))).toContain('"missing"');
    expect(message(() => page.flash('ok', false))).toContain('got true');
    expect(message(() => page.deferred('later', 'other'))).toContain(
      'group "other"',
    );
    page.hasErrors('email').hasErrors().deferred('later').flash('ok', true);
  });
});

describe(
  'Inertia empty responses and previous URL',
  { timeout: 60_000 },
  () => {
    for (const platform of ['express', 'fastify'] as const) {
      it(`redirects empty Inertia replies back and leaves other handlers alone (${platform})`, async () => {
        const server = await app(platform);
        const client = browser(server, platform);
        const referer = `${await server.getUrl()}/users?page=2`;
        const before = mutations;
        const inertiaPost = await client.send('/mutate', {
          method: 'POST',
          headers: { ...inertiaHeaders(), referer },
        });
        expect(inertiaPost.status).toBe(302);
        expect(header(inertiaPost, 'location')).toBe('/users?page=2');
        expect(mutations).toBe(before + 1);
        const inertiaPut = await client.send('/mutate', {
          method: 'PUT',
          headers: { ...inertiaHeaders(), referer },
        });
        expect(inertiaPut.status).toBe(303);
        // Plain (non-Inertia) requests keep Nest's empty reply.
        const plain = await client.send('/mutate', {
          method: 'POST',
          headers: { referer },
        });
        expect(plain.status).toBe(201);
        expect(header(plain, 'location')).toBeUndefined();
        // Handlers that own the response or declare a status are untouched.
        const owned = await client.send('/owns-response', {
          method: 'POST',
          headers: { ...inertiaHeaders(), referer },
        });
        expect(owned.status).toBe(200);
        expect(owned.body).toBe('handled');
        const noContent = await client.send('/no-content', {
          method: 'POST',
          headers: { ...inertiaHeaders(), referer },
        });
        expect(noContent.status).toBe(204);
        // An @InertiaPage handler returning nothing still renders its page.
        const empty = await client.send('/empty-page', {
          headers: inertiaHeaders(),
        });
        assertInertia({ headers: empty.headers, text: empty.body }, 'Empty');
      });

      it(`passthrough keeps empty Inertia replies (${platform})`, async () => {
        const server = await app(platform, { emptyResponse: 'passthrough' });
        const reply = await send(server, '/mutate', {
          method: 'POST',
          headers: inertiaHeaders(),
        });
        expect(reply.status).toBe(201);
        expect(reply.body).toBe('');
      });

      it(`back() falls back to the stored previous URL (${platform})`, async () => {
        const server = await app(platform);
        const client = browser(server, platform);
        // No session data yet: the module fallback.
        const cold = await client.send('/explicit-back', {
          method: 'POST',
          headers: inertiaHeaders(),
        });
        expect(header(cold, 'location')).toBe('/');
        await client.send('/users?tab=all');
        // A prefetch and an error page never become the previous URL.
        await client.send('/users?prefetched=1', {
          headers: inertiaHeaders({ prefetch: true }),
        });
        await client.send('/missing');
        const noReferer = await client.send('/mutate', {
          method: 'POST',
          headers: inertiaHeaders(),
        });
        expect(header(noReferer, 'location')).toBe('/users?tab=all');
        // A foreign or malformed Referer is ignored in favour of the stored URL.
        const foreign = await client.send('/explicit-back', {
          method: 'POST',
          headers: {
            ...inertiaHeaders(),
            referer: 'https://evil.example/phish',
          },
        });
        expect(header(foreign, 'location')).toBe('/users?tab=all');
        // A valid same-host Referer still wins.
        const referred = await client.send('/explicit-back', {
          method: 'POST',
          headers: {
            ...inertiaHeaders(),
            referer: `${await server.getUrl()}/elsewhere`,
          },
        });
        expect(header(referred, 'location')).toBe('/elsewhere');
      });

      it(`previousUrl: false disables the session fallback (${platform})`, async () => {
        const server = await app(platform, { previousUrl: false });
        const client = browser(server, platform);
        await client.send('/users');
        const reply = await client.send('/explicit-back', {
          method: 'POST',
          headers: inertiaHeaders(),
        });
        expect(header(reply, 'location')).toBe('/');
      });
    }

    it('ignores a tampered stored previous URL', async () => {
      const server = await app('express');
      const client = browser(server, 'express');
      await client.send('/users');
      await client.send('/plant', { method: 'POST' });
      const reply = await client.send('/explicit-back', {
        method: 'POST',
        headers: inertiaHeaders(),
      });
      expect(header(reply, 'location')).toBe('/');
    });

    it('rejects invalid options', async () => {
      const { resolveOptions } =
        await import('../packages/inertia/dist/index.js');
      expect(() =>
        resolveOptions({
          emptyResponse: 'redirect' as unknown as 'back',
        }),
      ).toThrow(/emptyResponse/);
      expect(() =>
        resolveOptions({ previousUrl: 'yes' as unknown as boolean }),
      ).toThrow(/previousUrl/);
    });
  },
);
