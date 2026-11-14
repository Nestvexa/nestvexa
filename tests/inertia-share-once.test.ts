import 'reflect-metadata';
import {
  Controller,
  Get,
  Inject,
  Injectable,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  InertiaConfigurationError,
  InertiaModule,
  InertiaPage,
  InertiaService,
  defer,
  once,
} from '../packages/inertia/dist/index.js';
import type { INestApplication } from '@nestjs/common';
import type { InertiaModuleOptions } from '../packages/inertia/dist/index.js';
import {
  boot,
  closeAll,
  inertiaHeaders,
  json,
  send,
} from './inertia-support.js';
import type { Platform } from './inertia-support.js';

/**
 * `shareOnce()` parity with the reference adapter (inertia-laravel 2.x/3.x
 * `Inertia::shareOnce(key, callback)` and the middleware `shareOnce()` hook,
 * documented at https://inertiajs.com/docs/v2/data-props/once-props#sharing-once-props):
 * the value is a once prop shared with every page, resolved on the first visit
 * and skipped while the client lists it in `X-Inertia-Except-Once-Props`.
 * Middleware once props are merged after `share()` (the reference middleware
 * shares them key by key after the `share()` array).
 */

const calls: Record<string, number> = {};
const count = (name: string) => {
  calls[name] = (calls[name] ?? 0) + 1;
};
const clear = () => {
  for (const key of Object.keys(calls)) delete calls[key];
};
const clock = 1_800_000_000_000;

/** Request-scoped once prop from a guard, as a middleware would add it. */
@Injectable()
class ShareOnceGuard implements CanActivate {
  constructor(
    @Inject(InertiaService) private readonly inertia: InertiaService,
  ) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<object>();
    this.inertia.shareOnce(
      request,
      'permissions',
      () => {
        count('permissions');
        return ['read'];
      },
      { as: 'perms', until: 60 },
    );
    return true;
  }
}

@Controller()
class ShareOnceController {
  constructor(
    @Inject(InertiaService) private readonly inertia: InertiaService,
  ) {}

  @Get('dashboard')
  @InertiaPage('Dashboard')
  @UseGuards(ShareOnceGuard)
  dashboard() {
    return { title: 'Home' };
  }

  @Get('override')
  @InertiaPage('Override')
  override(@Req() request: object) {
    // Request-scoped share wins over the module's once-shared value.
    this.inertia.share(request, 'countries', ['request-scoped']);
    return {};
  }

  @Get('existing-prop')
  @InertiaPage('Existing')
  existing(@Req() request: object) {
    this.inertia.shareOnce(
      request,
      'plans',
      once(() => ['basic']).as('plan-list'),
      { fresh: true },
    );
    return {};
  }

  @Get('bad-callback')
  @InertiaPage('Bad')
  badCallback(@Req() request: object) {
    this.inertia.shareOnce(request, 'oops', 'not a function' as never);
    return {};
  }
}

function options(): InertiaModuleOptions {
  return {
    version: 'v1',
    now: () => clock,
    share: () => {
      count('share');
      return { appName: 'Demo', countries: ['from-share'] };
    },
    shareOnce: (request) => {
      count('shareOnce');
      const url = (request as { url?: string }).url ?? '';
      return {
        countries: () => {
          count('countries');
          return [`CA:${url}`];
        },
        currencies: once(() => {
          count('currencies');
          return ['CAD'];
        }).until(3600),
      };
    },
  };
}

afterAll(closeAll);

describe.each(['express', 'fastify'] as const)(
  'shareOnce on %s',
  { timeout: 60_000 },
  (platform: Platform) => {
    let app: INestApplication;
    beforeAll(async () => {
      app = await boot(
        platform,
        [InertiaModule.forRoot(options())],
        [ShareOnceController],
      );
    });
    beforeEach(clear);

    it('resolves module once props on the first visit and lists them as shared once props', async () => {
      const page = json(
        await send(app, '/dashboard', { headers: inertiaHeaders('v1') }),
      );
      expect(page['props']).toStrictEqual({
        errors: {},
        appName: 'Demo',
        countries: ['CA:/dashboard'],
        currencies: ['CAD'],
        permissions: ['read'],
        title: 'Home',
      });
      expect(page['onceProps']).toStrictEqual({
        countries: { prop: 'countries', expiresAt: null },
        currencies: { prop: 'currencies', expiresAt: clock + 3_600_000 },
        perms: { prop: 'permissions', expiresAt: clock + 60_000 },
      });
      expect(page['sharedProps']).toStrictEqual([
        'errors',
        'appName',
        'countries',
        'currencies',
        'permissions',
      ]);
      expect(calls).toStrictEqual({
        share: 1,
        shareOnce: 1,
        countries: 1,
        currencies: 1,
        permissions: 1,
      });
    });

    it('skips (never evaluates) once-shared props the client reports as loaded', async () => {
      const page = json(
        await send(app, '/dashboard', {
          headers: {
            ...inertiaHeaders('v1'),
            'x-inertia-except-once-props': 'countries,currencies,perms',
          },
        }),
      );
      expect(page['props']).toStrictEqual({
        errors: {},
        appName: 'Demo',
        title: 'Home',
      });
      // The client still needs the metadata to keep its remembered values.
      expect(Object.keys(page['onceProps'] as object).sort()).toStrictEqual([
        'countries',
        'currencies',
        'perms',
      ]);
      expect(calls).toStrictEqual({ share: 1, shareOnce: 1 });
    });

    it('always resolves once-shared props on full (non-Inertia) visits', async () => {
      const response = await send(app, '/dashboard', {
        headers: { 'x-inertia-except-once-props': 'countries' },
      });
      expect(response.status).toBe(200);
      expect(calls['countries']).toBe(1);
    });

    it('lets request-scoped share() override a module once prop, and once props override share()', async () => {
      const page = json(
        await send(app, '/override', { headers: inertiaHeaders('v1') }),
      );
      expect((page['props'] as Record<string, unknown>)['countries']).toEqual([
        'request-scoped',
      ]);
      expect(page['onceProps']).not.toHaveProperty('countries');
      const plain = json(
        await send(app, '/dashboard', { headers: inertiaHeaders('v1') }),
      );
      expect((plain['props'] as Record<string, unknown>)['countries']).toEqual([
        'CA:/dashboard',
      ]);
    });

    it('accepts an existing once() prop and applies the options on top', async () => {
      const page = json(
        await send(app, '/existing-prop', {
          headers: {
            ...inertiaHeaders('v1'),
            'x-inertia-except-once-props': 'plan-list',
          },
        }),
      );
      // fresh: true resolves it even though the client holds it.
      expect((page['props'] as Record<string, unknown>)['plans']).toEqual([
        'basic',
      ]);
      expect(
        (page['onceProps'] as Record<string, unknown>)['plan-list'],
      ).toEqual({ prop: 'plans', expiresAt: null });
    });

    it('rejects a non-callback once-shared value as a configuration error (500)', async () => {
      const response = await send(app, '/bad-callback', {
        headers: inertiaHeaders('v1'),
      });
      expect(response.status).toBe(500);
      expect(response.body).not.toContain('not a function');
    });
  },
);

describe('shareOnce configuration', () => {
  it('rejects a non-function module option', () => {
    expect(() =>
      InertiaModule.forRoot({ shareOnce: {} as never }),
    ).toThrowError(InertiaConfigurationError);
  });

  it.each([
    ['a plain value', { countries: ['CA'] }],
    ['a non-once prop type', { countries: defer(() => ['CA']) }],
    ['null', { countries: null }],
  ])(
    'refuses %s from the shareOnce resolver',
    { timeout: 30_000 },
    async (_label, value) => {
      const app = await boot(
        'express',
        [InertiaModule.forRoot({ shareOnce: () => value as never })],
        [ShareOnceController],
      );
      const response = await send(app, '/override', {
        headers: inertiaHeaders(),
      });
      expect(response.status).toBe(500);
    },
  );

  it('never lets a __proto__ key from the resolver reach Object.prototype', async () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, '__proto__', {
      value: () => ({ polluted: true }),
      enumerable: true,
    });
    const app = await boot(
      'fastify',
      [
        InertiaModule.forRoot({
          shareOnce: () => ({ ...hostile }) as never,
        }),
      ],
      [ShareOnceController],
    );
    const response = await send(app, '/override', {
      headers: inertiaHeaders(),
    });
    expect(response.status).toBe(500);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});
