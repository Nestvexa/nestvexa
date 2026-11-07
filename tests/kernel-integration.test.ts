/**
 * Kernel integration (CORE-043, CORE-047, CORE-048): the umbrella wires
 * `SecurityPolicyRegistry`, `RequestContextFactory` and `DiagnosticsRegistry`
 * into Live (the registry is the only policy source Live consults), uploads
 * (policies and quotas registered and enforced through the registry), views
 * (`nvRequest` public context and CSP nonce), actions (correlation IDs) and
 * the devtools panel, on real Express and Fastify servers.
 */
import 'reflect-metadata';
import {
  Controller,
  Get,
  Inject,
  Module,
  Render,
  Req,
  Res,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Action,
  DiagnosticsRegistry,
  FeatureCapabilityRegistry,
  LiveComponent,
  LiveRuntime,
  NestvexaModule,
  RequestContextFactory,
  SecurityPolicyRegistry,
  State,
  configureNestvexa,
} from '../packages/nestvexa/dist/index.js';
import {
  UploadsModule,
  configureUploads,
} from '../packages/uploads/dist/index.js';
import {
  ActionGroup,
  ActionsModule,
  ServerAction,
} from '../packages/actions/dist/index.js';
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

const origin = 'http://127.0.0.1:3841';
const csrf = 'kernel-integration-csrf-0123456789abcdef';
const binding = 'kernel-integration/session/0001';
const executions: string[] = [];

@LiveComponent({ name: 'kernel-probe', view: 'kernel-probe' })
class KernelProbe {
  @State() count = 0;
  @Action() increment(): void {
    executions.push('increment');
    this.count++;
  }
}

@Controller()
class Pages {
  constructor(
    @Inject(RequestContextFactory)
    private readonly contexts: RequestContextFactory,
    @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost,
  ) {}
  @Get('page')
  @Render('page')
  async page(
    @Req() request: object,
    @Res({ passthrough: true }) response: object,
  ) {
    // The controller and the view see one context: the header nonce matches.
    const context = await this.contexts.create(request);
    this.host.httpAdapter.setHeader(
      response,
      'Content-Security-Policy',
      `script-src 'nonce-${context.cspNonce}'`,
    );
    return { title: 'Kernel page' };
  }
}

@ActionGroup('kernel')
class KernelActions {
  @ServerAction({ id: 'ping' })
  ping() {
    return { pong: true };
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
  Buffer.from('kernel-integration-png'),
]);

describe.each(['express', 'fastify'] as const)(
  'kernel services wired through the umbrella: %s',
  (platform) => {
    async function start() {
      const root = await temporary('nestvexa-kernel-views-');
      const uploads = await temporary('nestvexa-kernel-uploads-');
      await writeFile(join(root, 'kernel-probe.hbs'), '<p>{{count}}</p>');
      await writeFile(
        join(root, 'page.hbs'),
        '<p id="nonce">{{nvRequest.cspNonce}}</p><p id="id">{{nvRequest.correlationId}}</p><p id="auth">{{nvRequest.authenticated}}</p><p id="session">{{nvRequest.session}}</p>',
      );
      const identity = () => ({ binding, csrfToken: csrf });
      @Module({
        imports: [
          NestvexaModule.forRoot(
            { views: { root }, live: { enabled: true } },
            {
              components: [KernelProbe],
              useFactory: () => ({
                origin,
                maxRequestsPerMinute: 1_000,
                resolveIdentity: identity,
                authorize: (_identity, _component, action) =>
                  action !== 'denied',
              }),
            },
            {
              // Kernel services are visible to the uploads/devtools factories.
              global: true,
              requestContext: {
                resolveSession: () => 'server-only-session-value',
              },
            },
          ),
          UploadsModule.registerAsync({
            inject: [SecurityPolicyRegistry, DiagnosticsRegistry],
            useFactory: (
              policies: SecurityPolicyRegistry,
              diagnostics: DiagnosticsRegistry,
            ) => ({
              origin,
              directory: uploads,
              resolveIdentity: identity,
              authorize: () => true,
              purposes: { avatar: { types: ['png'], maxFileSize: 4096 } },
              quotas: { identityFiles: 7, identityBytes: 65_536 },
              policies,
              instrumentation: diagnostics.instrumentation(),
            }),
          }),
          DevtoolsModule.registerAsync({
            environment: 'development',
            inject: [
              DiagnosticsRegistry,
              SecurityPolicyRegistry,
              FeatureCapabilityRegistry,
            ],
            useFactory: (
              diagnostics: DiagnosticsRegistry,
              security: SecurityPolicyRegistry,
              capabilities: FeatureCapabilityRegistry,
            ) => ({
              instrumentation: new MemoryInstrumentation(),
              authorize: () => true,
              kernel: { diagnostics, security, capabilities },
            }),
          }),
        ],
        controllers: [Pages],
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
      const live = async (
        action: string,
        headers: Record<string, string> = {},
      ) => {
        const html = (
          await app.get(LiveRuntime).mount(KernelProbe, { headers: {} })
        ).value;
        const snapshot = /data-nv-snapshot="([^"]+)"/.exec(html)?.[1] ?? '';
        const response = await fetch(
          `${base}/_nestvexa/live/kernel-probe/${action}`,
          {
            method: 'POST',
            headers: {
              origin,
              'content-type': 'application/json',
              'x-nestvexa-csrf': csrf,
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
      const upload = (headers: Record<string, string> = {}) =>
        fetch(`${base}/_nestvexa/uploads/files`, {
          method: 'POST',
          headers: {
            origin,
            'x-nestvexa-csrf': csrf,
            'content-type': 'application/octet-stream',
            'x-nestvexa-upload-purpose': 'avatar',
            'x-nestvexa-upload-name': 'face.png',
            ...headers,
          },
          body: PNG,
        });
      return { app, base, live, upload };
    }

    it('Live registers its policies once and enforces only what the registry decides', async () => {
      const { app, live } = await start();
      const security = app.get(SecurityPolicyRegistry);
      expect(security.report()['live']).toEqual({
        origin: { configured: true },
        csrf: { configured: true },
        'action-authorization': { configured: true },
        snapshot: { storage: 'server', ttlMs: 900_000, bindsIdentity: true },
      });
      const origins = vi.spyOn(security, 'originAllowed');
      const tokens = vi.spyOn(security, 'verifyCsrf');
      const decisions = vi.spyOn(security, 'authorize');
      executions.length = 0;
      expect((await live('increment')).status).toBe(201);
      expect(executions).toEqual(['increment']);
      expect(origins).toHaveBeenCalledWith('live', origin);
      expect(tokens).toHaveBeenCalledWith(
        'live',
        expect.any(Object),
        expect.objectContaining({ binding }),
      );
      expect(decisions).toHaveBeenCalledWith(
        'live',
        expect.objectContaining({ binding }),
        'kernel-probe',
        'increment',
      );
      // One source of truth: when the registry says no, Live has no other copy.
      origins.mockReturnValue(false);
      expect(await live('increment')).toEqual({
        status: 403,
        body: { statusCode: 403, code: 'ORIGIN_REJECTED' },
      });
      origins.mockRestore();
      tokens.mockResolvedValue(false);
      expect((await live('increment')).body['code']).toBe('CSRF_REJECTED');
      tokens.mockRestore();
      // Mounting still needs `$mount`; only the action decision is refused.
      decisions.mockImplementation(
        async (_owner, _subject, _resource, action) => action === '$mount',
      );
      expect((await live('increment')).body['code']).toBe('ACTION_FORBIDDEN');
      decisions.mockRestore();
      expect(executions).toEqual(['increment']);
      // Negative paths still go through the registry policies themselves.
      expect(
        (await live('increment', { origin: 'http://evil.test' })).status,
      ).toBe(403);
      expect(
        (await live('increment', { 'x-nestvexa-csrf': 'x'.repeat(40) })).body[
          'code'
        ],
      ).toBe('CSRF_REJECTED');
      expect(executions).toEqual(['increment']);
      // The owner is reserved: a second registration fails closed.
      expect(() =>
        security.register('origin', 'live', { allowed: () => true }),
      ).toThrow(/Duplicate origin policy for live/);
    });

    it('Live spans carry the kernel correlation ID', async () => {
      const { app, live } = await start();
      const diagnostics = app.get(DiagnosticsRegistry);
      diagnostics.clear();
      expect(
        (await live('increment', { 'x-request-id': 'kernel-trace-0001' }))
          .status,
      ).toBe(201);
      const spans = diagnostics.recent({
        kind: 'span',
        prefix: 'nestvexa.live',
      });
      const action = spans.find((span) => span.name === 'nestvexa.live.action');
      const admit = spans.find((span) => span.name === 'nestvexa.live.admit');
      expect(action?.attributes['nestvexa.request_id']).toBe(
        'kernel-trace-0001',
      );
      expect(admit?.attributes['nestvexa.request_id']).toBe(
        'kernel-trace-0001',
      );
      expect(JSON.stringify(spans)).not.toContain(csrf);
    });

    it('uploads register their quotas and enforce policies through the registry', async () => {
      const { app, upload } = await start();
      const security = app.get(SecurityPolicyRegistry);
      expect(security.report()['uploads']).toEqual({
        origin: { configured: true },
        csrf: { configured: true },
        'action-authorization': { configured: true },
        'upload-quota': {
          maxFileBytes: 4096,
          maxFiles: 7,
          maxTotalBytes: 65_536,
        },
      });
      expect(security.uploadAllowed('uploads', [4096, 100])).toBe(true);
      expect(security.uploadAllowed('uploads', [4097])).toBe(false);
      const diagnostics = app.get(DiagnosticsRegistry);
      diagnostics.clear();
      const accepted = await upload();
      expect(accepted.status).toBe(201);
      expect(
        diagnostics.recent({ prefix: 'nestvexa.upload.receive' }),
      ).toHaveLength(1);
      expect((await upload({ origin: 'http://evil.test' })).status).toBe(403);
      expect(
        (
          (await (
            await upload({ 'x-nestvexa-csrf': 'y'.repeat(40) })
          ).json()) as {
            code: string;
          }
        ).code,
      ).toBe('CSRF_REJECTED');
      const decisions = vi
        .spyOn(security, 'authorize')
        .mockResolvedValue(false);
      const forbidden = await upload();
      expect(forbidden.status).toBe(403);
      expect(((await forbidden.json()) as { code: string }).code).toBe(
        'UPLOAD_FORBIDDEN',
      );
      expect(decisions).toHaveBeenCalledWith(
        'uploads',
        expect.objectContaining({ binding }),
        'avatar',
        'upload',
      );
    });

    it('views read the public request context; the CSP nonce matches the controller', async () => {
      const { base } = await start();
      const response = await fetch(`${base}/page`, {
        headers: { 'x-request-id': 'kernel-view-trace-01' },
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      // Handlebars escapes `=` in text content; attributes get the raw value.
      const nonce = /<p id="nonce">([^<]+)<\/p>/
        .exec(html)?.[1]
        ?.replaceAll('&#x3D;', '=');
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      expect(response.headers.get('content-security-policy')).toBe(
        `script-src 'nonce-${nonce ?? ''}'`,
      );
      expect(html).toContain('<p id="id">kernel-view-trace-01</p>');
      expect(html).toContain('<p id="auth">false</p>');
      // Server-only fields never reach templates.
      expect(html).toContain('<p id="session"></p>');
      expect(html).not.toContain('server-only-session-value');
      const second = await (await fetch(`${base}/page`)).text();
      expect(/<p id="nonce">([^<]+)<\/p>/.exec(second)?.[1]).not.toBe(nonce);
    });

    it('devtools shows kernel policies, capabilities and diagnostics without secrets', async () => {
      const { base, live } = await start();
      expect((await live('increment')).status).toBe(201);
      const response = await fetch(`${base}/_nestvexa/devtools/data.json`);
      expect(response.status).toBe(200);
      const data = (await response.json()) as DevtoolsSnapshot;
      expect(Object.keys(data.kernel.policies).sort()).toEqual([
        'live',
        'uploads',
      ]);
      expect(data.kernel.policies['uploads']?.['upload-quota']).toEqual({
        maxFileBytes: 4096,
        maxFiles: 7,
        maxTotalBytes: 65_536,
      });
      expect(data.kernel.diagnostics.map((record) => record.name)).toContain(
        'nestvexa.live.action',
      );
      expect(JSON.stringify(data)).not.toContain(csrf);
      const page = await (await fetch(`${base}/_nestvexa/devtools`)).text();
      expect(page).toContain('id="policies"');
      expect(page).toContain('<code>upload-quota</code>');
      expect(page).toContain('id="diagnostics"');
    });
  },
);

describe.each(['express', 'fastify'] as const)(
  'actions correlation through RequestContextFactory: %s',
  (platform) => {
    it('uses the kernel correlation ID as the action request ID', async () => {
      const module = await Test.createTestingModule({
        imports: [
          NestvexaModule.forRoot({}, undefined, { global: true }),
          ActionsModule.registerAsync({
            groups: [KernelActions],
            inject: [RequestContextFactory],
            useFactory: (requestContext: RequestContextFactory) => ({
              origin,
              resolveIdentity: () => ({
                subject: 'kernel-user',
                csrfToken: csrf,
              }),
              authorize: () => true,
              requestContext,
            }),
          }),
        ],
      }).compile();
      const app: INestApplication =
        platform === 'fastify'
          ? module.createNestApplication(new FastifyAdapter(), {
              logger: false,
            })
          : module.createNestApplication({ logger: false });
      await app.listen(0, '127.0.0.1');
      cleanup.push(() => app.close());
      const base = await app.getUrl();
      const call = (headers: Record<string, string>) =>
        fetch(`${base}/_nestvexa/actions/kernel/ping`, {
          method: 'POST',
          headers: {
            origin,
            'content-type': 'application/json',
            'x-nestvexa-csrf': csrf,
            ...headers,
          },
          body: '{}',
        });
      const traced = await call({ 'x-request-id': 'kernel-action-trace-1' });
      expect(traced.status).toBe(200);
      expect(traced.headers.get('x-nestvexa-request-id')).toBe(
        'kernel-action-trace-1',
      );
      expect(((await traced.json()) as { requestId: string }).requestId).toBe(
        'kernel-action-trace-1',
      );
      const malformed = await call({ 'x-request-id': 'no' });
      const id = malformed.headers.get('x-nestvexa-request-id') ?? '';
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(
        ((await malformed.json()) as { requestId: string }).requestId,
      ).toBe(id);
    });
  },
);
