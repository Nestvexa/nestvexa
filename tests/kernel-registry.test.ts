/**
 * Kernel registries round 5 (CORE-039, CORE-043, CORE-046, CORE-047):
 * `NestvexaRegistry` (installed features, components, safe actions, views,
 * renderer adapters, capabilities and plugins), the kernel request identity
 * (`RequestContextFactory.identity`) and the extended policy contracts
 * (form-field CSRF tokens and the authorized request reach the policy).
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import {
  CoreModule,
  FeatureCapabilityRegistry,
  NestvexaError,
  NestvexaExtensionHost,
  NestvexaRegistry,
  RequestContextFactory,
  SecurityPolicyRegistry,
  defineExtension,
} from '../packages/core/dist/index.js';

function registry(): {
  readonly features: NestvexaRegistry;
  readonly capabilities: FeatureCapabilityRegistry;
} {
  const capabilities = new FeatureCapabilityRegistry();
  return { features: new NestvexaRegistry(capabilities), capabilities };
}
function code(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    return error instanceof NestvexaError ? error.code : 'OTHER';
  }
  return undefined;
}

describe('NestvexaRegistry', () => {
  it('lists features with their components, actions, views, renderers and capabilities', () => {
    const { features, capabilities } = registry();
    features.registerFeature({
      name: 'live',
      package: '@nestvexa/live',
      components: ['todo-list', 'counter'],
      views: ['counter', 'todo-list'],
      capabilities: {
        realtime: { supported: false, reason: 'No realtime signer configured' },
        'state-store': { supported: true, degraded: 'Process-local store' },
      },
    });
    features.registerFeature({
      name: 'actions',
      package: '@nestvexa/actions',
      version: '0.1.0-alpha.0',
      actions: ['cart/add', 'cart/add/v2'],
      capabilities: { jobs: { supported: true } },
    });
    features.registerFeature({
      name: 'views',
      package: 'nestvexa',
      renderers: ['hbs'],
    });
    expect(features.has('live')).toBe(true);
    expect(features.components()).toEqual(['live:counter', 'live:todo-list']);
    expect(features.actions()).toEqual([
      'actions:cart/add',
      'actions:cart/add/v2',
    ]);
    expect(features.views()).toEqual(['live:counter', 'live:todo-list']);
    expect(features.renderers()).toEqual(['hbs']);
    expect(features.get('actions').version).toBe('0.1.0-alpha.0');
    // One source: feature capabilities are declared in the capability registry.
    expect(capabilities.report()).toEqual({
      'live.realtime': {
        supported: false,
        reason: 'No realtime signer configured',
      },
      'live.state-store': { supported: true, degraded: 'Process-local store' },
      'actions.jobs': { supported: true },
    });
    expect(features.get('live').capabilities).toEqual({
      'live.realtime': {
        supported: false,
        reason: 'No realtime signer configured',
      },
      'live.state-store': { supported: true, degraded: 'Process-local store' },
    });
    expect(code(() => capabilities.require('live.realtime'))).toBe(
      'UNSUPPORTED_CAPABILITY',
    );
    const report = features.report();
    expect(report.features.map((feature) => feature.name)).toEqual([
      'live',
      'actions',
      'views',
    ]);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.features[0])).toBe(true);
    expect(Object.isFrozen(report.features[0]?.components)).toBe(true);
    // Data only: the report survives JSON unchanged (no functions or classes).
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    features.require('views');
    expect(code(() => features.require('uploads'))).toBe(
      'UNSUPPORTED_CAPABILITY',
    );
    expect(code(() => features.get('uploads'))).toBe('UNKNOWN_REGISTRATION');
  });

  it('rejects malformed, duplicate and late registrations', () => {
    const { features } = registry();
    const base = { name: 'live', package: '@nestvexa/live' };
    features.registerFeature(base);
    expect(code(() => features.registerFeature(base))).toBe(
      'DUPLICATE_REGISTRATION',
    );
    for (const feature of [
      { name: 'Live', package: 'x' },
      { name: '__proto__', package: 'x' },
      { name: 'other', package: 'Not A Package' },
      { name: 'other', package: 'x', version: 'one' },
      { name: 'other', package: 'x', components: ['ok', 'ok'] },
      { name: 'other', package: 'x', components: ['../escape path'] },
      { name: 'other', package: 'x', actions: 'cart/add' },
      { name: 'other', package: 'x', capabilities: [] },
      {
        name: 'other',
        package: 'x',
        capabilities: { Bad: { supported: true } },
      },
      {
        name: 'other',
        package: 'x',
        capabilities: { missing: { supported: false } },
      },
      { name: 'other', package: 'x', render: () => 'html' },
    ])
      expect(
        code(() =>
          features.registerFeature(
            feature as unknown as Parameters<
              NestvexaRegistry['registerFeature']
            >[0],
          ),
        ),
      ).toBe('INVALID_CONFIGURATION');
    expect(features.features().map((feature) => feature.name)).toEqual([
      'live',
    ]);
    features.seal();
    expect(features.sealed).toBe(true);
    expect(
      code(() =>
        features.registerFeature({ name: 'late', package: '@nestvexa/late' }),
      ),
    ).toBe('REGISTRY_SEALED');
  });

  it('is a kernel service that lists plugins and seals once the application bootstrapped', async () => {
    const module = await Test.createTestingModule({
      imports: [
        CoreModule.forRoot(
          {},
          {
            extensions: [
              defineExtension({ name: 'audit', version: '1.2.3' }),
              defineExtension({ name: 'metrics' }),
            ],
          },
        ),
      ],
    }).compile();
    const app = module.createNestApplication({ logger: false });
    const features = app.get(NestvexaRegistry);
    // Registered at instantiation time, before lifecycle hooks seal anything.
    features.registerFeature({
      name: 'uploads',
      package: '@nestvexa/uploads',
      capabilities: { scan: { supported: false, reason: 'No scanner' } },
    });
    await app.init();
    expect(features.sealed).toBe(true);
    expect(features.plugins()).toEqual([
      { name: 'audit', version: '1.2.3' },
      { name: 'metrics' },
    ]);
    expect(app.get(NestvexaExtensionHost).describe()).toEqual(
      features.plugins(),
    );
    expect(app.get(FeatureCapabilityRegistry).get('uploads.scan')).toEqual({
      supported: false,
      reason: 'No scanner',
    });
    expect(features.report()).toEqual({
      features: [
        {
          name: 'uploads',
          package: '@nestvexa/uploads',
          components: [],
          actions: [],
          views: [],
          renderers: [],
          capabilities: {
            'uploads.scan': { supported: false, reason: 'No scanner' },
          },
        },
      ],
      plugins: [{ name: 'audit', version: '1.2.3' }, { name: 'metrics' }],
    });
    await app.close();
  });
});

describe('RequestContextFactory.identity', () => {
  it('returns one frozen server-side principal and tenant per request', async () => {
    const sessions = new Map([
      ['s1', { user: 'alice', roles: ['member'], tenant: 'acme' }],
    ]);
    const sid = (request: object) => {
      const headers = Reflect.get(request, 'headers') as Record<string, string>;
      return /sid=(\w+)/.exec(headers['cookie'] ?? '')?.[1] ?? '';
    };
    let calls = 0;
    const factory = new RequestContextFactory({
      resolvePrincipal: (request) => {
        calls++;
        const session = sessions.get(sid(request));
        return session && { id: session.user, roles: session.roles };
      },
      resolveTenant: (request) => sessions.get(sid(request))?.tenant,
    });
    // A client tenant header or body never reaches the identity: only resolvers do.
    const request = {
      headers: { cookie: 'sid=s1', 'x-tenant-id': 'globex' },
      body: { tenant: 'globex', principal: { id: 'root' } },
    };
    const identity = await factory.identity(request);
    expect(identity).toEqual({
      authenticated: true,
      principal: { id: 'alice', roles: ['member'] },
      tenant: 'acme',
    });
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity.principal)).toBe(true);
    // Every transport asking for this request sees the same object.
    expect(await factory.identity(request)).toBe(identity);
    const context = await factory.create(request);
    expect(identity.principal).toBe(context.principal);
    expect(calls).toBe(1);
    expect(await factory.identity({ headers: {} })).toEqual({
      authenticated: false,
    });
    await expect(
      factory.identity(null as unknown as object),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
  });

  it('fails closed when a resolver throws or returns an invalid tenant', async () => {
    const failing = new RequestContextFactory({
      resolvePrincipal: () => {
        throw new Error('session store offline');
      },
    });
    await expect(failing.identity({ headers: {} })).rejects.toThrow(
      'session store offline',
    );
    const invalid = new RequestContextFactory({
      resolveTenant: () => '../other tenant',
    });
    await expect(invalid.identity({ headers: {} })).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    });
  });
});

describe('SecurityPolicyRegistry contract extensions', () => {
  it('passes a form-field CSRF token and the authorized request to the policy', async () => {
    const security = new SecurityPolicyRegistry();
    const seen: unknown[] = [];
    security.register('csrf', 'uploads', {
      verify: (_request, subject, token) => {
        seen.push(['csrf', subject, token]);
        return token === 'form-token-0123456789';
      },
    });
    security.register('action-authorization', 'actions', {
      authorize: (subject, resource, action, request) => {
        seen.push(['authorize', subject, resource, action, request]);
        return request !== undefined;
      },
    });
    const request = { headers: {} };
    expect(
      await security.verifyCsrf(
        'uploads',
        request,
        { binding: 'b' },
        'form-token-0123456789',
      ),
    ).toBe(true);
    expect(
      await security.verifyCsrf('uploads', request, { binding: 'b' }),
    ).toBe(false);
    expect(
      await security.authorize('actions', 'alice', 'cart', 'add', request),
    ).toBe(true);
    // A policy that needs the request denies without one.
    expect(await security.authorize('actions', 'alice', 'cart', 'add')).toBe(
      false,
    );
    expect(seen).toEqual([
      ['csrf', { binding: 'b' }, 'form-token-0123456789'],
      ['csrf', { binding: 'b' }, undefined],
      ['authorize', 'alice', 'cart', 'add', request],
      ['authorize', 'alice', 'cart', 'add', undefined],
    ]);
  });
});
