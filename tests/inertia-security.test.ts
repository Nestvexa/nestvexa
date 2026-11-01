import 'reflect-metadata';
import {
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  InertiaModule,
  InertiaPage,
  InertiaService,
  InertiaValidationException,
  back,
  location,
  once,
  redirect,
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

let handlerRuns = 0;
const payload = '</script><script>alert(document.cookie)</script><!--';
const sharedCurrentUser = once(async () => {
  await new Promise((resolve) => setTimeout(resolve, 2));
  return 'never-cached';
});

function sessionUser(request: object): string | undefined {
  const value = (request as { headers: Record<string, unknown> }).headers[
    'x-test-user'
  ];
  return typeof value === 'string' ? value : undefined;
}

@Controller()
class SecurityController {
  constructor(
    @Inject(InertiaService) private readonly inertia: InertiaService,
  ) {}

  @Get('xss')
  @InertiaPage('Xss')
  xss() {
    handlerRuns++;
    return {
      comment: payload,
      separators: 'a\u2028b\u2029c',
      html: '<img src=x onerror=alert(1)>&amp;',
    };
  }

  @Get('me')
  @InertiaPage('Me')
  async me(@Req() request: object) {
    const user = sessionUser(request);
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
    return {
      secret: () => `secret-of-${user ?? 'guest'}`,
      cached: sharedCurrentUser,
    };
  }

  @Post('me/flash')
  flash(@Req() request: object) {
    this.inertia.flash(
      request,
      'note',
      `for-${sessionUser(request) ?? 'guest'}`,
    );
    return redirect('/me');
  }

  @Post('me/invalid')
  invalid(@Req() request: object) {
    throw new InertiaValidationException({
      email: `bad-${sessionUser(request) ?? 'guest'}`,
    });
  }

  @Get('go')
  go(@Query('next') next: string) {
    return redirect(next);
  }

  @Get('away')
  away(@Query('to') to: string) {
    return location(to);
  }

  @Post('back')
  back() {
    return back();
  }

  @Get('bad/function')
  @InertiaPage('Bad')
  badFunction() {
    // The lazy factory runs, but its result (a function) is not page data.
    return { nested: { fn: () => () => 'hunter2' } };
  }

  @Get('bad/cycle')
  @InertiaPage('Bad')
  badCycle() {
    const cycle: Record<string, unknown> = { password: 'hunter2' };
    cycle['self'] = cycle;
    return { cycle };
  }

  @Get('bad/bigint')
  @InertiaPage('Bad')
  badBigint() {
    return { id: 1n };
  }

  @Get('bad/errors')
  @InertiaPage('Bad')
  badErrors() {
    return { errors: { forged: 'x' } };
  }

  @Get('bad/proto')
  @InertiaPage('Bad')
  badProto() {
    return JSON.parse('{"__proto__":{"polluted":true}}') as Record<
      string,
      unknown
    >;
  }
}

/**
 * Host-owned CSRF pattern for the official clients: a per-session random
 * token is mirrored into the readable XSRF-TOKEN cookie; unsafe requests must
 * echo it in X-XSRF-TOKEN (which @inertiajs/core sends automatically).
 */
@Injectable()
class XsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<{
      method: string;
      headers: Record<string, unknown>;
      session?: Record<string, unknown>;
    }>();
    const response = http.getResponse<{
      cookie(name: string, value: string, options: object): void;
    }>();
    const session = request.session;
    if (!session) throw new ForbiddenException();
    if (typeof session['xsrf'] !== 'string')
      session['xsrf'] = randomBytes(32).toString('base64url');
    const token = session['xsrf'] as string;
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      response.cookie('XSRF-TOKEN', token, { sameSite: 'lax', path: '/' });
      return true;
    }
    const sent = request.headers['x-xsrf-token'];
    const expected = Buffer.from(token);
    const actual = Buffer.from(
      typeof sent === 'string' ? decodeURIComponent(sent) : '',
    );
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new ForbiddenException('CSRF token mismatch');
    return true;
  }
}

@Controller('csrf')
@UseGuards(XsrfGuard)
class CsrfController {
  @Get()
  @InertiaPage('Form')
  form() {
    return {};
  }
  @Post()
  submit() {
    return redirect('/csrf');
  }
}

async function securityApp(platform: Platform) {
  return boot(
    platform,
    [
      InertiaModule.forRoot({
        version: 'sec',
        title: '</title><script>alert(1)</script>',
        share: (request) => ({ user: sessionUser(request) ?? null }),
        redirects: { allowedOrigins: ['https://sso.example.com'] },
        ...sessionOption(platform),
      }),
    ],
    platform === 'express'
      ? [SecurityController, CsrfController]
      : [SecurityController],
    { expressSession: platform === 'express' },
  );
}

describe.each(['express', 'fastify'] as const)(
  'Inertia security corpus on %s',
  (platform) => {
    let app: INestApplication;
    beforeAll(async () => {
      app = await securityApp(platform);
    });
    afterAll(closeAll);

    it('cannot close the page script or title with prop or config data', async () => {
      const result = await send(app, '/xss');
      expect(result.body.match(/<\/script>/g)?.length).toBe(1);
      expect(result.body).not.toContain('<script>alert');
      expect(result.body).not.toContain('<img');
      expect(result.body).not.toContain('<!--');
      expect(result.body).toContain(
        '<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>',
      );
      const page = htmlPage(result);
      expect(page['props']).toMatchObject({
        comment: payload,
        separators: 'a\u2028b\u2029c',
        html: '<img src=x onerror=alert(1)>&amp;',
      });
    });

    it.each([
      [
        'oversized partial list',
        { 'x-inertia-partial-data': `${'a,'.repeat(2100)}` },
      ],
      ['prototype path', { 'x-inertia-partial-data': '__proto__.polluted' }],
      [
        'constructor path',
        { 'x-inertia-partial-except': 'constructor.prototype' },
      ],
      ['empty segment', { 'x-inertia-reset': 'a..b' }],
      ['merge intent', { 'x-inertia-infinite-scroll-merge-intent': 'replace' }],
      ['error bag', { 'x-inertia-error-bag': '__proto__' }],
      ['component', { 'x-inertia-partial-component': 'C'.repeat(400) }],
    ])(
      'rejects a malformed %s header with 400 before the handler runs',
      async (_label, headers) => {
        handlerRuns = 0;
        const result = await send(app, '/xss', {
          headers: { ...inertiaHeaders('sec'), ...headers },
        });
        expect(result.status).toBe(400);
        expect(header(result, 'x-inertia')).toBeUndefined();
        expect(handlerRuns).toBe(0);
      },
    );

    it('treats non-true X-Inertia values as full page loads', async () => {
      for (const value of ['1', 'false', 'yes']) {
        const result = await send(app, '/xss', {
          headers: { 'x-inertia': value },
        });
        expect(result.status).toBe(200);
        expect(header(result, 'content-type')).toMatch(/^text\/html/);
      }
    });

    it.each([
      '//evil.example/x',
      '/\\evil.example',
      'https://evil.example/',
      'javascript:alert(1)',
      'https://sso.example.com.evil.example/',
      '/ok%0d%0aSet-Cookie:%20pwned=1',
    ])('rejects redirect injection target %j', async (target) => {
      const query = target.includes('%0d')
        ? target
        : encodeURIComponent(target);
      const result = await send(app, `/go?next=${query}`, {
        headers: inertiaHeaders('sec'),
      });
      expect(result.status).toBe(400);
      expect(header(result, 'location')).toBeUndefined();
      expect(header(result, 'set-cookie') ?? '').not.toContain('pwned');
    });

    it('allows relative and allowlisted redirect targets only', async () => {
      const ok = await send(
        app,
        `/go?next=${encodeURIComponent('/dashboard?tab=1')}`,
        { headers: inertiaHeaders('sec') },
      );
      expect(ok.status).toBe(302);
      expect(header(ok, 'location')).toBe('/dashboard?tab=1');
      const sso = await send(
        app,
        `/away?to=${encodeURIComponent('https://sso.example.com/login')}`,
        {
          headers: inertiaHeaders('sec'),
        },
      );
      expect(sso.status).toBe(409);
      expect(header(sso, 'x-inertia-location')).toBe(
        'https://sso.example.com/login',
      );
      const plain = await send(
        app,
        `/away?to=${encodeURIComponent('https://sso.example.com/login')}`,
      );
      expect(plain.status).toBe(302);
      const evil = await send(
        app,
        `/away?to=${encodeURIComponent('https://evil.example/')}`,
        {
          headers: inertiaHeaders('sec'),
        },
      );
      expect(evil.status).toBe(400);
      expect(header(evil, 'x-inertia-location')).toBeUndefined();
    });

    it('never follows a foreign or malformed Referer in back()', async () => {
      for (const referer of [
        'https://evil.example/x',
        'javascript:alert(1)',
        'http://127.0.0.1.evil.example/',
        '//evil',
      ]) {
        const result = await send(app, '/back', {
          method: 'POST',
          headers: { ...inertiaHeaders('sec'), referer },
        });
        expect(result.status).toBe(302);
        expect(header(result, 'location')).toBe('/');
      }
      const result = await send(app, '/back', {
        method: 'POST',
        headers: {
          ...inertiaHeaders('sec'),
          host: 'evil.example',
          referer: 'http://evil.example//double',
        },
      });
      expect(header(result, 'location')).toBe('/');
    });

    it('keeps props, flash and errors separate across interleaved users', async () => {
      const alice = browser(app, platform);
      const bob = browser(app, platform);
      const as = (user: string) => ({
        ...inertiaHeaders('sec'),
        'x-test-user': user,
      });
      await alice.send('/me/flash', { method: 'POST', headers: as('alice') });
      await bob.send('/me/invalid', { method: 'POST', headers: as('bob') });
      const pages = await Promise.all(
        Array.from({ length: 40 }, (_, index) =>
          send(app, '/me', { headers: as(index % 2 ? 'alice' : 'bob') }).then(
            json,
          ),
        ),
      );
      pages.forEach((page, index) => {
        const user = index % 2 ? 'alice' : 'bob';
        expect(page['props']).toMatchObject({
          user,
          secret: `secret-of-${user}`,
          cached: 'never-cached',
        });
        expect(page).not.toHaveProperty('flash');
        expect(
          (page['props'] as Record<string, unknown>)['errors'],
        ).toStrictEqual({});
      });
      const bobPage = json(await bob.send('/me', { headers: as('bob') }));
      expect(bobPage).not.toHaveProperty('flash');
      expect(
        (bobPage['props'] as Record<string, unknown>)['errors'],
      ).toStrictEqual({ email: 'bad-bob' });
      const alicePage = json(await alice.send('/me', { headers: as('alice') }));
      expect(alicePage['flash']).toStrictEqual({ note: 'for-alice' });
      expect(
        (alicePage['props'] as Record<string, unknown>)['errors'],
      ).toStrictEqual({});
    });

    it.each(['function', 'cycle', 'bigint', 'errors', 'proto'])(
      'fails closed without leaking data for a %s prop',
      async (kind) => {
        const result = await send(app, `/bad/${kind}`, {
          headers: inertiaHeaders('sec'),
        });
        expect(result.status).toBe(500);
        expect(result.body).not.toContain('hunter2');
        expect(result.body).not.toContain('polluted');
        expect(header(result, 'x-inertia')).toBeUndefined();
        expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
      },
    );
  },
);

describe('host CSRF guard with Inertia XSRF cookies (express-session)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await securityApp('express');
  });
  afterAll(closeAll);

  it('issues XSRF-TOKEN and rejects unsafe requests without the matching header', async () => {
    const user = browser(app, 'express');
    const page = await user.send('/csrf');
    expect(page.status).toBe(200);
    const token = user.cookie('XSRF-TOKEN');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const missing = await user.send('/csrf', {
      method: 'POST',
      headers: inertiaHeaders('sec'),
    });
    expect(missing.status).toBe(403);
    const forged = await user.send('/csrf', {
      method: 'POST',
      headers: { ...inertiaHeaders('sec'), 'x-xsrf-token': 'A'.repeat(43) },
    });
    expect(forged.status).toBe(403);
    const attacker = browser(app, 'express');
    await attacker.send('/csrf');
    const crossSession = await attacker.send('/csrf', {
      method: 'POST',
      headers: { ...inertiaHeaders('sec'), 'x-xsrf-token': token ?? '' },
    });
    expect(crossSession.status).toBe(403);
    const ok = await user.send('/csrf', {
      method: 'POST',
      headers: { ...inertiaHeaders('sec'), 'x-xsrf-token': token ?? '' },
    });
    expect(ok.status).toBe(302);
    expect(header(ok, 'location')).toBe('/csrf');
  });
});
