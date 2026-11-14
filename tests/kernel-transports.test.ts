/**
 * Kernel round 5 on real Express and Fastify servers:
 *
 * - CORE-047: server actions, Inertia and the uploads multipart form path
 *   register their origin, CSRF and authorization policies in
 *   `SecurityPolicyRegistry` and enforce only what the registry decides.
 * - CORE-043 / DATA-017: with the opt-in kernel identity, MVC views, Live,
 *   Inertia, server actions, uploads and realtime see one principal and one
 *   tenant from `RequestContextFactory`; a client-supplied tenant is never
 *   trusted and every policy is re-checked server-side on every request.
 * - CORE-039 / CORE-046: every feature registers itself and its
 *   capabilities in `NestvexaRegistry`; devtools lists them.
 */
import 'reflect-metadata';
import {
  Controller,
  Get,
  Inject,
  Module,
  Post,
  Render,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Action,
  DiagnosticsRegistry,
  FeatureCapabilityRegistry,
  LiveComponent,
  LiveRuntime,
  NestvexaModule,
  NestvexaRegistry,
  RequestContextFactory,
  SecurityPolicyRegistry,
  State,
  configureNestvexa,
} from '../packages/nestvexa/dist/index.js';
import {
  UploadsModule,
  UploadsService,
  configureUploads,
} from '../packages/uploads/dist/index.js';
import {
  ActionContext,
  ActionGroup,
  ActionsModule,
  ServerAction,
} from '../packages/actions/dist/index.js';
import {
  InertiaModule,
  InertiaPage,
  InertiaSecurityGuard,
} from '../packages/inertia/dist/index.js';
import {
  RealtimeModule,
  RealtimeService,
} from '../packages/realtime/dist/index.js';
import {
  DevtoolsModule,
  MemoryInstrumentation,
} from '../packages/observability/dist/index.js';
import type { DevtoolsSnapshot } from '../packages/observability/dist/index.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const step of cleanup.splice(0).reverse()) await step();
});

const origin = 'http://127.0.0.1:4061';
const xsrf = 'kernel-transports-xsrf-0123456789';
const secret = 'kernel-transports-realtime-secret-0123456789abcdef';

/** The server-side session store: the only source of user and tenant. */
interface SessionRecord {
  user: string;
  roles: string[];
  tenant: string;
}
const sessions = new Map<string, SessionRecord>();
function resetSessions(): void {
  sessions.clear();
  sessions.set('s-alice', { user: 'alice', roles: ['member'], tenant: 'acme' });
  sessions.set('s-bob', { user: 'bob', roles: ['member'], tenant: 'globex' });
}
function headerOf(request: object, name: string): string | undefined {
  const headers: unknown = Reflect.get(request, 'headers');
  if (typeof headers !== 'object' || headers === null) return undefined;
  const value: unknown = Reflect.get(headers, name);
  return typeof value === 'string' ? value : undefined;
}
function sid(request: object): string {
  return (
    /(?:^|;\s*)sid=([\w-]+)/.exec(headerOf(request, 'cookie') ?? '')?.[1] ?? ''
  );
}
const binding = (request: object) => `kernel-session/${sid(request)}`;
const csrfOf = (request: object) =>
  `csrf-${sid(request)}-0123456789abcdefghijklmnop`;
const cookie = (id: string) => `sid=${id}`;

/** Every host policy decision: which transport saw which user and tenant. */
interface Decision {
  readonly transport: string;
  readonly principal: string | undefined;
  readonly tenant: string | undefined;
}
const decisions: Decision[] = [];
function decide(
  transport: string,
  identity: {
    readonly principal?: {
      readonly id: string;
      readonly roles?: readonly string[];
    };
    readonly tenant?: string;
  },
): boolean {
  decisions.push({
    transport,
    principal: identity.principal?.id,
    tenant: identity.tenant,
  });
  // Re-checked on every request against the current server-side roles.
  return identity.principal?.roles?.includes('member') === true;
}

const executions: string[] = [];
@LiveComponent({ name: 'kernel-probe', view: 'kernel-probe' })
class KernelProbe {
  @State() count = 0;
  @Action() increment(): void {
    executions.push('increment');
    this.count++;
  }
}

@ActionGroup('kernel')
class KernelActions {
  @ServerAction({ id: 'whoami' })
  whoami(@ActionContext() context: ActionContext) {
    return {
      subject: context.identity.subject,
      principal: context.identity.principal?.id ?? null,
      tenant: context.identity.tenant ?? null,
    };
  }
  @ServerAction({ id: 'whoami', version: 2 })
  whoamiV2() {
    return { version: 2 };
  }
}

@Controller()
class Pages {
  constructor(
    @Inject(UploadsService) private readonly uploads: UploadsService,
  ) {}
  @Get('page')
  @Render('page')
  page() {
    return { title: 'Kernel page' };
  }
  @Post('form')
  async form(
    @Req() request: object,
    @Res({ passthrough: true }) response: object,
  ) {
    const result = await this.uploads.receiveForm(
      request,
      { purpose: 'avatar' },
      response,
    );
    return { files: result.files.length };
  }
}

@Controller('inertia')
@UseGuards(InertiaSecurityGuard)
class InertiaPages {
  @Get('dashboard')
  @InertiaPage('Dashboard')
  dashboard() {
    return { greeting: 'hello' };
  }
  @Get('secret')
  @InertiaPage('Secret')
  secret() {
    return { greeting: 'hidden' };
  }
  @Post('save')
  save() {
    executions.push('inertia-save');
    return { saved: true };
  }
}

async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(async () => {
    if (dirname(resolve(root)) !== resolve(tmpdir()))
      throw new Error('Unsafe cleanup');
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('kernel-transports-png'),
]);
function multipart(parts: readonly { name: string; value?: string }[]): {
  body: Buffer;
  type: string;
} {
  const boundary = '----nestvexa-kernel-transports';
  const chunks: Buffer[] = [];
  for (const part of parts)
    chunks.push(
      part.value === undefined
        ? Buffer.concat([
            Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="face.png"\r\nContent-Type: image/png\r\n\r\n`,
            ),
            PNG,
            Buffer.from('\r\n'),
          ])
        : Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`,
          ),
    );
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    type: `multipart/form-data; boundary=${boundary}`,
  };
}

describe.each(['express', 'fastify'] as const)(
  'kernel transports on %s',
  (platform) => {
    async function start() {
      resetSessions();
      decisions.length = 0;
      executions.length = 0;
      const root = await temporary('nestvexa-kernel5-views-');
      const uploads = await temporary('nestvexa-kernel5-uploads-');
      await writeFile(join(root, 'kernel-probe.hbs'), '<p>{{count}}</p>');
      await writeFile(
        join(root, 'page.hbs'),
        '<p id="tenant">{{nvRequest.tenant}}</p><p id="auth">{{nvRequest.authenticated}}</p>',
      );
      const session = (request: object) => sessions.get(sid(request));
      @Module({
        imports: [
          NestvexaModule.forRoot(
            { views: { root }, live: { enabled: true } },
            {
              components: [KernelProbe],
              kernelIdentity: true,
              useFactory: () => ({
                origin,
                maxRequestsPerMinute: 1_000,
                resolveIdentity: (request: object) => ({
                  binding: binding(request),
                  csrfToken: csrfOf(request),
                }),
                authorize: (identity) => decide('live', identity),
              }),
            },
            {
              global: true,
              requestContext: {
                resolvePrincipal: (request) => {
                  const record = session(request);
                  return (
                    record && { id: record.user, roles: [...record.roles] }
                  );
                },
                resolveTenant: (request) => session(request)?.tenant,
              },
            },
          ),
          ActionsModule.registerAsync({
            groups: [KernelActions],
            inject: [
              SecurityPolicyRegistry,
              RequestContextFactory,
              NestvexaRegistry,
            ],
            useFactory: (
              policies: SecurityPolicyRegistry,
              kernelIdentity: RequestContextFactory,
              featureRegistry: NestvexaRegistry,
            ) => ({
              origin,
              resolveIdentity: (request: object) => {
                const record = session(request);
                if (!record) return null;
                // A host bug that trusts a header must not change the user or tenant.
                const forged = headerOf(request, 'x-impersonate');
                const tenant = headerOf(request, 'x-host-tenant');
                return {
                  subject: forged ?? record.user,
                  ...(tenant === undefined ? {} : { tenant }),
                  csrfToken: csrfOf(request),
                };
              },
              authorize: (identity) => decide('actions', identity),
              policies,
              kernelIdentity,
              featureRegistry,
            }),
          }),
          UploadsModule.registerAsync({
            inject: [
              SecurityPolicyRegistry,
              RequestContextFactory,
              NestvexaRegistry,
            ],
            useFactory: (
              policies: SecurityPolicyRegistry,
              kernelIdentity: RequestContextFactory,
              featureRegistry: NestvexaRegistry,
            ) => ({
              origin,
              directory: uploads,
              resolveIdentity: (request: object) => {
                const tenant = headerOf(request, 'x-host-tenant');
                return {
                  binding: binding(request),
                  csrfToken: csrfOf(request),
                  ...(tenant === undefined ? {} : { tenant }),
                };
              },
              authorize: (identity) => decide('uploads', identity),
              purposes: { avatar: { types: ['png'], maxFileSize: 4096 } },
              policies,
              kernelIdentity,
              featureRegistry,
            }),
          }),
          InertiaModule.forRootAsync({
            inject: [
              SecurityPolicyRegistry,
              RequestContextFactory,
              NestvexaRegistry,
            ],
            useFactory: (
              policies: SecurityPolicyRegistry,
              kernelIdentity: RequestContextFactory,
              featureRegistry: NestvexaRegistry,
            ) => ({
              security: {
                origin,
                csrfToken: () => xsrf,
                authorize: (identity, component) =>
                  component !== 'Secret' && decide('inertia', identity),
              },
              // A host share of the same name never replaces the kernel's.
              share: () => ({
                nvIdentity: { authenticated: false, tenant: 'forged' },
              }),
              policies,
              kernelIdentity,
              featureRegistry,
            }),
          }),
          RealtimeModule.forRootAsync({
            inject: [RequestContextFactory, NestvexaRegistry],
            useFactory: (
              kernelIdentity: RequestContextFactory,
              featureRegistry: NestvexaRegistry,
            ) => ({
              secrets: [secret],
              origin,
              resolveIdentity: (request: object) => ({
                binding: binding(request),
              }),
              authorizeChannel: (identity, channel) =>
                channel === `tenant:${identity.tenant ?? ''}` &&
                decide('realtime', identity),
              kernelIdentity,
              featureRegistry,
            }),
          }),
          DevtoolsModule.registerAsync({
            environment: 'development',
            inject: [
              DiagnosticsRegistry,
              SecurityPolicyRegistry,
              FeatureCapabilityRegistry,
              NestvexaRegistry,
            ],
            useFactory: (
              diagnostics: DiagnosticsRegistry,
              security: SecurityPolicyRegistry,
              capabilities: FeatureCapabilityRegistry,
              features: NestvexaRegistry,
            ) => ({
              instrumentation: new MemoryInstrumentation(),
              authorize: () => true,
              kernel: { diagnostics, security, capabilities, features },
            }),
          }),
        ],
        controllers: [Pages, InertiaPages],
      })
      class AppModule {}
      const module = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      const app: INestApplication =
        platform === 'fastify'
          ? module.createNestApplication(new FastifyAdapter(), {
              logger: false,
            })
          : module.createNestApplication({ logger: false });
      await configureUploads(app);
      await configureNestvexa(app);
      await app.listen(0, '127.0.0.1');
      cleanup.push(() => app.close());
      const base = await app.getUrl();
      const mount = async (id: string) => {
        const html = (
          await app
            .get(LiveRuntime)
            .mount(KernelProbe, { headers: { cookie: cookie(id) } })
        ).value;
        return /data-nv-snapshot="([^"]+)"/.exec(html)?.[1] ?? '';
      };
      const live = async (
        id: string,
        snapshot: string,
        headers: Record<string, string> = {},
      ) => {
        const response = await fetch(
          `${base}/_nestvexa/live/kernel-probe/increment`,
          {
            method: 'POST',
            headers: {
              origin,
              cookie: cookie(id),
              'content-type': 'application/json',
              'x-nestvexa-csrf': csrfOf({ headers: { cookie: cookie(id) } }),
              ...headers,
            },
            body: JSON.stringify({
              protocol: 'nestvexa-live/1',
              requestId: randomUUID(),
              snapshot,
              revision: 0,
              updates: {},
              input: null,
            }),
          },
        );
        return {
          status: response.status,
          body: (await response.json()) as Record<string, unknown>,
        };
      };
      const action = async (
        id: string,
        headers: Record<string, string> = {},
        path = 'kernel/whoami',
        body: unknown = {},
      ) => {
        const response = await fetch(`${base}/_nestvexa/actions/${path}`, {
          method: 'POST',
          headers: {
            origin,
            cookie: cookie(id),
            'content-type': 'application/json',
            'x-nestvexa-csrf': csrfOf({ headers: { cookie: cookie(id) } }),
            ...headers,
          },
          body: JSON.stringify(body),
        });
        return {
          status: response.status,
          body: (await response.json()) as {
            data?: Record<string, unknown>;
            error?: { code?: string; reason?: string };
          },
        };
      };
      const upload = async (
        id: string,
        headers: Record<string, string> = {},
      ) => {
        const response = await fetch(`${base}/_nestvexa/uploads/files`, {
          method: 'POST',
          headers: {
            origin,
            cookie: cookie(id),
            'x-nestvexa-csrf': csrfOf({ headers: { cookie: cookie(id) } }),
            'content-type': 'application/octet-stream',
            'x-nestvexa-upload-purpose': 'avatar',
            'x-nestvexa-upload-name': 'face.png',
            ...headers,
          },
          body: PNG,
        });
        return {
          status: response.status,
          body: (await response.json()) as { code?: string; token?: string },
        };
      };
      const form = async (
        id: string,
        parts: readonly { name: string; value?: string }[],
      ) => {
        const { body, type } = multipart(parts);
        const response = await fetch(`${base}/form`, {
          method: 'POST',
          headers: { origin, cookie: cookie(id), 'content-type': type },
          body: new Uint8Array(body),
        });
        return {
          status: response.status,
          body: (await response.json()) as { code?: string; files?: number },
        };
      };
      const inertia = async (
        id: string,
        path: string,
        init: { method?: string; headers?: Record<string, string> } = {},
      ) => {
        const response = await fetch(`${base}/inertia/${path}`, {
          method: init.method ?? 'GET',
          headers: {
            cookie: cookie(id),
            // Inertia visits are GETs; the POST is a plain host route.
            ...((init.method ?? 'GET') === 'GET'
              ? { 'x-inertia': 'true' }
              : {}),
            accept: 'text/html, application/xhtml+xml',
            ...init.headers,
          },
        });
        return {
          status: response.status,
          body: (await response.json()) as {
            props?: Record<string, unknown>;
            code?: string;
            saved?: boolean;
          },
        };
      };
      // The SSE status only; the socket is destroyed so the stream never outlives the check.
      const realtime = (id: string, token: string) =>
        new Promise<number>((settle, fail) => {
          const outgoing = httpRequest(
            `${base}/_nestvexa/realtime/sse?t=${encodeURIComponent(token)}`,
            { headers: { cookie: cookie(id) } },
            (incoming) => {
              settle(incoming.statusCode ?? 0);
              incoming.destroy();
              outgoing.destroy();
            },
          );
          outgoing.on('error', fail);
          outgoing.end();
        });
      const signRealtime = async (id: string, channel: string) => {
        const service = app.get(RealtimeService);
        const request = { headers: { cookie: cookie(id) } };
        const identity = await service.identity(
          request,
          service.options.resolveIdentity,
        );
        return (await service.sign(identity, [channel])) ?? '';
      };
      return {
        app,
        base,
        mount,
        live,
        action,
        upload,
        form,
        inertia,
        realtime,
        signRealtime,
      };
    }

    it('server actions register their policies and enforce only what the registry decides', async () => {
      const { app, action } = await start();
      const security = app.get(SecurityPolicyRegistry);
      expect(security.report()['actions']).toEqual({
        origin: { configured: true },
        csrf: { configured: true },
        'action-authorization': { configured: true },
      });
      const origins = vi.spyOn(security, 'originAllowed');
      const tokens = vi.spyOn(security, 'verifyCsrf');
      const authorize = vi.spyOn(security, 'authorize');
      expect((await action('s-alice')).status).toBe(200);
      expect(origins).toHaveBeenCalledWith('actions', origin);
      expect(tokens).toHaveBeenCalledWith(
        'actions',
        expect.any(Object),
        expect.objectContaining({ subject: 'alice' }),
      );
      expect(authorize).toHaveBeenCalledWith(
        'actions',
        expect.objectContaining({ subject: 'alice' }),
        'kernel',
        'whoami',
        expect.any(Object),
      );
      // Versioned actions are addressed as `<id>/v<version>`.
      expect((await action('s-alice', {}, 'kernel/whoami/v2')).status).toBe(
        200,
      );
      expect(authorize).toHaveBeenLastCalledWith(
        'actions',
        expect.any(Object),
        'kernel',
        'whoami/v2',
        expect.any(Object),
      );
      origins.mockReturnValue(false);
      expect((await action('s-alice')).body.error?.reason).toBe('ORIGIN');
      origins.mockRestore();
      tokens.mockResolvedValue(false);
      expect((await action('s-alice')).body.error?.reason).toBe('CSRF');
      tokens.mockRestore();
      authorize.mockResolvedValue(false);
      const denied = await action('s-alice');
      expect(denied.status).toBe(403);
      expect(denied.body.error?.reason).toBe('POLICY');
      authorize.mockRestore();
      // The registered policies still reject on their own.
      expect(
        (await action('s-alice', { origin: 'http://evil.test' })).body.error
          ?.reason,
      ).toBe('ORIGIN');
      expect(
        (await action('s-alice', { 'x-nestvexa-csrf': 'x'.repeat(40) })).body
          .error?.reason,
      ).toBe('CSRF');
      // A host route asking without the request is denied (fails closed).
      expect(
        await security.authorize(
          'actions',
          { subject: 'alice' },
          'kernel',
          'whoami',
        ),
      ).toBe(false);
      expect(() =>
        security.register('origin', 'actions', { allowed: () => true }),
      ).toThrow(/Duplicate origin policy for actions/);
    });

    it('Inertia registers origin, CSRF and page authorization and enforces them through the registry', async () => {
      const { app, inertia } = await start();
      const security = app.get(SecurityPolicyRegistry);
      expect(security.report()['inertia']).toEqual({
        origin: { configured: true },
        csrf: { configured: true },
        'action-authorization': { configured: true },
      });
      const save = (headers: Record<string, string>) =>
        inertia('s-alice', 'save', { method: 'POST', headers });
      expect((await save({ origin })).body.code).toBe('CSRF_REJECTED');
      expect(
        (await save({ origin: 'http://evil.test', 'x-xsrf-token': xsrf })).body
          .code,
      ).toBe('ORIGIN_REJECTED');
      expect(
        (
          await save({
            origin,
            'x-xsrf-token': encodeURIComponent('y'.repeat(32)),
          })
        ).status,
      ).toBe(403);
      expect(executions).toEqual([]);
      const tokens = vi.spyOn(security, 'verifyCsrf');
      const saved = await save({ origin, 'x-xsrf-token': xsrf });
      expect(saved.body.saved).toBe(true);
      expect(executions).toEqual(['inertia-save']);
      expect(tokens).toHaveBeenCalledWith('inertia', expect.any(Object));
      // The registry is the only source: when it says no, the token does not help.
      tokens.mockResolvedValue(false);
      expect((await save({ origin, 'x-xsrf-token': xsrf })).body.code).toBe(
        'CSRF_REJECTED',
      );
      tokens.mockRestore();
      expect(executions).toEqual(['inertia-save']);
      // Every page render asks the registry for the component.
      const authorize = vi.spyOn(security, 'authorize');
      expect((await inertia('s-alice', 'dashboard')).status).toBe(200);
      expect(authorize).toHaveBeenCalledWith(
        'inertia',
        expect.objectContaining({ tenant: 'acme' }),
        'Dashboard',
        'render',
        expect.any(Object),
      );
      expect(await inertia('s-alice', 'secret')).toMatchObject({
        status: 403,
        body: { code: 'PAGE_FORBIDDEN' },
      });
      authorize.mockResolvedValue(false);
      expect((await inertia('s-alice', 'dashboard')).status).toBe(403);
    });

    it('the uploads multipart CSRF field is decided by the registered policy', async () => {
      const { app, form } = await start();
      const security = app.get(SecurityPolicyRegistry);
      const token = csrfOf({ headers: { cookie: cookie('s-alice') } });
      const tokens = vi.spyOn(security, 'verifyCsrf');
      expect(
        await form('s-alice', [
          { name: '_csrf', value: token },
          { name: 'file' },
        ]),
      ).toEqual({ status: 201, body: { files: 1 } });
      expect(tokens).toHaveBeenCalledWith(
        'uploads',
        expect.any(Object),
        expect.objectContaining({ tenant: 'acme' }),
        token,
      );
      expect(
        (
          await form('s-alice', [
            { name: '_csrf', value: 'z'.repeat(40) },
            { name: 'file' },
          ])
        ).body.code,
      ).toBe('CSRF_REJECTED');
      // Another session's token is refused too.
      expect(
        (
          await form('s-bob', [
            { name: '_csrf', value: token },
            { name: 'file' },
          ])
        ).body.code,
      ).toBe('CSRF_REJECTED');
      expect((await form('s-alice', [{ name: 'file' }])).body.code).toBe(
        'CSRF_REJECTED',
      );
      tokens.mockResolvedValue(false);
      expect(
        await form('s-alice', [
          { name: '_csrf', value: token },
          { name: 'file' },
        ]),
      ).toMatchObject({ status: 403, body: { code: 'CSRF_REJECTED' } });
      expect(app.get(UploadsService).pendingCount).toBe(1);
    });

    it('one user and tenant context is seen identically by MVC, Live, Inertia, actions, uploads and realtime', async () => {
      const {
        base,
        mount,
        live,
        action,
        upload,
        inertia,
        realtime,
        signRealtime,
      } = await start();
      // A forged client tenant (header and body) is ignored everywhere.
      const forged = { 'x-tenant-id': 'globex', 'x-nestvexa-tenant': 'globex' };
      const page = await (
        await fetch(`${base}/page`, {
          headers: { cookie: cookie('s-alice'), ...forged },
        })
      ).text();
      expect(page).toContain('<p id="tenant">acme</p>');
      expect(page).toContain('<p id="auth">true</p>');
      const snapshot = await mount('s-alice');
      expect((await live('s-alice', snapshot, forged)).status).toBe(201);
      const page2 = await inertia('s-alice', 'dashboard', { headers: forged });
      expect(page2.status).toBe(200);
      expect(page2.body.props?.['nvIdentity']).toEqual({
        authenticated: true,
        tenant: 'acme',
      });
      expect(JSON.stringify(page2.body)).not.toContain('alice');
      const called = await action('s-alice', forged, 'kernel/whoami', {
        input: { tenant: 'globex' },
      });
      expect(called.status).toBe(400);
      const whoami = await action('s-alice', forged);
      expect(whoami.body.data).toEqual({
        subject: 'alice',
        principal: 'alice',
        tenant: 'acme',
      });
      expect((await upload('s-alice', forged)).status).toBe(201);
      const token = await signRealtime('s-alice', 'tenant:acme');
      expect(token).not.toBe('');
      expect(await realtime('s-alice', token)).toBe(200);
      const seen = new Set(
        decisions.map(
          ({ transport, principal, tenant }) =>
            `${transport}:${principal ?? '-'}:${tenant ?? '-'}`,
        ),
      );
      expect([...seen].sort()).toEqual([
        'actions:alice:acme',
        'inertia:alice:acme',
        'live:alice:acme',
        'realtime:alice:acme',
        'uploads:alice:acme',
      ]);
      // Bob's tenant cannot use alice's realtime token (bindings are scoped).
      expect(await realtime('s-bob', token)).toBe(403);
      expect(await signRealtime('s-bob', 'tenant:acme')).toBe('');
    });

    it('re-checks every policy server-side and fails closed on identity mismatches', async () => {
      const { mount, live, action, upload, inertia, realtime, signRealtime } =
        await start();
      const snapshot = await mount('s-alice');
      const token = await signRealtime('s-alice', 'tenant:acme');
      // Revoke membership on the server: the next request of every transport is denied.
      const alice = sessions.get('s-alice');
      if (!alice) throw new Error('missing session');
      alice.roles = [];
      expect((await live('s-alice', snapshot)).body['code']).toBe(
        'ACTION_FORBIDDEN',
      );
      expect((await action('s-alice')).body.error?.reason).toBe('POLICY');
      expect((await upload('s-alice')).body.code).toBe('UPLOAD_FORBIDDEN');
      expect((await inertia('s-alice', 'dashboard')).status).toBe(403);
      expect(await realtime('s-alice', token)).toBe(403);
      expect(executions).toEqual([]);
      alice.roles = ['member'];
      // A snapshot minted for one tenant does not survive a tenant switch of the session.
      alice.tenant = 'globex';
      expect((await live('s-alice', snapshot)).status).toBeGreaterThanOrEqual(
        400,
      );
      expect(executions).toEqual([]);
      alice.tenant = 'acme';
      expect((await live('s-alice', snapshot)).status).toBe(201);
      // The host may only repeat the kernel user and tenant.
      expect(
        (await action('s-alice', { 'x-impersonate': 'mallory' })).body.error,
      ).toMatchObject({ code: 'UNAUTHENTICATED', reason: 'IDENTITY_MISMATCH' });
      expect(
        (await action('s-alice', { 'x-host-tenant': 'globex' })).body.error
          ?.reason,
      ).toBe('IDENTITY_MISMATCH');
      expect(
        await upload('s-alice', { 'x-host-tenant': 'globex' }),
      ).toMatchObject({
        status: 401,
        body: { code: 'IDENTITY_REQUIRED' },
      });
      // Anonymous: no host identity for actions; Inertia pages are not authorized.
      expect((await action('s-unknown')).status).toBe(401);
      expect((await inertia('s-unknown', 'dashboard')).status).toBe(403);
    });

    it('every feature registers itself and its capabilities; devtools lists them', async () => {
      const { app, base } = await start();
      const registry = app.get(NestvexaRegistry);
      expect(
        registry
          .features()
          .map((feature) => feature.name)
          .sort(),
      ).toEqual(['actions', 'inertia', 'live', 'realtime', 'uploads', 'views']);
      expect(registry.components()).toEqual(['live:kernel-probe']);
      expect(registry.actions()).toEqual([
        'actions:kernel/whoami',
        'actions:kernel/whoami/v2',
      ]);
      expect(registry.renderers()).toEqual(['hbs']);
      expect(registry.sealed).toBe(true);
      const capabilities = app.get(FeatureCapabilityRegistry);
      expect(capabilities.get('live.kernel-identity')).toEqual({
        supported: true,
      });
      expect(capabilities.get('uploads.scan')).toMatchObject({
        supported: false,
      });
      expect(capabilities.get('realtime.broker')).toMatchObject({
        supported: true,
        degraded: expect.stringContaining('memory broker'),
      });
      expect(capabilities.get('inertia.security')).toEqual({ supported: true });
      expect(capabilities.get('views.hbs.streaming')).toMatchObject({
        supported: false,
      });
      expect(capabilities.get('views.hbs.async-composition')).toEqual({
        supported: true,
      });
      const data = (await (
        await fetch(`${base}/_nestvexa/devtools/data.json`)
      ).json()) as DevtoolsSnapshot;
      expect(
        data.kernel.features.map((feature) => feature.name).sort(),
      ).toEqual(['actions', 'inertia', 'live', 'realtime', 'uploads', 'views']);
      expect(
        data.kernel.features.find((feature) => feature.name === 'live')
          ?.components,
      ).toEqual(['kernel-probe']);
      const panel = await (await fetch(`${base}/_nestvexa/devtools`)).text();
      expect(panel).toContain('id="features"');
      expect(panel).toContain('<code>@nestvexa/realtime</code>');
    });
  },
);
