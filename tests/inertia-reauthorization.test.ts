import 'reflect-metadata';
import {
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  NotFoundException,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import type {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  InertiaModule,
  InertiaPage,
  defer,
  optional,
} from '../packages/inertia/dist/index.js';
import {
  boot,
  closeAll,
  inertiaHeaders,
  json,
  send,
} from './inertia-support.js';
import type { Platform } from './inertia-support.js';

// SEC-007: deferred and partial-reload props are re-authorized. A partial
// reload is an ordinary GET to the same route, so the host guard and every
// policy inside the handler and its prop factories run again for the identity
// of *that* request; nothing from the initial visit's authorization is reused.

/** Host-owned permission table, mutated by tests to model revocation. */
const grants = new Map<string, Set<string>>();
const reports = new Map([
  ['r1', { owner: 'alice', title: 'Q3 board pack' }],
  ['r2', { owner: 'bob', title: 'Bob private notes' }],
]);
let guardRuns = 0;
let factoryRuns: string[] = [];

function identity(request: object): string | undefined {
  const value = (request as { headers: Record<string, unknown> }).headers[
    'x-test-user'
  ];
  return typeof value === 'string' ? value : undefined;
}
function can(user: string, permission: string): boolean {
  return grants.get(user)?.has(permission) ?? false;
}

/** Authentication: an identity with any grant may reach the routes. */
@Injectable()
class SessionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    guardRuns++;
    const user = identity(context.switchToHttp().getRequest<object>());
    if (!user || !grants.has(user)) throw new ForbiddenException();
    return true;
  }
}

@Controller('reports')
@UseGuards(SessionGuard)
class ReportsController {
  @Get(':id')
  @InertiaPage('Reports/Show')
  show(@Param('id') id: string, @Req() request: object) {
    const user = identity(request) ?? '';
    const report = reports.get(id);
    // Resource ownership: checked by the handler on every request, including
    // partial reloads, before any prop (deferred or not) is returned.
    if (!report || (report.owner !== user && !can(user, 'reports.all')))
      throw new NotFoundException();
    return {
      title: report.title,
      // Deferred prop whose factory re-checks the policy when it resolves.
      summary: defer(() => {
        factoryRuns.push(`summary:${user}`);
        if (!can(user, 'reports.read')) throw new ForbiddenException();
        return `summary-of-${id}-for-${user}`;
      }),
      // Field-level policy: the prop only exists for identities allowed to
      // see it, so no partial-reload header can select it for anyone else.
      ...(can(user, 'reports.salaries')
        ? {
            salaries: defer(() => {
              factoryRuns.push(`salaries:${user}`);
              return `salaries-of-${id}`;
            }, 'admin'),
          }
        : {}),
      // A rescued deferred prop that fails its policy is omitted, not leaked.
      audit: defer(() => {
        factoryRuns.push(`audit:${user}`);
        if (!can(user, 'reports.audit')) throw new ForbiddenException();
        return `audit-of-${id}`;
      }).rescue(),
      history: optional(() => {
        factoryRuns.push(`history:${user}`);
        if (!can(user, 'reports.read')) throw new ForbiddenException();
        return [`history-of-${id}`];
      }),
    };
  }
}

function as(user: string, partial?: string): Record<string, string> {
  return {
    ...inertiaHeaders('authz'),
    'x-test-user': user,
    ...(partial === undefined
      ? {}
      : {
          'x-inertia-partial-component': 'Reports/Show',
          'x-inertia-partial-data': partial,
        }),
  };
}

describe.each(['express', 'fastify'] as const)(
  'Inertia partial reloads re-authorize on %s',
  (platform: Platform) => {
    let app: INestApplication;
    beforeAll(async () => {
      app = await boot(
        platform,
        [InertiaModule.forRoot({ version: 'authz' })],
        [ReportsController],
        { providers: [SessionGuard] },
      );
    });
    afterAll(closeAll);
    beforeEach(() => {
      grants.clear();
      grants.set('alice', new Set(['reports.read', 'reports.salaries']));
      grants.set('bob', new Set(['reports.read']));
      guardRuns = 0;
      factoryRuns = [];
    });

    it('runs the guard again for every partial reload and denies a revoked identity', async () => {
      const visit = json(
        await send(app, '/reports/r1', { headers: as('alice') }),
      );
      expect(visit['deferredProps']).toStrictEqual({
        default: ['summary', 'audit'],
        admin: ['salaries'],
      });
      expect(guardRuns).toBe(1);
      expect(factoryRuns).toEqual([]);
      const allowed = json(
        await send(app, '/reports/r1', { headers: as('alice', 'summary') }),
      );
      expect(allowed['props']).toMatchObject({
        summary: 'summary-of-r1-for-alice',
      });
      expect(guardRuns).toBe(2);
      // Logout / revocation between the visit and the deferred request.
      grants.delete('alice');
      factoryRuns = [];
      const revoked = await send(app, '/reports/r1', {
        headers: as('alice', 'summary,salaries'),
      });
      expect(revoked.status).toBe(403);
      expect(guardRuns).toBe(3);
      expect(factoryRuns).toEqual([]);
      expect(revoked.body).not.toContain('summary-of');
      expect(revoked.body).not.toContain('salaries-of');
      expect(revoked.headers['x-inertia']).toBeUndefined();
    });

    it('never resolves a prop the handler withheld, whatever the partial headers request', async () => {
      const visit = json(
        await send(app, '/reports/r2', { headers: as('bob') }),
      );
      expect(visit['deferredProps']).toStrictEqual({
        default: ['summary', 'audit'],
      });
      for (const partial of [
        'salaries',
        'salaries,summary',
        'admin',
        'salaries.0',
      ]) {
        const page = json(
          await send(app, '/reports/r2', { headers: as('bob', partial) }),
        );
        expect(page['props']).not.toHaveProperty('salaries');
        expect(JSON.stringify(page)).not.toContain('salaries-of');
      }
      // An except list cannot widen the selection either.
      const except = json(
        await send(app, '/reports/r2', {
          headers: {
            ...as('bob'),
            'x-inertia-partial-component': 'Reports/Show',
            'x-inertia-partial-except': 'title',
          },
        }),
      );
      expect(except['props']).not.toHaveProperty('salaries');
      expect(factoryRuns.filter((run) => run.startsWith('salaries'))).toEqual(
        [],
      );
    });

    it('re-checks the policy inside deferred and optional factories at resolution time', async () => {
      const visit = json(
        await send(app, '/reports/r2', { headers: as('bob') }),
      );
      expect(visit['props']).not.toHaveProperty('summary');
      // Bob stays authenticated (the guard passes) but loses read access
      // before the client's deferred request arrives.
      grants.set('bob', new Set(['reports.basic']));
      for (const partial of ['summary', 'history']) {
        const denied = await send(app, '/reports/r2', {
          headers: as('bob', partial),
        });
        expect(denied.status).toBe(403);
        expect(denied.body).not.toContain('summary-of');
        expect(denied.body).not.toContain('history-of');
        expect(denied.body).not.toContain('Bob private notes');
      }
      expect(factoryRuns).toEqual(['summary:bob', 'history:bob']);
    });

    it('omits a rescued deferred prop whose policy fails and lists it as rescued', async () => {
      const page = json(
        await send(app, '/reports/r1', { headers: as('alice', 'audit') }),
      );
      expect(page['props']).not.toHaveProperty('audit');
      expect(page['rescuedProps']).toStrictEqual(['audit']);
      expect(JSON.stringify(page)).not.toContain('audit-of');
      grants.get('alice')?.add('reports.audit');
      const granted = json(
        await send(app, '/reports/r1', { headers: as('alice', 'audit') }),
      );
      expect(granted['props']).toMatchObject({ audit: 'audit-of-r1' });
    });

    it('re-checks resource ownership on partial reloads of another identity’s resource', async () => {
      const own = json(
        await send(app, '/reports/r1', { headers: as('alice', 'summary') }),
      );
      expect(own['props']).toMatchObject({
        summary: 'summary-of-r1-for-alice',
      });
      factoryRuns = [];
      for (const partial of ['summary', 'title', 'history', 'audit']) {
        const foreign = await send(app, '/reports/r1', {
          headers: as('bob', partial),
        });
        expect(foreign.status).toBe(404);
        expect(foreign.body).not.toContain('Q3 board pack');
        expect(foreign.body).not.toContain('summary-of');
      }
      expect(factoryRuns).toEqual([]);
    });

    it('resolves interleaved partial reloads with the identity of each request only', async () => {
      grants.set('carol', new Set(['reports.read', 'reports.all']));
      const users = ['alice', 'carol'];
      const pages = await Promise.all(
        Array.from({ length: 30 }, (_, index) =>
          send(app, '/reports/r1', {
            headers: as(users[index % 2] ?? 'alice', 'summary'),
          }).then(json),
        ),
      );
      pages.forEach((page, index) => {
        expect(page['props']).toMatchObject({
          summary: `summary-of-r1-for-${users[index % 2] ?? 'alice'}`,
        });
      });
      expect(guardRuns).toBe(30);
    });
  },
);
