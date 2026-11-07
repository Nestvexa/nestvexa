import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../packages/cli/dist/index.js';
import {
  boot,
  freshApp,
  idempotent,
  json,
  ok,
  read,
  tsc,
} from './support/cli-fixture.js';
import type { BootedApp } from './support/cli-fixture.js';
import { respDouble } from './support/resp-double.js';
import type { RespDouble } from './support/resp-double.js';

// Assigned ports for this suite: 3481 (app) and 3482 (RESP test double).
const port = 3481;
const redisPort = 3482;

/**
 * The CLI on a Fastify host: init (with @fastify/session), every add command
 * that used to refuse Fastify (engines, Inertia, islands, uploads, realtime,
 * redis) and the generators, type-checked under the strictest flags and booted
 * against a RESP test double standing in for Redis.
 */
describe(
  'generators and add on a strict ESM Nest Fastify app',
  { timeout: 90_000 },
  () => {
    let root = '';
    let app: BootedApp | undefined;
    let redis: RespDouble | undefined;
    beforeAll(() => {
      root = freshApp('fastify-app', {
        platform: 'fastify',
        directory: 'cli-fastify',
      });
    });
    afterAll(async () => {
      app?.stop();
      await redis?.close();
    });

    it('initializes with @fastify/session guest sessions', () => {
      ok(run(['init'], root));
      const pkg = JSON.parse(read(root, 'package.json')) as {
        dependencies: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      expect(pkg.dependencies).toMatchObject({
        '@fastify/cookie': '11.1.5',
        '@fastify/session': '11.1.6',
      });
      expect(pkg.dependencies['express-session']).toBeUndefined();
      expect(pkg.devDependencies?.['@types/express-session']).toBeUndefined();
      const main = read(root, 'src/main.ts');
      expect(main).toContain('await configureSession(app);');
      expect(main).toContain(
        "import { configureSession } from './nestvexa/session.js';",
      );
      expect(main.indexOf('configureSession(app)')).toBeLessThan(
        main.indexOf('configureNestvexa(app)'),
      );
      expect(main).not.toContain('express-session');
      const session = read(root, 'src/nestvexa/session.ts');
      expect(session).toContain('await fastify.register(fastifySession, {');
      expect(session).toContain('secret: sessionSecret(),');
      expect(read(root, 'src/nestvexa/nestvexa.config.ts')).toContain(
        "Reflect.get(session, 'sessionId')",
      );
      expect(json(run(['init', '--json'], root))).toMatchObject({ ok: true });
    });

    it('adds engines, Inertia, islands, uploads, realtime and redis', () => {
      for (const engine of ['ejs', 'pug', 'nunjucks']) {
        idempotent(root, ['add', 'engine', engine]);
        ok(run(['make:page', `Reports-${engine}`, '--renderer', engine], root));
      }
      expect(read(root, 'src/nestvexa/engines/ejs.engine.ts')).toContain(
        "await registerViewEngine(app, 'ejs', ejsEngine);",
      );
      idempotent(root, ['add', 'react']);
      ok(run(['make:page', 'Dashboard', '--renderer', 'react'], root));
      idempotent(root, ['add', 'islands']);
      ok(run(['make:island', 'Chart', '--renderer', 'react'], root));
      for (const feature of ['uploads', 'realtime', 'redis', 'devtools'])
        idempotent(root, ['add', feature]);
      const pkg = JSON.parse(read(root, 'package.json')) as {
        dependencies: Record<string, string>;
      };
      expect(pkg.dependencies).toMatchObject({
        '@nestvexa/realtime-redis': '^0.1.0-alpha.0',
        '@nestvexa/live': '^0.1.0-alpha.0',
        '@nestvexa/uploads': '^0.1.0-alpha.0',
      });
      const realtime = read(root, 'src/nestvexa/realtime.config.ts');
      expect(realtime).toContain('broker: realtimeBroker()');
      expect(realtime).toContain("Reflect.get(session, 'sessionId')");
      expect(realtime).toContain(
        "import { realtimeBroker } from './redis.config.js';",
      );
      const live = read(root, 'src/nestvexa/nestvexa.config.ts');
      expect(live).toContain('store: liveStore()');
      expect(live).toContain('realtime');
      expect(read(root, 'src/nestvexa/uploads.config.ts')).toContain(
        "Reflect.get(session, 'sessionId')",
      );
      expect(read(root, 'src/main.ts')).toContain(
        'await configureUploads(app);',
      );
      // The inertia session flag follows @fastify/session.
      expect(read(root, 'src/nestvexa/inertia.config.ts')).not.toContain(
        'session: false',
      );
    });

    it('runs the generators', () => {
      ok(run(['make:form', 'Contact'], root));
      ok(run(['make:action', 'Billing'], root));
      expect(read(root, 'src/nestvexa/actions.config.ts')).toContain(
        "Reflect.get(session, 'sessionId')",
      );
      ok(run(['make:component', 'Clock'], root));
      ok(run(['make:resource', 'Invoice', '--crud'], root));
      ok(run(['make:layout', 'Admin'], root));
      ok(run(['make:policy', 'Owner'], root));
      ok(run(['make:test', 'Clock'], root));
    });

    it('type-checks the server and the React clients', () => {
      const server = tsc(root);
      expect(server.status, server.output).toBe(0);
      for (const project of [
        'client/react/tsconfig.json',
        'client/islands/tsconfig.json',
      ]) {
        const result = tsc(root, project);
        expect(result.status, `${project}\n${result.output}`).toBe(0);
      }
    }, 240_000);

    it('boots on Fastify: Live through @fastify/session and Redis, engines, Inertia, actions', async () => {
      redis = await respDouble({ port: redisPort });
      app = await boot(root, port, {
        REDIS_URL: `redis://127.0.0.1:${redisPort}`,
        REDIS_PREFIX: 'cli-fastify:',
      });
      const { origin } = app;
      const page = await fetch(`${origin}/nestvexa`);
      const html = await page.text();
      expect(page.status, html).toBe(200);
      expect(html).toContain('data-nv-name="counter"');
      const cookie = page.headers.get('set-cookie')?.split(';')[0] ?? '';
      expect(cookie).toMatch(/^sessionId=/);
      expect(page.headers.get('set-cookie')).toMatch(/HttpOnly/i);
      const snapshot = /data-nv-snapshot="([^"]+)"/.exec(html)?.[1];
      const csrf = /data-nv-csrf="([^"]+)"/.exec(html)?.[1];
      const body = JSON.stringify({
        protocol: 'nestvexa-live/1',
        requestId: crypto.randomUUID(),
        snapshot,
        revision: 0,
        updates: {},
        input: null,
      });
      const headers = {
        origin,
        'content-type': 'application/json',
        'x-nestvexa-csrf': csrf ?? '',
      };
      // Without the session cookie the identity is unknown.
      const anonymous = await fetch(
        `${origin}/_nestvexa/live/counter/increment`,
        { method: 'POST', headers, body },
      );
      expect([401, 403]).toContain(anonymous.status);
      const action = await fetch(`${origin}/_nestvexa/live/counter/increment`, {
        method: 'POST',
        headers: { ...headers, cookie },
        body,
      });
      expect(action.status, await action.clone().text()).toBe(201);
      expect(
        ((await action.json()) as { state: { count: number } }).state.count,
      ).toBe(1);
      // Live state lives in the (double of) Redis under the configured prefix.
      expect(
        [...redis.values.keys()].some((key) =>
          key.startsWith('cli-fastify:live:'),
        ),
      ).toBe(true);
      for (const [path, engine] of [
        ['/reports-ejs', 'EJS'],
        ['/reports-pug', 'Pug'],
        ['/reports-nunjucks', 'Nunjucks'],
      ] as const) {
        const response = await fetch(`${origin}${path}`);
        const text = await response.text();
        expect(response.status, text).toBe(200);
        expect(text).toContain(`page rendered by ${engine}`);
        expect(text).toMatch(/<main><h1>Reports(Ejs|Pug|Nunjucks)<\/h1>/);
      }
      const document = await (await fetch(`${origin}/dashboard`)).text();
      expect(document).toContain('data-page="app"');
      expect(document).toContain(
        'http://localhost:5173/build/react/@vite/client',
      );
      const version =
        /&quot;version&quot;:&quot;([^&]+)&quot;|"version":"([^"]+)"/.exec(
          document,
        );
      const inertia = await fetch(`${origin}/dashboard`, {
        headers: {
          'X-Inertia': 'true',
          'X-Inertia-Version': version?.[1] ?? version?.[2] ?? '',
        },
      });
      expect(inertia.status, document.slice(0, 2000)).toBe(200);
      expect(await inertia.json()).toMatchObject({
        component: 'Dashboard',
        props: { title: 'Dashboard' },
      });
      expect(await (await fetch(`${origin}/invoice`)).json()).toEqual({
        items: [],
        total: 0,
        page: 1,
        size: 20,
      });
      const greet = await fetch(`${origin}/_nestvexa/actions/billing/greet`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json', cookie },
        body: JSON.stringify({ input: { name: 'Ada' } }),
      });
      // A session without the action CSRF header is still refused.
      expect([401, 403]).toContain(greet.status);
    }, 180_000);

    it('reports Fastify sessions in the doctor and keeps the Redis URL secret', () => {
      const saved = { ...process.env };
      try {
        process.env['REDIS_URL'] = 'redis://user:hunter2-secret@redis:6379/0';
        const report = run(['doctor', '--json'], root);
        const checks = Object.fromEntries(
          (json(report).data as { name: string; status: string }[]).map(
            (check) => [check.name, check.status],
          ),
        );
        expect(checks).toMatchObject({
          platform: 'pass',
          session: 'pass',
          csrf: 'pass',
          redis: 'pass',
        });
        expect(report.stdout.join('\n')).not.toContain('hunter2-secret');
        delete process.env['REDIS_URL'];
        const production = run(['doctor', '--production', '--json'], root);
        expect(
          (json(production).data as { name: string; status: string }[]).find(
            (check) => check.name === 'redis',
          ),
        ).toMatchObject({ status: 'warn' });
      } finally {
        process.env = saved;
      }
      writeFileSync(
        join(root, 'src/nestvexa/session.ts'),
        read(root, 'src/nestvexa/session.ts').replace(
          'register(fastifySession',
          'register(otherPlugin',
        ),
      );
      expect(
        (
          json(run(['doctor', '--json'], root)).data as {
            name: string;
            status: string;
          }[]
        ).find((check) => check.name === 'session'),
      ).toMatchObject({ status: 'warn' });
      expect(existsSync(join(root, 'src/nestvexa/redis.config.ts'))).toBe(true);
    });
  },
);
