import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// examples/express-host and examples/fastify-host claim to run the same
// application on two Nest HTTP platforms. Keep that claim true: everything
// except the platform bootstrap (src/main.ts) and package metadata must match.
const express = new URL('../examples/express-host/', import.meta.url);
const fastify = new URL('../examples/fastify-host/', import.meta.url);

async function files(directory: URL): Promise<string[]> {
  return (await readdir(directory)).sort();
}

describe('express-host and fastify-host share one application', () => {
  it('has a byte-identical src/app.ts', async () => {
    const [left, right] = await Promise.all([
      readFile(new URL('src/app.ts', express), 'utf8'),
      readFile(new URL('src/app.ts', fastify), 'utf8'),
    ]);
    expect(right).toBe(left);
    // The shared module must not depend on either platform package.
    expect(left).not.toMatch(
      /platform-(express|fastify)|from 'express'|from 'fastify'/,
    );
  });

  it('has byte-identical views', async () => {
    const views = await files(new URL('views/', express));
    expect(await files(new URL('views/', fastify))).toEqual(views);
    for (const view of views)
      expect(
        await readFile(new URL(`views/${view}`, fastify), 'utf8'),
        view,
      ).toBe(await readFile(new URL(`views/${view}`, express), 'utf8'));
  });

  it('differs only in the platform bootstrap', async () => {
    const [left, right] = await Promise.all([
      readFile(new URL('src/main.ts', express), 'utf8'),
      readFile(new URL('src/main.ts', fastify), 'utf8'),
    ]);
    expect(left).toContain("platform: 'express'");
    expect(right).toContain("platform: 'fastify'");
    expect(right).toContain('new FastifyAdapter()');
  });
});
