import { describe, expect, it } from 'vitest';
import {
  NestvexaError,
  PluginRegistry,
  definePlugin,
  parsePluginManifest,
  satisfiesVersion,
} from '../packages/core/dist/index.js';
import type { NestvexaPlugin } from '../packages/core/dist/index.js';

const manifest = {
  name: '@acme/nestvexa-charts',
  version: '1.2.0',
  nestvexa: '^0.1.0-alpha.0',
  capabilities: ['ui-kit'],
};

describe('satisfiesVersion', () => {
  it.each([
    ['0.1.0-alpha.3', '^0.1.0-alpha.0', true],
    ['0.1.0', '^0.1.0-alpha.0', true],
    ['0.2.0', '^0.1.0', false],
    ['1.4.2', '^1.2.0', true],
    ['2.0.0-rc.1', '^1.2.0', false],
    ['1.2.9', '~1.2.0', true],
    ['1.3.0', '~1.2.0', false],
    ['0.0.4', '^0.0.3', false],
    ['1.0.0', '>=0.1.0 <1.0.0', false],
    ['0.9.9', '>=0.1.0 <1.0.0', true],
    ['3.0.0', '^1.0.0 || ^3.0.0', true],
    ['1.0.0-alpha.10', '>1.0.0-alpha.9', true],
    ['1.0.0-alpha.beta', '>1.0.0-alpha.1', true],
  ])('%s against %s is %s', (candidate, range, expected) => {
    expect(satisfiesVersion(candidate, range)).toBe(expected);
  });
  it('rejects malformed versions and ranges', () => {
    for (const [candidate, range] of [
      ['1.0', '^1.0.0'],
      ['1.0.0', 'latest'],
      ['1.0.0', ''],
      ['1.0.0', '^1.0.0 ||'],
      ['01.0.0', '*'],
    ])
      expect(() => satisfiesVersion(candidate ?? '', range ?? '')).toThrow(
        NestvexaError,
      );
  });
});

describe('plugin manifests', () => {
  it('accepts a valid manifest and freezes it', () => {
    const parsed = parsePluginManifest({ ...manifest, description: 'Charts' });
    expect(parsed).toEqual({ ...manifest, description: 'Charts' });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.capabilities)).toBe(true);
  });
  it.each([
    ['unknown key', { ...manifest, main: './index.js' }],
    [
      'remote url name',
      { ...manifest, name: 'https://evil.example/plugin.js' },
    ],
    ['path name', { ...manifest, name: '../plugin' }],
    ['bad version', { ...manifest, version: 'next' }],
    ['bad range', { ...manifest, nestvexa: 'latest' }],
    ['unknown capability', { ...manifest, capabilities: ['eval'] }],
    [
      'duplicate capability',
      { ...manifest, capabilities: ['ui-kit', 'ui-kit'] },
    ],
    ['no capability', { ...manifest, capabilities: [] }],
    ['array', [manifest]],
    ['string', JSON.stringify(manifest)],
  ])('rejects %s', (_name, input) => {
    expect(() => parsePluginManifest(input)).toThrow(NestvexaError);
  });
  it('reads own data properties only', () => {
    const accessor = Object.defineProperty({ ...manifest }, 'version', {
      get: () => '1.0.0',
      enumerable: true,
    });
    expect(() => parsePluginManifest(accessor)).toThrow(NestvexaError);
    const inherited = Object.create({ name: 'inherited' }) as object;
    expect(() => parsePluginManifest(inherited)).toThrow(NestvexaError);
  });
});

describe('PluginRegistry', () => {
  it('installs explicit plugin objects, runs setup once and lists by capability', () => {
    const registry = new PluginRegistry({ frameworkVersion: '0.1.0-alpha.0' });
    const calls: unknown[] = [];
    registry.install(
      definePlugin({
        manifest: {
          ...manifest,
          name: 'nestvexa-tracing',
          capabilities: ['instrumentation'],
        },
      }),
    );
    registry.install({
      manifest,
      setup(context) {
        calls.push([context.frameworkVersion, [...context.provided]]);
      },
    });
    expect(calls).toEqual([['0.1.0-alpha.0', ['instrumentation']]]);
    expect(registry.has('@acme/nestvexa-charts')).toBe(true);
    expect(
      registry.withCapability('ui-kit').map((entry) => entry.name),
    ).toEqual(['@acme/nestvexa-charts']);
    expect(registry.list()).toHaveLength(2);
  });
  it('rejects duplicates, incompatible versions, strings and installs after sealing', () => {
    const registry = new PluginRegistry({ frameworkVersion: '0.1.0-alpha.0' });
    registry.install({ manifest });
    expect(() => registry.install({ manifest })).toThrow(/Duplicate/);
    expect(() =>
      registry.install({
        manifest: { ...manifest, name: 'old', nestvexa: '^2.0.0' },
      }),
    ).toThrow(/supports Nestvexa/);
    expect(() =>
      registry.install('@acme/nestvexa-charts' as unknown as NestvexaPlugin),
    ).toThrow(/imported explicitly/);
    expect(() =>
      registry.install({
        manifest: { ...manifest, name: 'x' },
        setup: 'run',
      } as unknown as NestvexaPlugin),
    ).toThrow(/setup/);
    registry.seal();
    expect(registry.sealed).toBe(true);
    expect(() =>
      registry.install({ manifest: { ...manifest, name: 'late' } }),
    ).toThrow(/sealed/);
    expect(() => new PluginRegistry({ frameworkVersion: 'dev' })).toThrow(
      NestvexaError,
    );
  });
  it('does not register a plugin whose setup throws', () => {
    const registry = new PluginRegistry({ frameworkVersion: '0.1.0' });
    expect(() =>
      registry.install({
        manifest,
        setup: () => {
          throw new Error('setup failed');
        },
      }),
    ).toThrow(/setup failed/);
    expect(registry.has(manifest.name)).toBe(false);
  });
});
