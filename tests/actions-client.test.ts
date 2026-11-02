import 'reflect-metadata';
import { Injectable, UseGuards } from '@nestjs/common';
import type {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ActionContext,
  ActionError,
  ActionGroup,
  ActionInput,
  ActionSignal,
  ActionsModule,
  ServerAction,
  redirectTo,
  withNotifications,
} from '../packages/actions/dist/index.js';
import {
  ActionClientError,
  createActionsClient,
  isActionClientError,
} from '../packages/actions/dist/client/index.js';
import type {
  ActionDescriptor,
  ActionNotification,
} from '../packages/actions/dist/client/index.js';

const origin = 'http://localhost:4200';
const csrf = 'client-csrf-token-0123456789abcdef';
let app: INestApplication;
let baseUrl: string;
let charges = 0;

@Injectable()
class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>();
    return request.headers['x-role'] === 'admin';
  }
}

@ActionGroup('notes')
class NoteActions {
  @ServerAction({ id: 'create' })
  create(
    @ActionInput() input: { title: string },
    @ActionContext() context: ActionContext,
  ) {
    if (typeof input?.title !== 'string' || input.title.length === 0)
      throw ActionError.validation('Title is required', [
        { path: ['title'], message: 'Required' },
      ]);
    return withNotifications(
      { id: 1, title: input.title, by: context.identity.subject },
      { level: 'success', message: 'Note created' },
    );
  }

  @ServerAction({ id: 'archive' })
  archive() {
    return redirectTo('/notes/archived');
  }

  @ServerAction({ id: 'purge' })
  @UseGuards(AdminGuard)
  purge() {
    return { purged: true };
  }

  @ServerAction({ id: 'charge', idempotent: true })
  charge(@ActionInput() input: { amount: number }) {
    charges++;
    return { charged: input.amount, charges };
  }

  @ServerAction({ id: 'wait' })
  async wait(@ActionSignal() signal: AbortSignal) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { aborted: signal.aborted };
  }
}

beforeAll(async () => {
  const module = await Test.createTestingModule({
    imports: [
      ActionsModule.register({
        groups: [NoteActions],
        origin,
        resolveIdentity: (request) => {
          const headers = Reflect.get(request, 'headers') as Record<
            string,
            string | undefined
          >;
          return headers['x-session'] === 'ada'
            ? { subject: 'ada', csrfToken: csrf }
            : null;
        },
        authorize: () => true,
      }),
    ],
  }).compile();
  app = module.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});
afterAll(async () => {
  await app.close();
});

const descriptors = {
  create: {
    group: 'notes',
    action: 'create',
    version: null,
    idempotent: false,
  },
  archive: {
    group: 'notes',
    action: 'archive',
    version: null,
    idempotent: false,
  },
  purge: { group: 'notes', action: 'purge', version: null, idempotent: false },
  charge: { group: 'notes', action: 'charge', version: null, idempotent: true },
  wait: { group: 'notes', action: 'wait', version: null, idempotent: false },
} satisfies Record<string, ActionDescriptor>;

function client(
  overrides: Parameters<typeof createActionsClient>[0] = {},
  session = 'ada',
) {
  return createActionsClient({
    baseUrl,
    csrf: () => csrf,
    headers: { origin, 'x-session': session },
    ...overrides,
  });
}

describe('typed actions client against a real Nest server', () => {
  it('returns data and delivers notifications and redirects through hooks', async () => {
    const notifications: ActionNotification[] = [];
    const redirects: string[] = [];
    const actions = client({
      onNotifications: (list) => notifications.push(...list),
      onRedirect: (location) => redirects.push(location),
    }).bind({ notes: descriptors });
    expect(await actions['notes']?.['create']?.({ title: 'Hello' })).toEqual({
      id: 1,
      title: 'Hello',
      by: 'ada',
    });
    expect(notifications).toEqual([
      { level: 'success', message: 'Note created' },
    ]);
    expect(await actions['notes']?.['archive']?.()).toBeNull();
    expect(redirects).toEqual(['/notes/archived']);
  });

  it('throws typed errors with code, status, issues and request id', async () => {
    const error = await client()
      .call(descriptors.create, { title: '' })
      .catch((caught: unknown) => caught);
    expect(isActionClientError(error)).toBe(true);
    expect(error).toMatchObject({
      code: 'VALIDATION',
      status: 400,
      message: 'Title is required',
      issues: [{ path: ['title'], message: 'Required' }],
    });
    expect((error as ActionClientError).requestId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(
      client().call(descriptors.purge, undefined),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    await expect(
      client({ csrf: () => null }).call(descriptors.create, { title: 'x' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', reason: 'CSRF' });
    await expect(
      client({}, 'mallory').call(descriptors.create, { title: 'x' }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
  });

  it('sends generated or explicit idempotency keys and surfaces replays', async () => {
    const typed = client({
      createIdempotencyKey: () => 'client-key-0000000000001',
    });
    const first = await typed.call(descriptors.charge, { amount: 3 });
    const second = await typed.call(descriptors.charge, { amount: 3 });
    expect(second).toEqual(first);
    const explicit = await typed.call(
      descriptors.charge,
      { amount: 3 },
      {
        idempotencyKey: 'client-key-0000000000002',
      },
    );
    expect(explicit).toEqual({ charged: 3, charges: 2 });
    await expect(
      typed.call(
        descriptors.charge,
        { amount: 1 },
        { idempotencyKey: 'bad key' },
      ),
    ).rejects.toThrow('Idempotency keys');
  });

  it('cancels with AbortSignal and client deadlines', async () => {
    const controller = new AbortController();
    const pending = client().call(descriptors.wait, undefined, {
      signal: controller.signal,
    });
    controller.abort(new Error('user navigated away'));
    await expect(pending).rejects.toThrow('user navigated away');
    await expect(
      client().call(descriptors.wait, undefined, { timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: 'TIMEOUT', reason: 'CLIENT_DEADLINE' });
  });

  it('normalizes host, proxy, network and malformed responses', async () => {
    const respond = (
      body: string,
      status: number,
      headers: Record<string, string> = {},
    ) =>
      createActionsClient({
        csrf: 'token-0123456789abcdef',
        fetch: (async () =>
          new Response(body, { status, headers })) as typeof fetch,
      });
    await expect(
      respond('{"statusCode":403,"message":"Forbidden resource"}', 403).call(
        descriptors.purge,
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(
      respond('<html>Bad gateway</html>', 502).call(
        descriptors.purge,
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'INTERNAL', status: 502 });
    await expect(
      respond('', 429).call(descriptors.purge, undefined),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    await expect(
      respond(
        '{"statusCode":403,"code":"FORBIDDEN","reason":"CSRF"}',
        403,
      ).call(descriptors.purge, undefined),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', reason: 'CSRF' });
    await expect(
      respond('not json', 200).call(descriptors.purge, undefined),
    ).rejects.toMatchObject({
      code: 'INTERNAL',
      reason: 'INVALID_RESPONSE',
    });
    const unsafeRedirects: string[] = [];
    const unsafe = createActionsClient({
      csrf: 'token-0123456789abcdef',
      onRedirect: (location) => unsafeRedirects.push(location),
      fetch: (async () =>
        new Response(
          JSON.stringify({
            protocol: 'nestvexa-actions/1',
            ok: true,
            requestId: 'r',
            data: 1,
            redirect: { location: '//evil.example' },
          }),
        )) as typeof fetch,
    });
    expect(await unsafe.call(descriptors.archive, undefined)).toBe(1);
    expect(unsafeRedirects).toEqual([]);
    const offline = createActionsClient({
      csrf: 'token-0123456789abcdef',
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    await expect(
      offline.call(descriptors.purge, undefined),
    ).rejects.toMatchObject({
      code: 'INTERNAL',
      reason: 'NETWORK',
      status: 0,
    });
  });

  it('validates descriptors and options before sending anything', () => {
    let calls = 0;
    const counting = createActionsClient({
      fetch: (async () => {
        calls++;
        return new Response('{}');
      }) as typeof fetch,
    });
    expect(() => createActionsClient({ prefix: 'nope' })).toThrow(
      'Invalid actions prefix',
    );
    expect(() =>
      counting.bind({
        notes: {
          bad: { group: '../x', action: 'a', version: null, idempotent: false },
        },
      }),
    ).toThrow('Invalid action descriptor');
    return expect(
      counting.call(
        {
          group: 'notes',
          action: 'Bad Action',
          version: null,
          idempotent: false,
        },
        undefined,
      ),
    )
      .rejects.toThrow('Invalid action descriptor')
      .then(() => expect(calls).toBe(0));
  });
});
