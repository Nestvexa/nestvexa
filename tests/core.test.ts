import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import {
  CollisionSafeRegistry,
  CoreModule,
  FeatureCapabilityRegistry,
  NestvexaConfigService,
  normalizeOptions,
} from '../packages/core/src/index.js';

describe('core configuration', () => {
  it('defaults to HBS, disabled live routes and enabled security policy flags', () => {
    expect(normalizeOptions()).toEqual({
      views: { engine: 'hbs', root: 'src/views', cache: false, layout: false },
      live: { enabled: false },
      security: { csrf: true, requireAuthorizedActions: true },
    });
  });
  it('clones and freezes nested config, preserving Windows roots', () => {
    const options = { views: { root: 'C:\\app\\views' } };
    const normalized = normalizeOptions(options);
    options.views.root = 'changed';
    expect(normalized.views.root).toBe('C:\\app\\views');
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.views)).toBe(true);
  });
  it.each([
    null,
    [],
    { unexpected: true },
    { live: { enabled: 'true' } },
    { views: { engine: '../file' } },
    { views: { root: '\0' } },
    { views: { layout: true } },
    { security: { csrf: 0 } },
    JSON.parse('{"__proto__":{"admin":true}}'),
  ])('rejects malformed config %j', (input) => {
    expect(() => normalizeOptions(input)).toThrow(
      'Invalid Nestvexa configuration',
    );
  });
  it('rejects accessors without invoking them', () => {
    let called = false;
    expect(() =>
      normalizeOptions({
        get views() {
          called = true;
          return {};
        },
      }),
    ).toThrow();
    expect(called).toBe(false);
  });
  it('resolves sync providers through real Nest DI', async () => {
    const module = await Test.createTestingModule({
      imports: [CoreModule.forRoot({ views: { root: 'templates' } })],
    }).compile();
    try {
      expect(module.get(NestvexaConfigService).value.views.root).toBe(
        'templates',
      );
    } finally {
      await module.close();
    }
  });
  it('awaits imported async dependencies without making providers global', async () => {
    const ROOT = Symbol('ROOT');
    class SettingsModule {}
    Module({
      providers: [{ provide: ROOT, useValue: 'templates-async' }],
      exports: [ROOT],
    })(SettingsModule);
    const module = await Test.createTestingModule({
      imports: [
        CoreModule.forRootAsync({
          imports: [SettingsModule],
          inject: [ROOT],
          useFactory: async (root: string) => ({ views: { root } }),
        }),
      ],
    }).compile();
    try {
      expect(module.get(NestvexaConfigService).value.views.root).toBe(
        'templates-async',
      );
    } finally {
      await module.close();
    }
  });
  it('rejects invalid async factory values at bootstrap', async () => {
    await expect(
      Test.createTestingModule({
        imports: [
          CoreModule.forRootAsync({
            useFactory: async () => ({ views: { engine: '' } }),
          }),
        ],
      }).compile(),
    ).rejects.toThrow('Invalid Nestvexa configuration');
  });
  it('does not share registry state between Nest applications', async () => {
    const first = await Test.createTestingModule({
      imports: [CoreModule.forRoot()],
    }).compile();
    const second = await Test.createTestingModule({
      imports: [CoreModule.forRoot()],
    }).compile();
    try {
      first
        .get(FeatureCapabilityRegistry)
        .register('views:hbs', { supported: true });
      expect(second.get(FeatureCapabilityRegistry).names()).toEqual([]);
    } finally {
      await first.close();
      await second.close();
    }
  });
});

describe('explicit registries', () => {
  it('rejects duplicate, unknown, prototype and sealed registrations', () => {
    const registry = new CollisionSafeRegistry<number>();
    registry.register('component:counter', 1);
    expect(registry.get('component:counter')).toBe(1);
    expect(() => registry.register('component:counter', 2)).toThrow(
      'Duplicate',
    );
    expect(() => registry.get('unknown')).toThrow('Unknown');
    expect(() => registry.register('constructor', 2)).toThrow('Invalid');
    expect(Object.isFrozen(registry.names())).toBe(true);
    registry.seal();
    expect(registry.sealed).toBe(true);
    expect(() => registry.register('other', 3)).toThrow('sealed');
  });
  it('distinguishes undefined registered values from missing entries', () => {
    const registry = new CollisionSafeRegistry<undefined>();
    registry.register('empty', undefined);
    expect(registry.get('empty')).toBeUndefined();
  });
  it('reports honest unsupported capabilities and immutable records', () => {
    const registry = new FeatureCapabilityRegistry();
    registry.register('streaming', {
      supported: false,
      reason: 'Engine does not stream',
    });
    registry.register('partials', { supported: true });
    expect(Object.isFrozen(registry.get('streaming'))).toBe(true);
    expect(() => registry.require('streaming')).toThrow(
      'Engine does not stream',
    );
    expect(() => registry.require('partials')).not.toThrow();
    expect(() =>
      registry.register('unknown', { supported: false, reason: '' }),
    ).toThrow('requires a reason');
  });
});
