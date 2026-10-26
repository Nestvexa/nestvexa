import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('package contracts', () => {
  it('keeps core free of renderers and gives every package explicit ESM and type exports', async () => {
    const names = await readdir('packages');
    expect(names.length).toBeGreaterThanOrEqual(4);
    for (const name of names) {
      const manifest: {
        name: string;
        exports: { '.': { types: string; import: string } };
        dependencies?: Record<string, string>;
      } = JSON.parse(
        await readFile(join('packages', name, 'package.json'), 'utf8'),
      );
      expect(manifest.exports['.'].types).toMatch(/\.d\.ts$/);
      expect(manifest.exports['.'].import).toMatch(/\.js$/);
      if (name === 'core')
        expect(Object.keys(manifest.dependencies ?? {})).not.toEqual(
          expect.arrayContaining([
            'handlebars',
            'react',
            'vue',
            'svelte',
            '@nestvexa/live',
          ]),
        );
    }
    const kernel = await import('../packages/core/dist/index.js');
    expect(kernel.CoreModule).toBeTypeOf('function');
  });
});
