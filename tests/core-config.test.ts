import 'reflect-metadata';
import { Inject, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import {
  CoreModule,
  FeatureCapabilityRegistry,
  NESTVEXA_ENVIRONMENT_VARIABLES,
  NESTVEXA_ERROR_CODES,
  NestvexaConfigError,
  NestvexaConfigService,
  mergeNestvexaOptions,
  nestvexaOptionsFromEnvironment,
  normalizeOptions,
} from '../packages/core/dist/index.js';
import type {
  NestvexaAsyncOptions,
  NestvexaOptions,
  NestvexaOptionsFactory,
} from '../packages/core/dist/index.js';

function issues(run: () => unknown) {
  try {
    run();
  } catch (error) {
    if (error instanceof NestvexaConfigError) return error;
    throw error;
  }
  throw new Error('Expected a configuration error');
}

describe('canonical configuration sample', () => {
  it('accepts the documented forRoot sample including live.client', () => {
    const normalized = normalizeOptions({
      views: { engine: 'hbs', root: 'src/views' },
      live: { enabled: true, client: 'alpine' },
      security: { csrf: true, requireAuthorizedActions: true },
    });
    expect(normalized.live).toEqual({ enabled: true, client: 'alpine' });
    expect(normalizeOptions({ live: { client: 'manual' } }).live.client).toBe(
      'manual',
    );
    // Unset client stays absent so integrations keep their own default.
    expect('client' in normalizeOptions().live).toBe(false);
  });
});

describe('startup diagnostics', () => {
  it('reports every invalid path with the expectation and never the value', () => {
    const secret = 'super-secret-root-value';
    const error = issues(() =>
      normalizeOptions({
        views: { cache: 'yes', engine: '../x', layout: true, root: 7 },
        live: { client: secret },
        security: { csrf: 1, extra: secret },
      }),
    );
    expect(error.code).toBe('INVALID_CONFIGURATION');
    expect(error.issues.map((issue) => issue.path)).toEqual([
      'security.extra',
      'views.engine',
      'views.layout',
      'live.client',
      'views.root',
      'views.cache',
      'security.csrf',
    ]);
    expect(error.message).toContain('views.cache (expected a boolean)');
    expect(error.message).toContain(
      'live.client (expected "alpine" or "manual")',
    );
    expect(error.message).not.toContain(secret);
    expect(Object.isFrozen(error.issues)).toBe(true);
  });
  it('documents every core error code', () => {
    for (const code of [
      'INVALID_CONFIGURATION',
      'DUPLICATE_REGISTRATION',
      'UNKNOWN_REGISTRATION',
      'REGISTRY_SEALED',
      'UNSUPPORTED_CAPABILITY',
    ])
      expect(NESTVEXA_ERROR_CODES).toHaveProperty(code);
    expect(Object.isFrozen(NESTVEXA_ERROR_CODES)).toBe(true);
  });
});

describe('configuration precedence', () => {
  it('merges file < environment < overrides per key and applies defaults last', () => {
    const file: NestvexaOptions = {
      views: { root: 'file/views', cache: false, layout: 'layouts/main' },
      live: { enabled: false },
    };
    const environment = nestvexaOptionsFromEnvironment({
      NESTVEXA_VIEWS_CACHE: 'true',
      NESTVEXA_LIVE_ENABLED: '1',
      PATH: 'ignored',
      NESTVEXA_ORIGIN: 'owned by another package',
    });
    const overrides: NestvexaOptions = { views: { root: 'override/views' } };
    const merged = normalizeOptions(
      mergeNestvexaOptions(file, undefined, environment, overrides),
    );
    expect(merged).toEqual({
      views: {
        engine: 'hbs',
        root: 'override/views',
        cache: true,
        layout: 'layouts/main',
      },
      live: { enabled: true },
      security: { csrf: true, requireAuthorizedActions: true },
    });
    // Inputs are not mutated by merging.
    expect(file.views?.root).toBe('file/views');
  });
  it('maps every documented variable and rejects typos and malformed booleans', () => {
    const all = nestvexaOptionsFromEnvironment({
      NESTVEXA_VIEWS_ENGINE: 'hbs',
      NESTVEXA_VIEWS_ROOT: 'views',
      NESTVEXA_VIEWS_CACHE: 'FALSE',
      NESTVEXA_VIEWS_LAYOUT: 'false',
      NESTVEXA_LIVE_ENABLED: 'true',
      NESTVEXA_LIVE_CLIENT: 'manual',
      NESTVEXA_SECURITY_CSRF: '0',
      NESTVEXA_SECURITY_REQUIRE_AUTHORIZED_ACTIONS: '1',
    });
    expect(all).toEqual({
      views: { engine: 'hbs', root: 'views', cache: false, layout: false },
      live: { enabled: true, client: 'manual' },
      security: { csrf: false, requireAuthorizedActions: true },
    });
    expect(Object.keys(NESTVEXA_ENVIRONMENT_VARIABLES)).toHaveLength(8);
    const typo = issues(() =>
      nestvexaOptionsFromEnvironment({ NESTVEXA_VIEWS_CAHCE: 'true' }),
    );
    expect(typo.issues).toEqual([
      {
        path: 'NESTVEXA_VIEWS_CAHCE',
        expected: 'a documented NESTVEXA_* variable',
      },
    ]);
    const malformed = issues(() =>
      nestvexaOptionsFromEnvironment({ NESTVEXA_LIVE_ENABLED: 'yes-please' }),
    );
    expect(malformed.message).toContain('NESTVEXA_LIVE_ENABLED');
    expect(malformed.message).not.toContain('yes-please');
    expect(() =>
      nestvexaOptionsFromEnvironment({ NESTVEXA_LIVE_CLIENT: 'react' }),
    ).toThrow('live.client');
  });
  it('rejects invalid layers with their position', () => {
    const error = issues(() =>
      mergeNestvexaOptions(
        { views: {} },
        JSON.parse('{"views":{"cache":"x"}}'),
      ),
    );
    // Type errors in a later layer surface from the combined validation.
    expect(error.message).toContain('views.cache');
    const unknown = issues(() =>
      mergeNestvexaOptions({}, JSON.parse('{"theme":{}}')),
    );
    expect(unknown.issues[0]?.path).toBe('layers[1].theme');
  });
});

const SETTINGS = Symbol('SETTINGS');
@Injectable()
class SettingsFactory implements NestvexaOptionsFactory {
  constructor(@Inject(SETTINGS) private readonly root: string) {}
  async createNestvexaOptions(): Promise<NestvexaOptions> {
    await Promise.resolve();
    return { views: { root: this.root } };
  }
}
@Module({
  providers: [{ provide: SETTINGS, useValue: 'class-views' }, SettingsFactory],
  exports: [SETTINGS, SettingsFactory],
})
class SettingsModule {}

/** A host ConfigService stand-in: values come from an explicit record, as with @nestjs/config. */
@Injectable()
class HostConfigService {
  readonly #values: Readonly<Record<string, string>> = Object.freeze({
    NESTVEXA_VIEWS_ROOT: 'env-views',
    NESTVEXA_VIEWS_CACHE: 'true',
  });
  get(name: string): string | undefined {
    return Object.hasOwn(this.#values, name) ? this.#values[name] : undefined;
  }
  all(): Readonly<Record<string, string>> {
    return this.#values;
  }
}
@Module({ providers: [HostConfigService], exports: [HostConfigService] })
class HostConfigModule {}

@Injectable()
class FeatureService {
  constructor(
    @Inject(NestvexaConfigService) readonly config: NestvexaConfigService,
  ) {}
}
@Module({ providers: [FeatureService], exports: [FeatureService] })
class FeatureModule {}

async function compile(module: ReturnType<typeof CoreModule.forRoot>) {
  return Test.createTestingModule({ imports: [module] }).compile();
}

describe('module registration ergonomics', () => {
  it('builds options with useClass inside the module and useExisting from imports', async () => {
    const byClass = await compile(
      CoreModule.forRootAsync({
        imports: [SettingsModule],
        useClass: SettingsFactory,
      }),
    );
    const byExisting = await compile(
      CoreModule.forRootAsync({
        imports: [SettingsModule],
        useExisting: SettingsFactory,
      }),
    );
    try {
      expect(byClass.get(NestvexaConfigService).value.views.root).toBe(
        'class-views',
      );
      expect(byExisting.get(NestvexaConfigService).value.views.root).toBe(
        'class-views',
      );
    } finally {
      await byClass.close();
      await byExisting.close();
    }
  });
  it('layers a host ConfigService over file defaults in forRootAsync', async () => {
    const module = await compile(
      CoreModule.forRootAsync({
        imports: [HostConfigModule],
        inject: [HostConfigService],
        useFactory: (config: HostConfigService) =>
          mergeNestvexaOptions(
            { views: { root: 'file-views', layout: 'main' } },
            nestvexaOptionsFromEnvironment(config.all()),
            { live: { enabled: false } },
          ),
      }),
    );
    try {
      expect(module.get(NestvexaConfigService).value.views).toEqual({
        engine: 'hbs',
        root: 'env-views',
        cache: true,
        layout: 'main',
      });
    } finally {
      await module.close();
    }
  });
  it('fails bootstrap for a factory object without createNestvexaOptions', async () => {
    const BROKEN = Symbol('BROKEN');
    @Module({
      providers: [{ provide: BROKEN, useValue: { create: () => ({}) } }],
      exports: [BROKEN],
    })
    class BrokenModule {}
    await expect(
      compile(
        CoreModule.forRootAsync({
          imports: [BrokenModule],
          useExisting: BROKEN,
        }),
      ),
    ).rejects.toThrow('createNestvexaOptions');
  });
  it('rejects ambiguous or missing async strategies synchronously', () => {
    const both = {
      useFactory: () => ({}),
      useClass: SettingsFactory,
    } as unknown as NestvexaAsyncOptions;
    expect(() => CoreModule.forRootAsync(both)).toThrow('exactly one');
    expect(() =>
      CoreModule.forRootAsync({} as unknown as NestvexaAsyncOptions),
    ).toThrow('exactly one');
    expect(() =>
      CoreModule.forRoot({}, { global: 'yes' as unknown as boolean }),
    ).toThrow('global');
  });
  it('keeps providers module-local unless global registration is requested', async () => {
    await expect(
      Test.createTestingModule({
        imports: [CoreModule.forRoot(), FeatureModule],
      }).compile(),
    ).rejects.toThrow();
    const module = await Test.createTestingModule({
      imports: [
        CoreModule.forRoot(
          { views: { root: 'global-views' } },
          { global: true },
        ),
        FeatureModule,
      ],
    }).compile();
    try {
      expect(module.get(FeatureService).config.value.views.root).toBe(
        'global-views',
      );
    } finally {
      await module.close();
    }
  });
});

describe('capability declarations', () => {
  it('distinguishes supported, degraded and unsupported features in a frozen report', () => {
    const registry = new FeatureCapabilityRegistry();
    registry.register('http:express', { supported: true });
    registry.register('realtime:websocket', {
      supported: true,
      degraded: 'Falls back to long polling behind this proxy',
    });
    registry.register('views:streaming', {
      supported: false,
      reason: 'HBS renders complete documents',
    });
    expect(() => registry.require('realtime:websocket')).not.toThrow();
    expect(() => registry.require('views:streaming')).toThrow(
      'HBS renders complete documents',
    );
    const report = registry.report();
    expect(Object.isFrozen(report)).toBe(true);
    expect(report).toEqual({
      'http:express': { supported: true },
      'realtime:websocket': {
        supported: true,
        degraded: 'Falls back to long polling behind this proxy',
      },
      'views:streaming': {
        supported: false,
        reason: 'HBS renders complete documents',
      },
    });
    expect(registry.has('http:fastify')).toBe(false);
    expect(() =>
      registry.register('blank', { supported: true, degraded: ' ' }),
    ).toThrow('description');
    // Extra adapter properties are not retained.
    registry.register('extra', {
      supported: true,
      secret: 'x',
    } as unknown as { supported: true });
    expect(registry.get('extra')).toEqual({ supported: true });
  });
});
