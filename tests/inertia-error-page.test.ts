import 'reflect-metadata';
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_ERROR_PAGE_STATUSES,
  InertiaConfigurationError,
  InertiaErrorPageFilter,
  InertiaModule,
  InertiaPage,
  InertiaValidationException,
  errorPageStatus,
} from '../packages/inertia/dist/index.js';
import type { INestApplication } from '@nestjs/common';
import type { InertiaModuleOptions } from '../packages/inertia/dist/index.js';
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

/**
 * The reference adapter documents error pages as an exception handler that
 * renders `Inertia::render('ErrorPage', ['status' => $status])` with the
 * original status for 500, 503, 404 and 403 outside local/testing
 * (https://inertiajs.com/docs/v2/advanced/error-handling). These tests prove
 * `InertiaErrorPageFilter` does that on Express and Fastify, keeps exception
 * details out of production pages, and leaves every other response alone.
 */

const SECRET = 'postgres://admin:hunter2@db.internal/app'; // trufflehog:ignore (leak-test fixture)
const HOSTILE = '</script><script>alert(1)</script>\u2028&amp;';

@Controller()
class ErrorController {
  @Get('admin')
  @InertiaPage('Admin')
  admin() {
    throw new ForbiddenException('Admins only: user 42 lacks role "root"');
  }

  @Get('crash')
  @InertiaPage('Crash')
  crash() {
    throw new Error(`connect failed for ${SECRET}`);
  }

  @Get('maintenance')
  @InertiaPage('Maintenance')
  maintenance() {
    throw new ServiceUnavailableException();
  }

  @Get('bad')
  @InertiaPage('Bad')
  bad() {
    throw new BadRequestException('Bad input');
  }

  @Get('hostile')
  @InertiaPage('Hostile')
  hostile() {
    throw new Error(HOSTILE);
  }

  @Get('api/crash')
  apiCrash() {
    throw new Error(`api ${SECRET}`);
  }

  @Post('form')
  form() {
    throw new InertiaValidationException({ name: 'Required' });
  }
}

function base(
  platform: Platform,
  errorPage: InertiaModuleOptions['errorPage'],
  extra: InertiaModuleOptions = {},
) {
  return InertiaModule.forRoot({
    version: 'v1',
    ...sessionOption(platform),
    share: () => ({ appName: 'Demo' }),
    ...(errorPage === undefined ? {} : { errorPage }),
    ...extra,
  });
}

const htmlAccept = { accept: 'text/html,application/xhtml+xml' };

afterAll(closeAll);

describe.each(['express', 'fastify'] as const)(
  'Inertia error pages on %s',
  { timeout: 60_000 },
  (platform: Platform) => {
    let production: INestApplication;
    let debug: INestApplication;
    beforeAll(async () => {
      production = await boot(
        platform,
        [base(platform, { component: 'ErrorPage', debug: false })],
        [ErrorController],
        { expressSession: true },
      );
      debug = await boot(
        platform,
        [base(platform, { component: 'ErrorPage', debug: true })],
        [ErrorController],
        { expressSession: true },
      );
    });

    it('renders the error component as an HTML document for an unknown route', async () => {
      const response = await send(production, '/nowhere', {
        headers: htmlAccept,
      });
      expect(response.status).toBe(404);
      expect(header(response, 'content-type')).toMatch(/^text\/html/);
      const page = htmlPage(response);
      expect(page['component']).toBe('ErrorPage');
      expect(page['props']).toStrictEqual({
        errors: {},
        appName: 'Demo',
        status: 404,
        message: 'Not Found',
      });
      expect(page['url']).toBe('/nowhere');
      expect(page['version']).toBe('v1');
    });

    it('answers Inertia visits with a JSON page carrying the original status', async () => {
      const response = await send(production, '/admin', {
        headers: inertiaHeaders('v1'),
      });
      expect(response.status).toBe(403);
      expect(header(response, 'x-inertia')).toBe('true');
      expect(header(response, 'vary')).toContain('X-Inertia');
      const page = json(response);
      expect(page['component']).toBe('ErrorPage');
      expect(page['props']).toMatchObject({
        status: 403,
        message: 'Forbidden',
      });
      expect(response.body).not.toContain('Admins only');
    });

    it('keeps exception messages and stacks out of production pages', async () => {
      for (const path of ['/crash', '/maintenance']) {
        const response = await send(production, path, {
          headers: inertiaHeaders('v1'),
        });
        const page = json(response);
        const props = page['props'] as Record<string, unknown>;
        expect(props).not.toHaveProperty('exception');
        expect(response.body).not.toContain('hunter2');
        expect(response.body).not.toMatch(/\bat .+\.(?:ts|js):\d+/);
        expect(response.body).not.toContain('error-page.test');
        if (path === '/crash') {
          expect(response.status).toBe(500);
          expect(props['message']).toBe('Server Error');
        } else {
          expect(response.status).toBe(503);
          expect(props['message']).toBe('Service Unavailable');
        }
      }
    });

    it('adds the exception message and stack only in debug mode', async () => {
      const response = await send(debug, '/crash', {
        headers: inertiaHeaders('v1'),
      });
      expect(response.status).toBe(500);
      const props = json(response)['props'] as Record<string, unknown>;
      expect(props['message']).toBe(`connect failed for ${SECRET}`);
      const exception = props['exception'] as Record<string, unknown>;
      expect(exception['name']).toBe('Error');
      expect(exception['message']).toBe(`connect failed for ${SECRET}`);
      expect(String(exception['stack'])).toContain('inertia-error-page.test');
      const forbidden = json(
        await send(debug, '/admin', { headers: inertiaHeaders('v1') }),
      );
      expect((forbidden['props'] as Record<string, unknown>)['message']).toBe(
        'Admins only: user 42 lacks role "root"',
      );
    });

    it('escapes hostile exception text in the HTML document', async () => {
      const response = await send(debug, '/hostile', { headers: htmlAccept });
      expect(response.status).toBe(500);
      expect(response.body).not.toContain('<script>alert(1)');
      const props = htmlPage(response)['props'] as Record<string, unknown>;
      expect(props['message']).toBe(HOSTILE);
    });

    it('leaves statuses outside the list to Nest default handling', async () => {
      const response = await send(production, '/bad', {
        headers: inertiaHeaders('v1'),
      });
      expect(response.status).toBe(400);
      expect(header(response, 'x-inertia')).toBeUndefined();
      expect(json(response)).toMatchObject({
        statusCode: 400,
        message: 'Bad input',
      });
    });

    it('answers API clients that do not accept HTML with the default JSON error', async () => {
      const notFound = await send(production, '/nowhere', {
        headers: { accept: 'application/json' },
      });
      expect(notFound.status).toBe(404);
      expect(json(notFound)).toMatchObject({ statusCode: 404 });
      const crash = await send(production, '/api/crash', {
        headers: { accept: 'application/json' },
      });
      expect(crash.status).toBe(500);
      expect(json(crash)).toStrictEqual({
        statusCode: 500,
        message: 'Internal server error',
      });
    });

    it('still turns InertiaValidationException into a redirect back with errors', async () => {
      const client = browser(production, platform);
      const { port } = new URL(await production.getUrl());
      const response = await client.send('/form', {
        method: 'POST',
        headers: {
          ...inertiaHeaders('v1'),
          referer: `http://127.0.0.1:${port}/profile`,
        },
        body: {},
      });
      expect(response.status).toBe(302);
      expect(header(response, 'location')).toBe('/profile');
    });

    it('leaves Precognition requests to their own replies', async () => {
      const response = await send(production, '/nowhere', {
        headers: { ...inertiaHeaders('v1'), precognition: 'true' },
      });
      expect(response.status).toBe(404);
      expect(header(response, 'x-inertia')).toBeUndefined();
    });
  },
);

describe('Inertia error page options', { timeout: 60_000 }, () => {
  it('maps exceptions to statuses', () => {
    expect(errorPageStatus(new ForbiddenException())).toBe(403);
    expect(errorPageStatus(new Error('x'))).toBe(500);
    expect(errorPageStatus('thrown string')).toBe(500);
    expect(DEFAULT_ERROR_PAGE_STATUSES).toEqual([403, 404, 500, 503]);
  });

  it('defaults debug off outside NODE_ENV=development', async () => {
    expect(process.env['NODE_ENV']).not.toBe('development');
    const app = await boot(
      'express',
      [base('express', { component: 'ErrorPage' })],
      [ErrorController],
    );
    const props = json(
      await send(app, '/crash', { headers: inertiaHeaders('v1') }),
    )['props'] as Record<string, unknown>;
    expect(props).not.toHaveProperty('exception');
    expect(props['message']).toBe('Server Error');
  });

  it('renders custom statuses with extra props from the props hook', async () => {
    const app = await boot(
      'fastify',
      [
        base('fastify', {
          component: 'Errors/Show',
          statuses: [400],
          props: ({ status, debug }) => ({
            title: `Oops ${String(status)}`,
            debug,
          }),
        }),
      ],
      [ErrorController],
    );
    const response = await send(app, '/bad', { headers: inertiaHeaders('v1') });
    expect(response.status).toBe(400);
    const page = json(response);
    expect(page['component']).toBe('Errors/Show');
    expect(page['props']).toMatchObject({
      status: 400,
      message: 'Bad Request',
      title: 'Oops 400',
      debug: false,
    });
    // 404 is no longer in the list: default JSON.
    const missing = await send(app, '/nowhere', { headers: htmlAccept });
    expect(json(missing)).toMatchObject({ statusCode: 404 });
  });

  it('falls back to a plain status line when rendering the page fails', async () => {
    const app = await boot(
      'express',
      [
        base(
          'express',
          { component: 'ErrorPage' },
          {
            share: () => {
              throw new Error(`share failed ${SECRET}`);
            },
          },
        ),
      ],
      [ErrorController],
    );
    const response = await send(app, '/nowhere', { headers: htmlAccept });
    expect(response.status).toBe(404);
    expect(header(response, 'content-type')).toMatch(/^text\/plain/);
    expect(response.body).toBe('Not Found');
  });

  it('is not registered without the errorPage option, and is with forRootAsync opt-in', async () => {
    const without = await boot(
      'express',
      [base('express', undefined)],
      [ErrorController],
    );
    const plain = await send(without, '/nowhere', { headers: htmlAccept });
    expect(plain.status).toBe(404);
    expect(json(plain)).toMatchObject({ statusCode: 404 });
    const asyncApp = await boot(
      'fastify',
      [
        InertiaModule.forRootAsync({
          errorPageFilter: true,
          useFactory: () => ({
            version: 'v1',
            errorPage: { component: 'ErrorPage' },
          }),
        }),
      ],
      [ErrorController],
    );
    const page = htmlPage(
      await send(asyncApp, '/nowhere', { headers: htmlAccept }),
    );
    expect(page['component']).toBe('ErrorPage');
    expect(InertiaErrorPageFilter.name).toBe('InertiaErrorPageFilter');
  });

  it.each([
    ['an empty component', { component: '' }],
    ['a redirect status', { component: 'E', statuses: [302] }],
    ['an empty status list', { component: 'E', statuses: [] }],
    ['a non-boolean debug', { component: 'E', debug: 'yes' }],
    ['an unknown app', { component: 'E', app: 'nope' }],
    ['a non-function props hook', { component: 'E', props: {} }],
  ])('rejects %s at module definition', (_label, errorPage) => {
    expect(() =>
      InertiaModule.forRoot({ errorPage: errorPage as never }),
    ).toThrowError(InertiaConfigurationError);
  });
});
