/**
 * One public extension model (CORE-034, CORE-023): `NestvexaExtension` with
 * version negotiation; the legacy `PluginRegistry` is a deprecated adapter
 * that converts plugins into extensions.
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

// Booting Nest applications is slow on loaded CI hosts.
vi.setConfig({ testTimeout: 60_000 });
import {
  CoreModule,
  FeatureCapabilityRegistry,
  NESTVEXA_VERSION,
  NestvexaError,
  NestvexaExtensionHost,
  PluginRegistry,
  defineExtension,
  pluginExtension,
} from '../packages/core/dist/index.js';
import type {
  NestvexaPlugin,
  PluginSetupContext,
} from '../packages/core/dist/index.js';

const charts: NestvexaPlugin = {
  manifest: {
    name: '@acme/nestvexa-charts',
    version: '1.2.0',
    nestvexa: '^0.1.0-alpha.0',
    capabilities: ['ui-kit', 'island-renderer'],
  },
};

async function boot(extensions: Parameters<typeof CoreModule.forRoot>[1]) {
  const module = await Test.createTestingModule({
    imports: [CoreModule.forRoot({}, extensions)],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  await app.init();
  return app;
}

describe('NestvexaExtension version negotiation', () => {
  it('reports the published framework version', async () => {
    const manifest = JSON.parse(
      await readFile(
        new URL('../packages/core/package.json', import.meta.url),
        'utf8',
      ),
    ) as { version: string };
    expect(NESTVEXA_VERSION).toBe(manifest.version);
  });

  it('validates version and range fields', () => {
    expect(
      defineExtension({ name: 'ok', version: '1.0.0', nestvexa: '^0.1.0' }),
    ).toMatchObject({ version: '1.0.0', nestvexa: '^0.1.0' });
    expect(() => defineExtension({ name: 'ok', version: 'latest' })).toThrow(
      /semantic version/,
    );
    expect(() => defineExtension({ name: 'ok', nestvexa: '^^1' })).toThrow(
      NestvexaError,
    );
  });

  it('installs an extension whose range includes the running version', async () => {
    const app = await boot({
      extensions: [{ name: 'compatible', nestvexa: '>=0.1.0-alpha.0 <1.0.0' }],
    });
    expect(app.get(NestvexaExtensionHost).names()).toEqual(['compatible']);
    await app.close();
  });

  it('fails startup for an extension built for another framework version', async () => {
    await expect(
      Test.createTestingModule({
        imports: [
          CoreModule.forRoot(
            {},
            { extensions: [{ name: 'future', nestvexa: '^2.0.0' }] },
          ),
        ],
      }).compile(),
    ).rejects.toThrow(/future supports Nestvexa \^2\.0\.0, not 0\.1\.0/);
  });
});

describe('legacy plugins through the extension model', () => {
  it('converts a plugin: name, version, capability flags and setup', async () => {
    const seen: PluginSetupContext[] = [];
    const extension = pluginExtension({
      ...charts,
      setup: (context) => {
        seen.push(context);
      },
    });
    expect(extension).toMatchObject({
      name: 'acme.nestvexa-charts',
      version: '1.2.0',
      nestvexa: '^0.1.0-alpha.0',
      capabilities: {
        'ui-kit:acme.nestvexa-charts': { supported: true },
        'island-renderer:acme.nestvexa-charts': { supported: true },
      },
    });
    const tracing = pluginExtension({
      manifest: {
        name: 'nestvexa-tracing',
        version: '0.3.0',
        nestvexa: '^0.1.0-alpha.0',
        capabilities: ['instrumentation'],
      },
    });
    const app = await boot({ extensions: [tracing, extension] });
    expect(app.get(NestvexaExtensionHost).names()).toEqual([
      'nestvexa-tracing',
      'acme.nestvexa-charts',
    ]);
    expect(app.get(FeatureCapabilityRegistry).names()).toEqual([
      'instrumentation:nestvexa-tracing',
      'ui-kit:acme.nestvexa-charts',
      'island-renderer:acme.nestvexa-charts',
    ]);
    // setup ran once, at registration, seeing the other extension's capability.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.frameworkVersion).toBe(NESTVEXA_VERSION);
    expect([...(seen[0]?.provided ?? [])]).toEqual(['instrumentation']);
    await app.close();
  });

  it('requires an explicit name when the package name is not an extension name', () => {
    const numeric: NestvexaPlugin = {
      manifest: { ...charts.manifest, name: '9lives' },
    };
    expect(() => pluginExtension(numeric)).toThrow(/pass \{ name \}/);
    expect(pluginExtension(numeric, { name: 'lives' }).name).toBe('lives');
  });

  it('PluginRegistry hands its plugins to the kernel without re-running setup', async () => {
    let setups = 0;
    const registry = new PluginRegistry();
    registry.install({
      ...charts,
      setup: () => {
        setups++;
      },
    });
    registry.seal();
    expect(setups).toBe(1);
    const app = await boot({ extensions: registry.extensions() });
    expect(setups).toBe(1);
    expect(app.get(FeatureCapabilityRegistry).report()).toEqual({
      'ui-kit:acme.nestvexa-charts': { supported: true },
      'island-renderer:acme.nestvexa-charts': { supported: true },
    });
    await app.close();
  });

  it('rejects an incompatible plugin through either path', async () => {
    const old: NestvexaPlugin = {
      manifest: { ...charts.manifest, name: 'old-plugin', nestvexa: '^9.0.0' },
    };
    expect(() => new PluginRegistry().install(old)).toThrow(
      /supports Nestvexa/,
    );
    await expect(
      Test.createTestingModule({
        imports: [
          CoreModule.forRoot({}, { extensions: [pluginExtension(old)] }),
        ],
      }).compile(),
    ).rejects.toThrow(/old-plugin supports Nestvexa \^9\.0\.0/);
  });
});
