import 'reflect-metadata';
import { Injectable, UseGuards } from '@nestjs/common';
import type { CanActivate, INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ActionContext,
  ActionGroup,
  ActionInput,
  ActionsModule,
  ServerAction,
  acceptJob,
} from '../packages/actions/dist/index.js';
import type {
  ActionDescriptor,
  ActionJobQueue,
  ActionsInstrumentation,
  ActionsLogger,
  ActionsModuleOptions,
} from '../packages/actions/dist/index.js';
import {
  createActionsClient,
  isActionClientError,
} from '../packages/actions/dist/client/index.js';
import type { ActionJobHandle } from '../packages/actions/dist/client/index.js';
import {
  MemoryInstrumentation,
  createLogger,
} from '../packages/observability/dist/index.js';
import { JobRunner } from '../packages/realtime/dist/index.js';

const origin = 'http://localhost:4300';
const sessions: Record<
  string,
  { subject: string; tenant: string; csrfToken: string }
> = {
  alice: {
    subject: 'user-alice',
    tenant: 'acme',
    csrfToken: 'alice-csrf-token-0123456789abcdef',
  },
  bob: {
    subject: 'user-bob',
    tenant: 'globex',
    csrfToken: 'bob-csrf-token-0123456789abcdef00',
  },
};
const apps: INestApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: {
    ok?: boolean;
    data?: unknown;
    requestId?: string;
    job?: {
      id: string;
      status: string;
      progress: number;
      pollAfterMs: number;
      stream?: { channel: string };
    };
    error?: { code: string; reason?: string; message: string };
  };
}

function send(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      { method: 'POST', headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: text ? (JSON.parse(text) as Reply['body']) : {},
          });
        });
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

function gate() {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open: () => open() };
}

@Injectable()
class DenyWithHeader implements CanActivate {
  canActivate(context: import('@nestjs/common').ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>();
    return request.headers['x-deny'] === undefined;
  }
}

async function fixture(
  platform: 'express' | 'fastify',
  { withJobs = true }: { withJobs?: boolean } = {},
) {
  const runner = new JobRunner({ concurrency: 2 });
  const release = { current: gate() };
  const authorized: ActionDescriptor[] = [];
  const settings = { denyJobs: false };

  @ActionGroup('reports')
  @UseGuards(DenyWithHeader)
  class Reports {
    @ServerAction({ id: 'export', job: true })
    export(
      @ActionInput() input: { rows: number; password?: string },
      @ActionContext() context: ActionContext,
    ) {
      const owner = context.identity.subject;
      return acceptJob('export-report', async ({ progress, signal }) => {
        progress(10);
        await release.current.promise;
        if (signal.aborted) throw new Error('cancelled');
        progress(90);
        return { owner, rows: input.rows, url: `/reports/${input.rows}.csv` };
      });
    }

    @ServerAction({ id: 'export-once', job: true, idempotent: true })
    exportOnce() {
      return acceptJob('export-once', async () => ({ done: true }));
    }

    @ServerAction({ id: 'explode', job: true })
    explode() {
      return acceptJob('explode', async () => {
        throw new Error('database password leaked in message');
      });
    }

    @ServerAction({ id: 'not-a-job', job: true })
    notAJob() {
      return { plain: true };
    }

    @ServerAction({ id: 'undeclared' })
    undeclared() {
      return acceptJob('undeclared', async () => null);
    }
  }

  const options: ActionsModuleOptions = {
    groups: [Reports],
    origin,
    resolveIdentity: (request: object) => {
      const headers = Reflect.get(request, 'headers') as Record<
        string,
        string | undefined
      >;
      return sessions[headers['x-session'] ?? ''] ?? null;
    },
    authorize: (_identity, descriptor) => {
      authorized.push(descriptor);
      return !(settings.denyJobs && descriptor.group === '_jobs');
    },
    ...(withJobs
      ? {
          jobs: {
            queue: runner,
            channel: JobRunner.channel,
            pollAfterMs: 100,
            owner: (identity: { readonly subject: string }) => ({
              binding: `user:${identity.subject}`,
            }),
          },
        }
      : {}),
  };
  const module = await Test.createTestingModule({
    imports: [ActionsModule.register(options)],
  }).compile();
  const app =
    platform === 'fastify'
      ? module.createNestApplication(new FastifyAdapter(), { logger: false })
      : module.createNestApplication({ logger: false });
  apps.push(app);
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  const base = `${url}/_nestvexa/actions`;
  const call = (
    path: string,
    input?: unknown,
    user = 'alice',
    extra: Record<string, string> = {},
  ) =>
    send(
      `${base}/${path}`,
      {
        origin,
        'content-type': 'application/json',
        'x-session': user,
        'x-nestvexa-csrf': sessions[user]?.csrfToken ?? 'unknown-token-xxxx',
        ...extra,
      },
      JSON.stringify(input === undefined ? {} : { input }),
    );
  const client = (user = 'alice') =>
    createActionsClient({
      baseUrl: url,
      csrf: sessions[user]?.csrfToken ?? '',
      headers: { origin, 'x-session': user },
    });
  return { runner, release, authorized, settings, call, client, url };
}

describe.each(['express', 'fastify'] as const)(
  'long-running job actions over %s',
  (platform) => {
    it('answers 202 with an owner-bound job ticket, progress and a streaming channel', async () => {
      const f = await fixture(platform);
      const accepted = await f.call('reports/export', { rows: 3 });
      expect(accepted.status).toBe(202);
      expect(accepted.body.ok).toBe(true);
      expect(accepted.body.data).toBeNull();
      const job = accepted.body.job;
      expect(job).toMatchObject({ pollAfterMs: 100 });
      expect(job?.stream?.channel).toBe(`job:${job?.id ?? ''}`);
      const id = job?.id ?? '';

      const running = await f.call('_jobs/status', { id });
      expect(running.status).toBe(200);
      expect(running.body.data).toMatchObject({ id, status: 'running' });
      // Another identity cannot observe the job: indistinguishable from unknown.
      const foreign = await f.call('_jobs/status', { id }, 'bob');
      expect(foreign.status).toBe(404);
      expect(foreign.body.error?.reason).toBe('JOB_NOT_FOUND');
      // The streaming handle is a realtime channel that only the owner may join.
      expect(
        f.runner.authorize({ binding: 'user:user-alice' }, `job:${id}`),
      ).toBe(true);
      expect(
        f.runner.authorize({ binding: 'user:user-bob' }, `job:${id}`),
      ).toBe(false);

      f.release.current.open();
      await expect
        .poll(async () => (await f.call('_jobs/status', { id })).body.data)
        .toEqual({
          id,
          status: 'succeeded',
          progress: 100,
          result: { owner: 'user-alice', rows: 3, url: '/reports/3.csv' },
          error: null,
        });
      expect(f.authorized).toContainEqual({
        group: '_jobs',
        action: 'status',
        version: null,
        idempotent: false,
      });
    });

    it('validates job ids, enforces admission on job routes and supports cancellation', async () => {
      const f = await fixture(platform);
      expect(
        (await f.call('_jobs/status', { id: '../x' })).body.error,
      ).toMatchObject({ code: 'VALIDATION', reason: 'JOB_ID' });
      expect(
        (await f.call('_jobs/status', { id: 'abcdefgh', extra: 1 })).status,
      ).toBe(400);
      const forged = await send(
        `${f.url}/_nestvexa/actions/_jobs/status`,
        {
          origin,
          'content-type': 'application/json',
          'x-session': 'alice',
          'x-nestvexa-csrf': 'forged-token-000000000000000000',
        },
        JSON.stringify({ input: { id: 'abcdefgh' } }),
      );
      expect(forged.body.error?.reason).toBe('CSRF');
      const anonymous = await f.call(
        '_jobs/status',
        { id: 'abcdefgh' },
        'nobody',
      );
      expect(anonymous.status).toBe(401);

      const accepted = await f.call('reports/export', { rows: 1 });
      const id = accepted.body.job?.id ?? '';
      // Host policy is consulted for job routes too (group "_jobs").
      f.settings.denyJobs = true;
      expect((await f.call('_jobs/status', { id })).body.error).toMatchObject({
        code: 'FORBIDDEN',
        reason: 'POLICY',
      });
      f.settings.denyJobs = false;
      expect((await f.call('_jobs/cancel', { id }, 'bob')).status).toBe(404);
      const cancelled = await f.call('_jobs/cancel', { id });
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.data).toMatchObject({ cancelled: true });
      f.release.current.open();
      await expect
        .poll(
          async () =>
            (
              (await f.call('_jobs/status', { id })).body.data as {
                status: string;
              }
            ).status,
        )
        .toBe('cancelled');
    });

    it('replays the same ticket for idempotent job actions and hides job failure details', async () => {
      const f = await fixture(platform);
      const key = 'job-key-0123456789abcdef';
      const first = await f.call('reports/export-once', undefined, 'alice', {
        'idempotency-key': key,
      });
      const second = await f.call('reports/export-once', undefined, 'alice', {
        'idempotency-key': key,
      });
      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body.job?.id).toBe(first.body.job?.id);

      const failed = await f.call('reports/explode');
      const id = failed.body.job?.id ?? '';
      await expect
        .poll(async () => (await f.call('_jobs/status', { id })).body.data)
        .toMatchObject({ status: 'failed', error: 'The job failed.' });
      const text = JSON.stringify((await f.call('_jobs/status', { id })).body);
      expect(text).not.toContain('password');
    });

    it('rejects job contract violations and missing queues', async () => {
      const f = await fixture(platform);
      expect((await f.call('reports/not-a-job')).body.error).toMatchObject({
        code: 'INTERNAL',
        reason: 'JOB_REQUIRED',
      });
      expect((await f.call('reports/undeclared')).body.error).toMatchObject({
        code: 'INTERNAL',
        reason: 'JOB_NOT_DECLARED',
      });
      // Application guards still run for job actions.
      expect(
        (
          await f.call('reports/export', { rows: 1 }, 'alice', {
            'x-deny': '1',
          })
        ).status,
      ).toBe(403);
      const bare = await fixture(platform, { withJobs: false });
      const unavailable = await bare.call('reports/export', { rows: 1 });
      expect(unavailable.status).toBe(503);
      expect(unavailable.body.error?.reason).toBe('JOBS_UNAVAILABLE');
      expect(
        (await bare.call('_jobs/status', { id: 'abcdefgh' })).body.error
          ?.reason,
      ).toBe('JOBS_UNAVAILABLE');
    });
  },
);

describe('job actions through the typed client', () => {
  it('returns a job handle that polls, reports progress, re-attaches and surfaces failures', async () => {
    const f = await fixture('express');
    const client = f.client();
    const handle = (await client.call(
      { group: 'reports', action: 'export', version: null, idempotent: false },
      { rows: 7 },
    )) as ActionJobHandle<{ rows: number }>;
    expect(handle.stream?.channel).toBe(`job:${handle.id}`);
    const progress: number[] = [];
    const done = handle.wait({
      intervalMs: 50,
      onProgress: (snapshot) => progress.push(snapshot.progress),
    });
    await expect.poll(() => progress.length).toBeGreaterThan(0);
    f.release.current.open();
    await expect(done).resolves.toMatchObject({ rows: 7 });
    expect(progress.at(-1)).toBe(100);
    // Re-attach by id (for example after reload) and read the final state.
    await expect(client.job(handle.id).status()).resolves.toMatchObject({
      status: 'succeeded',
    });
    // Bob's client cannot see Alice's job.
    await expect(f.client('bob').job(handle.id).status()).rejects.toMatchObject(
      { code: 'NOT_FOUND', reason: 'JOB_NOT_FOUND' },
    );

    const failing = (await client.call(
      { group: 'reports', action: 'explode', version: null, idempotent: false },
      undefined,
    )) as ActionJobHandle<unknown>;
    const failure = await failing
      .wait({ intervalMs: 50 })
      .catch((error) => error);
    expect(isActionClientError(failure) && failure.reason).toBe('JOB_FAILED');

    f.release.current = gate();
    const slow = (await client.call(
      { group: 'reports', action: 'export', version: null, idempotent: false },
      { rows: 1 },
    )) as ActionJobHandle<unknown>;
    const waiting = slow.wait({ intervalMs: 50 }).catch((error) => error);
    await expect(slow.cancel()).resolves.toBe(true);
    f.release.current.open();
    const cancelled = await waiting;
    expect(isActionClientError(cancelled) && cancelled.reason).toBe(
      'JOB_CANCELLED',
    );
    expect(() => client.job('../etc')).toThrow(TypeError);
  });

  it('is structurally compatible with the realtime JobRunner', () => {
    const queue: ActionJobQueue = new JobRunner();
    expect(typeof queue.enqueue).toBe('function');
  });
});

describe('action tracing and structured logs', () => {
  async function observed(errorEnvelope: 'actions' | 'host' = 'actions') {
    const instrumentation = new MemoryInstrumentation();
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));
    @ActionGroup('account')
    @UseGuards(DenyWithHeader)
    class Account {
      @ServerAction({ id: 'login' })
      login(@ActionInput() input: { email: string; password: string }) {
        if (input.password !== 'correct horse') return { ok: false };
        return { ok: true };
      }
      @ServerAction({ id: 'boom' })
      boom(): never {
        throw new Error('internal secret detail');
      }
    }
    const typedInstrumentation: ActionsInstrumentation = instrumentation;
    const typedLogger: ActionsLogger = logger;
    const module = await Test.createTestingModule({
      imports: [
        ActionsModule.register({
          groups: [Account],
          origin,
          errorEnvelope,
          resolveIdentity: () => sessions['alice'] ?? null,
          authorize: () => true,
          instrumentation: typedInstrumentation,
          logger: typedLogger,
          onError: () => undefined,
        }),
      ],
    }).compile();
    const app = module.createNestApplication({ logger: false });
    apps.push(app);
    await app.listen(0, '127.0.0.1');
    const base = `${await app.getUrl()}/_nestvexa/actions/account`;
    const call = (path: string, input: unknown, extra = {}) =>
      send(
        `${base}/${path}`,
        {
          origin,
          'content-type': 'application/json',
          'x-nestvexa-csrf': sessions['alice']?.csrfToken ?? '',
          ...extra,
        },
        JSON.stringify({ input }),
      );
    return { instrumentation, lines, call };
  }

  it('records one span and one redacted log record per call with the final status', async () => {
    const o = await observed();
    const ok = await o.call('login', {
      email: 'a@example.com',
      password: 'correct horse',
    });
    expect(ok.status).toBe(200);
    await o.call('boom', null);
    await o.call(
      'login',
      { email: 'a@example.com', password: 'x' },
      {
        'x-deny': '1',
      },
    );
    await expect.poll(() => o.instrumentation.records.length).toBe(3);
    const [login, boom, denied] = o.instrumentation.records;
    expect(login).toMatchObject({
      name: 'nestvexa.action',
      outcome: 'ok',
      attributes: {
        'nestvexa.action.group': 'account',
        'nestvexa.action.id': 'login',
        'nestvexa.request_id': ok.body.requestId,
        'http.status_code': 200,
        'nestvexa.action.code': 'OK',
        'nestvexa.action.replayed': false,
      },
    });
    expect(boom).toMatchObject({
      outcome: 'error',
      attributes: {
        'http.status_code': 500,
        'nestvexa.action.code': 'INTERNAL',
      },
    });
    expect(denied).toMatchObject({
      outcome: 'error',
      attributes: {
        'http.status_code': 403,
        'nestvexa.action.code': 'FORBIDDEN',
      },
    });
    const records = o.lines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    expect(
      records.map((record) => [record['level'], record['status']]),
    ).toEqual([
      ['info', 200],
      ['error', 500],
      ['warn', 403],
    ]);
    expect(records[0]).toMatchObject({
      message: 'nestvexa.action',
      group: 'account',
      action: 'login',
      version: null,
      code: 'OK',
      replayed: false,
      requestId: ok.body.requestId,
    });
    expect(typeof records[0]?.['durationMs']).toBe('number');
    // Inputs, identities, CSRF tokens and error messages never reach telemetry.
    const everything = JSON.stringify([o.lines, o.instrumentation.records]);
    for (const secret of [
      'correct horse',
      'a@example.com',
      'internal secret detail',
      'user-alice',
      sessions['alice']?.csrfToken ?? 'missing',
    ])
      expect(everything).not.toContain(secret);
  });

  it('ends spans for rejections that bypass the envelope filter (host error mode)', async () => {
    const o = await observed('host');
    const denied = await o.call(
      'login',
      { email: 'x', password: 'y' },
      {
        'x-deny': '1',
      },
    );
    expect(denied.status).toBe(403);
    await expect.poll(() => o.instrumentation.records.length).toBe(1);
    expect(o.instrumentation.records[0]?.attributes).toMatchObject({
      'http.status_code': 403,
      'nestvexa.action.code': 'FORBIDDEN',
    });
  });

  it('never fails a call because telemetry throws', async () => {
    @ActionGroup('safe')
    class Safe {
      @ServerAction({ id: 'ping' }) ping() {
        return 'pong';
      }
    }
    const module = await Test.createTestingModule({
      imports: [
        ActionsModule.register({
          groups: [Safe],
          origin,
          resolveIdentity: () => sessions['alice'] ?? null,
          authorize: () => true,
          instrumentation: {
            start: () => {
              throw new Error('tracer down');
            },
          },
          logger: {
            info: () => {
              throw new Error('sink down');
            },
            warn: () => undefined,
            error: () => undefined,
          },
        }),
      ],
    }).compile();
    const app = module.createNestApplication({ logger: false });
    apps.push(app);
    await app.listen(0, '127.0.0.1');
    const reply = await send(
      `${await app.getUrl()}/_nestvexa/actions/safe/ping`,
      {
        origin,
        'content-type': 'application/json',
        'x-nestvexa-csrf': sessions['alice']?.csrfToken ?? '',
      },
      '{}',
    );
    expect(reply.body.data).toBe('pong');
  });

  it('validates instrumentation, logger and jobs host options', () => {
    const base = {
      groups: [],
      origin,
      resolveIdentity: () => null,
      authorize: () => true,
    };
    @ActionGroup('opts')
    class Opts {
      @ServerAction({ id: 'x' }) x() {
        return null;
      }
    }
    const register = (extra: object) =>
      ActionsModule.register({
        ...base,
        groups: [Opts],
        ...extra,
      } as ActionsModuleOptions);
    expect(() => register({ instrumentation: {} })).toThrow(/instrumentation/);
    expect(() => register({ logger: { info() {} } })).toThrow(/logger/);
    expect(() => register({ jobs: {} })).toThrow(/jobs.queue/);
    expect(() =>
      register({ jobs: { queue: new JobRunner(), extra: true } }),
    ).toThrow(/Unknown actions jobs option/);
    expect(() =>
      register({ jobs: { queue: new JobRunner(), pollAfterMs: 5 } }),
    ).toThrow(/pollAfterMs/);
    expect(() =>
      ServerAction({ id: 'bad', job: 'yes' as unknown as boolean }),
    ).toThrow(/job must be a boolean/);
    expect(() => acceptJob('Bad Name', async () => null)).toThrow(TypeError);
    expect(() => acceptJob('ok', async () => null, { maxAttempts: 9 })).toThrow(
      TypeError,
    );
  });
});
