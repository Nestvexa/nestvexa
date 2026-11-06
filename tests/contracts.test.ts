import { describe, expect, it, vi } from 'vitest';
import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Reads and imports every package's built entries; slow on loaded hosts.
vi.setConfig({ testTimeout: 60_000 });

describe('package contracts', () => {
  it('keeps browser declaration documentation and external source maps after comment-free JavaScript emission', async () => {
    const code = await readFile('packages/client/dist/index.js', 'utf8');
    const declarations = await readFile(
      'packages/client/dist/index.d.ts',
      'utf8',
    );
    expect(code).not.toContain('Explicit, idempotent browser startup.');
    expect(declarations).toContain('Explicit, idempotent browser startup.');
    expect(code).toContain('//# sourceMappingURL=index.js.map');
    const map = JSON.parse(
      await readFile('packages/client/dist/index.js.map', 'utf8'),
    ) as { sources: string[]; version: number };
    expect(map.version).toBe(3);
    expect(map.sources).toContain('../src/index.ts');
  });
  it('keeps core free of renderers and gives every package explicit ESM and type exports', async () => {
    const names = await readdir('packages');
    expect(names.length).toBeGreaterThanOrEqual(4);
    for (const name of names) {
      const manifest: {
        name: string;
        exports: Record<
          string,
          { types: string; import: string; default?: string } | string
        >;
        dependencies?: Record<string, string>;
      } = JSON.parse(
        await readFile(join('packages', name, 'package.json'), 'utf8'),
      );
      expect(manifest.exports['.']).toBeTypeOf('object');
      for (const entry of Object.values(manifest.exports)) {
        // Only static stylesheet assets may be plain string exports.
        if (typeof entry === 'string') {
          expect(entry).toMatch(/^\.\/[\w/-]+\.css$/);
          await access(join('packages', name, entry));
          continue;
        }
        expect(entry.types).toMatch(/\.d\.ts$/);
        expect(entry.import).toMatch(/\.js$/);
        // CommonJS hosts load ESM through require(esm), which needs `default`.
        expect(entry.default).toBe(entry.import);
        await access(join('packages', name, entry.types));
        await access(join('packages', name, entry.import));
      }
      if (name === 'core')
        for (const dependency of Object.keys(manifest.dependencies ?? {}))
          expect([
            'handlebars',
            'react',
            'vue',
            'svelte',
            '@nestvexa/live',
            '@nestvexa/client',
            '@nestvexa/alpine',
            '@alpinejs/csp',
          ]).not.toContain(dependency);
    }
    const kernel = await import('../packages/core/dist/index.js');
    expect(kernel.CoreModule).toBeTypeOf('function');
  });
  it('imports the explicit asset entry in Node without initializing browser globals', async () => {
    const before = Object.fromEntries(
      ['window', 'document', 'Alpine'].map((key) => [
        key,
        Reflect.get(globalThis, key),
      ]),
    );
    const assets = await import('../packages/nestvexa/dist/assets.js');
    expect(assets.NestvexaAssetsModule).toBeTypeOf('function');
    expect(assets.NestvexaAssetsService).toBeTypeOf('function');
    for (const [key, value] of Object.entries(before))
      expect(Reflect.get(globalThis, key)).toBe(value);
  });
});
