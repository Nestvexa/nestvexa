import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  HbsEngine,
  NestvexaModule,
  configureNestvexa,
} from '../packages/nestvexa/dist/index.js';

const apps = new Set<INestApplication>();
const roots = new Set<string>();
afterEach(async () => {
  await Promise.all([...apps].map((app) => app.close()));
  apps.clear();
  vi.restoreAllMocks();
  for (const root of roots) {
    if (!basename(root).startsWith('nestvexa-lifecycle-'))
      throw new Error('Unexpected test cleanup path');
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

async function templateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nestvexa-lifecycle-'));
  roots.add(root);
  await writeFile(join(root, 'home.hbs'), '{{name}}');
  return root;
}

async function application(
  root: string,
  platform: 'express' | 'fastify' = 'express',
): Promise<INestApplication> {
  const module = await Test.createTestingModule({
    imports: [NestvexaModule.forRoot({ views: { root, cache: true } })],
  }).compile();
  const app =
    platform === 'fastify'
      ? module.createNestApplication(new FastifyAdapter(), { logger: false })
      : module.createNestApplication({ logger: false });
  apps.add(app);
  return app;
}

describe.each(['express', 'fastify'] as const)(
  'umbrella lifecycle: %s',
  (platform) => {
    it('coalesces concurrent configuration and keeps subsequent configuration idempotent', async () => {
      const app = await application(await templateRoot(), platform);
      const initialize = vi.spyOn(app.get(HbsEngine), 'initialize');
      await Promise.all([configureNestvexa(app), configureNestvexa(app)]);
      await configureNestvexa(app);
      expect(initialize).toHaveBeenCalledTimes(1);
      await app.init();
    });

    it('disposes the initialized engine on actual Nest shutdown and releases cached templates', async () => {
      const root = await templateRoot();
      const app = await application(root, platform);
      const engine = app.get(HbsEngine);
      const dispose = vi.spyOn(engine, 'dispose');
      await configureNestvexa(app);
      await app.init();
      expect(await engine.render('home', { name: 'first' })).toBe('first');
      await writeFile(join(root, 'home.hbs'), 'updated {{name}}');
      expect(await engine.render('home', { name: 'cached' })).toBe('cached');
      await app.close();
      apps.delete(app);
      expect(dispose).toHaveBeenCalledTimes(1);
      await expect(configureNestvexa(app)).rejects.toThrow('has shut down');
      // HbsEngine.dispose releases caches; direct engine reuse is supported independently of the closed host.
      expect(await engine.render('home', { name: 'fresh' })).toBe(
        'updated fresh',
      );
    });
  },
);

describe('bootstrap failure boundaries', () => {
  it('rejects unknown HTTP adapters before initializing the engine', async () => {
    const app = await application(await templateRoot());
    vi.spyOn(app.getHttpAdapter(), 'getType').mockReturnValue(
      'unsupported-test-adapter',
    );
    const initialize = vi.spyOn(app.get(HbsEngine), 'initialize');
    await expect(configureNestvexa(app)).rejects.toThrow(
      'Unsupported Nest HTTP adapter',
    );
    expect(initialize).not.toHaveBeenCalled();
  });

  it('leaves an existing Fastify view owner intact and rejects before engine initialization', async () => {
    const app = await application(await templateRoot(), 'fastify');
    // application(..., 'fastify') constructs a real FastifyAdapter above.
    const host: FastifyInstance = app.getHttpAdapter().getInstance();
    host.decorateReply('view', function existingView() {
      return 'host-owned';
    });
    const initialize = vi.spyOn(app.get(HbsEngine), 'initialize');
    await expect(configureNestvexa(app)).rejects.toThrow('already registered');
    expect(initialize).not.toHaveBeenCalled();
    expect(host.hasReplyDecorator('view')).toBe(true);
  });

  it('rejects unimplemented Live instead of registering a fake endpoint', async () => {
    await expect(
      Test.createTestingModule({
        imports: [NestvexaModule.forRoot({ live: { enabled: true } })],
      }).compile(),
    ).rejects.toThrow('Live runtime is not available');
  });

  it('rejects a non-HBS engine in the default distribution', async () => {
    await expect(
      Test.createTestingModule({
        imports: [NestvexaModule.forRoot({ views: { engine: 'ejs' } })],
      }).compile(),
    ).rejects.toThrow('requires the hbs engine');
  });
});

describe('view cache isolation', () => {
  it('keeps separate Nest applications independent during shutdown and cache eviction', async () => {
    const root = await templateRoot();
    const firstApp = await application(root);
    const secondApp = await application(root);
    await Promise.all([
      configureNestvexa(firstApp),
      configureNestvexa(secondApp),
    ]);
    await Promise.all([firstApp.init(), secondApp.init()]);
    const first = firstApp.get(HbsEngine);
    const second = secondApp.get(HbsEngine);
    expect(first).not.toBe(second);
    expect(await first.render('home', { name: 'Alice' })).toBe('Alice');
    expect(await second.render('home', { name: 'Bob' })).toBe('Bob');
    await writeFile(join(root, 'home.hbs'), 'updated {{name}}');
    await firstApp.close();
    apps.delete(firstApp);
    expect(await second.render('home', { name: 'Carol' })).toBe('Carol');
    second.clearCache();
    expect(await second.render('home', { name: 'Carol' })).toBe(
      'updated Carol',
    );
  });
  it('does not cache user data or request helpers with the compiled template', async () => {
    const root = await templateRoot();
    await writeFile(
      join(root, 'home.hbs'),
      '{{name}} {{tenant}} {{format value}}',
    );
    const engine = new HbsEngine({ root, cache: true });
    try {
      const rendered = await Promise.all([
        engine.render(
          'home',
          { name: 'Alice', tenant: 'one', value: 'A' },
          { helpers: { format: (value) => `first-${String(value)}` } },
        ),
        engine.render(
          'home',
          { name: 'Bob', tenant: 'two', value: 'B' },
          { helpers: { format: (value) => `second-${String(value)}` } },
        ),
      ]);
      expect(rendered).toEqual(['Alice one first-A', 'Bob two second-B']);
      await expect(
        engine.render('home', { name: 'Eve', tenant: 'three', value: 'C' }),
      ).rejects.toThrow();
    } finally {
      await engine.dispose();
    }
  });

  it('keeps helper registrations and template caches scoped to separate engine instances', async () => {
    const root = await templateRoot();
    await writeFile(join(root, 'home.hbs'), '{{brand}} {{name}}');
    const first = new HbsEngine({
      root,
      cache: true,
      helpers: { brand: () => 'first' },
    });
    const second = new HbsEngine({
      root,
      cache: true,
      helpers: { brand: () => 'second' },
    });
    try {
      expect(await first.render('home', { name: 'Alice' })).toBe('first Alice');
      expect(await second.render('home', { name: 'Bob' })).toBe('second Bob');
      await writeFile(join(root, 'home.hbs'), 'updated {{brand}} {{name}}');
      first.clearCache();
      expect(await first.render('home', { name: 'Alice' })).toBe(
        'updated first Alice',
      );
      expect(await second.render('home', { name: 'Bob' })).toBe('second Bob');
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });
});
