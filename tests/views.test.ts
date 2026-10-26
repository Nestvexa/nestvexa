import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HbsEngine,
  type HbsPrecompiledViews,
} from '../packages/engine-hbs/src/index.js';
import {
  SafeHtml,
  ViewEngineRegistry,
  ViewError,
} from '../packages/views/dist/index.js';

describe('HBS rendering trust boundaries', () => {
  let root: string;
  let engine: HbsEngine;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'nestvexa-views-'));
    await mkdir(path.join(root, 'partials'));
    await writeFile(
      path.join(root, 'page.hbs'),
      '<h1>{{title}}</h1>{{> footer}}',
    );
    await writeFile(
      path.join(root, 'layout.hbs'),
      '<main>{{body}}</main><aside>{{slots.extra}}</aside>',
    );
    await writeFile(
      path.join(root, 'partials', 'footer.hbs'),
      '<footer>{{text}}</footer>',
    );
    engine = new HbsEngine({ root, partials: { footer: 'partials/footer' } });
    await engine.initialize();
  });
  afterEach(async () => {
    await engine.dispose();
    await rm(root, { recursive: true, force: true });
  });
  it('escapes interpolation and retains Unicode through layout/partial/slot composition', async () => {
    const result = await engine.render(
      'page',
      { title: '<script>alert(1)</script>', text: 'مرحبا' },
      {
        layout: 'layout',
        slots: { extra: SafeHtml.trusted('<b>trusted</b>') },
      },
    );
    expect(result).toBe(
      '<main><h1>&lt;script&gt;alert(1)&lt;/script&gt;</h1><footer>مرحبا</footer></main><aside><b>trusted</b></aside>',
    );
  });
  it('rejects traversal, absolute paths, alternate separators, streams and null bytes', async () => {
    for (const name of [
      '../secret',
      '/secret',
      'x/../../secret',
      'x\\secret',
      'C:/secret',
      'secret\0',
      'x//secret',
    ])
      await expect(engine.render(name, {})).rejects.toMatchObject({
        code: 'INVALID_VIEW',
      });
  });
  it('rejects junction escape outside the configured real root', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'nestvexa-outside-'));
    try {
      await writeFile(path.join(outside, 'secret.hbs'), 'private');
      await symlink(outside, path.join(root, 'linked'), 'junction');
      await expect(engine.render('linked/secret', {})).rejects.toMatchObject({
        code: 'INVALID_VIEW',
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
  it('rejects dangerous keys, class values, functions, cycles and accessors without invoking getters', async () => {
    let calls = 0;
    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get() {
        calls++;
        return 'sensitive';
      },
    });
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    for (const value of [
      JSON.parse('{"__proto__":{"polluted":true}}') as unknown,
      new Date(),
      () => 'secret',
      NaN,
      Infinity,
      1n,
      accessor,
      cyclic,
    ]) {
      await expect(engine.render('page', { value })).rejects.toMatchObject({
        code: 'UNSAFE_MODEL',
      });
    }
    expect(calls).toBe(0);
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
  it('rejects excessive model depth and symbol properties', async () => {
    let value: unknown = null;
    for (let n = 0; n < 34; n++) value = { value };
    await expect(engine.render('page', { value })).rejects.toMatchObject({
      code: 'UNSAFE_MODEL',
    });
    await expect(
      engine.render('page', { [Symbol('hidden')]: 'value' }),
    ).rejects.toMatchObject({ code: 'UNSAFE_MODEL' });
  });
  it('reloads development templates and uses bounded explicitly invalidated production cache', async () => {
    await writeFile(path.join(root, 'cached.hbs'), '{{title}}');
    const cached = new HbsEngine({ root, cache: true, cacheEntries: 1 });
    expect(await cached.render('cached', { title: 'first' })).toBe('first');
    await writeFile(path.join(root, 'cached.hbs'), 'replacement');
    expect(await engine.render('cached', {})).toBe('replacement');
    expect(await cached.render('cached', { title: 'retained' })).toBe(
      'retained',
    );
    cached.clearCache();
    expect(await cached.render('cached', {})).toBe('replacement');
    await cached.render('layout', {});
    await writeFile(path.join(root, 'cached.hbs'), 'evicted');
    expect(await cached.render('cached', {})).toBe('evicted');
    await cached.dispose();
  });
  it('keeps helper registrations isolated and wraps missing template/helper failures', async () => {
    await writeFile(path.join(root, 'helper.hbs'), '{{greet title}}');
    const custom = new HbsEngine({
      root,
      helpers: { greet: (title) => `Hello ${String(title)}` },
    });
    expect(await custom.render('helper', { title: '<x>' })).toBe(
      'Hello &lt;x&gt;',
    );
    await expect(engine.render('helper', {})).rejects.toMatchObject({
      code: 'RENDER_FAILED',
    });
    await expect(engine.render('missing', {})).rejects.toBeInstanceOf(
      ViewError,
    );
    await expect(
      custom.render(
        'helper',
        {},
        {
          helpers: {
            greet: () => {
              throw new Error('helper failed');
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'RENDER_FAILED' });
    await custom.dispose();
  });
  it('supports per-request helpers and trusted fragments without accidentally enabling async helpers', async () => {
    await writeFile(path.join(root, 'helper.hbs'), '{{widget}}');
    expect(
      await engine.render(
        'helper',
        {},
        { helpers: { widget: () => SafeHtml.trusted('<b>ok</b>') } },
      ),
    ).toBe('<b>ok</b>');
    await expect(
      engine.render('helper', {}, { helpers: { widget: async () => 'no' } }),
    ).rejects.toMatchObject({ code: 'RENDER_FAILED' });
  });
  it('keeps untrusted fragment-shaped objects escaped and rejects hostile toHTML methods', async () => {
    await writeFile(path.join(root, 'fragment.hbs'), '{{fragment.value}}');
    expect(
      await engine.render('fragment', {
        fragment: { value: '<script>bad</script>' },
      }),
    ).toBe('&lt;script&gt;bad&lt;/script&gt;');
    await expect(
      engine.render('fragment', {
        fragment: { toHTML: () => '<script>bad</script>' },
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_MODEL' });
  });
  it('reports missing partial and parse errors with a retained development cause', async () => {
    await writeFile(path.join(root, 'missing-partial.hbs'), '{{> absent}}');
    await expect(engine.render('missing-partial', {})).rejects.toMatchObject({
      code: 'RENDER_FAILED',
      cause: expect.any(Error),
    });
    await writeFile(path.join(root, 'malformed.hbs'), '{{#if title}}');
    await expect(engine.render('malformed', {})).rejects.toMatchObject({
      code: 'RENDER_FAILED',
      cause: expect.any(Error),
    });
  });
  it('precompiles deterministic modules and renders layouts/partials without source files', async () => {
    const views = ['page', 'layout', 'partials/footer'];
    const source = await engine.precompile(views);
    expect(await engine.precompile([...views].reverse())).toBe(source);
    const modulePath = path.join(root, 'views.precompiled.mjs');
    await writeFile(modulePath, source);
    // This module is generated from the trusted test templates immediately above, never remote input.
    const imported: { default: HbsPrecompiledViews } = await import(
      pathToFileURL(modulePath).href
    );
    const production = new HbsEngine({
      root: path.join(root, 'absent-root'),
      precompiled: imported.default,
      defaultLayout: 'layout',
      partials: { footer: 'partials/footer' },
    });
    await production.initialize();
    expect(production.capabilities.precompilation).toBe(true);
    expect(
      await production.render('page', { title: '<x>', text: 'Footer' }),
    ).toBe(
      '<main><h1>&lt;x&gt;</h1><footer>Footer</footer></main><aside></aside>',
    );
    await expect(production.render('unregistered', {})).rejects.toMatchObject({
      code: 'INVALID_VIEW',
    });
    await production.dispose();
  });
  it('rejects precompile traversal, canonical duplicates and non-executable specifications', async () => {
    await expect(engine.precompile(['../outside'])).rejects.toMatchObject({
      code: 'INVALID_VIEW',
    });
    await expect(engine.precompile(['page', 'page.hbs'])).rejects.toMatchObject(
      { code: 'INVALID_VIEW' },
    );
    expect(() => new HbsEngine({ root, precompiled: { page: {} } })).toThrow(
      /executable/,
    );
  });
  it('honors layout opt-out and rejects oversized templates', async () => {
    const layout = new HbsEngine({
      root,
      defaultLayout: 'layout',
      partials: { footer: 'partials/footer' },
    });
    expect(await layout.render('page', {}, { layout: false })).not.toContain(
      '<main>',
    );
    const small = new HbsEngine({ root, maxTemplateBytes: 2 });
    await expect(small.render('page', {})).rejects.toMatchObject({
      code: 'INVALID_VIEW',
    });
  });
  it('bridges an Express engine callback while removing host settings', async () => {
    const result = await new Promise<string | undefined>((resolve, reject) =>
      engine.renderFile(
        path.join(root, 'page.hbs'),
        { title: 'MVC', settings: { app: () => {} } },
        (error, html) => (error ? reject(error) : resolve(html)),
      ),
    );
    expect(result).toContain('MVC');
  });
  it('rejects unknown engines and collisions and scopes composed props to each request', async () => {
    const registry = new ViewEngineRegistry();
    registry.register(engine);
    expect(() => registry.register(engine)).toThrow(/already registered/);
    expect(() => registry.get('unknown')).toThrow(/Unknown engine/);
    expect(() => registry.require('hbs', 'streaming')).toThrow(
      /does not support/,
    );
    const compose = async (_view: string, context: { title: string }) => ({
      title: context.title,
    });
    const html = await Promise.all(
      ['Alice', 'Bob'].map((title) =>
        registry.render('hbs', 'page', {}, { title }, [compose]),
      ),
    );
    expect(html[0]).toContain('Alice');
    expect(html[0]).not.toContain('Bob');
    expect(html[1]).toContain('Bob');
    await registry.dispose();
  });
  it('never invokes accessors while merging composed props', async () => {
    const registry = new ViewEngineRegistry();
    registry.register(engine);
    let calls = 0;
    const unsafe = Object.defineProperty({}, 'title', {
      enumerable: true,
      get() {
        calls++;
        return 'secret';
      },
    });
    await expect(
      registry.render('hbs', 'page', {}, undefined, [() => unsafe]),
    ).rejects.toMatchObject({ code: 'UNSAFE_MODEL' });
    expect(calls).toBe(0);
  });
  it('rolls back successful adapter startup and attempts every shutdown', async () => {
    const events: string[] = [];
    const registry = new ViewEngineRegistry();
    registry.register({
      name: 'first',
      extensions: [],
      capabilities: engine.capabilities,
      initialize: async () => {
        events.push('init');
      },
      render: async () => '',
      dispose: async () => {
        events.push('dispose');
      },
    });
    registry.register({
      name: 'second',
      extensions: [],
      capabilities: engine.capabilities,
      initialize: async () => {
        throw new Error('startup');
      },
      render: async () => '',
      dispose: async () => {
        events.push('failed-dispose');
        throw new Error('shutdown');
      },
    });
    await expect(registry.initialize()).rejects.toThrow('startup');
    expect(events).toEqual(['init', 'dispose']);
    await expect(registry.dispose()).rejects.toThrow('cleanup failed');
    expect(events.slice(2)).toEqual(['failed-dispose', 'dispose']);
  });
});
