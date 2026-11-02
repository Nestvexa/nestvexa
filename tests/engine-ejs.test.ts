import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EjsEngine } from '../packages/engine-ejs/dist/index.js';
import {
  SafeHtml,
  ViewEngineRegistry,
  ViewError,
} from '../packages/views/dist/index.js';

async function files(
  root: string,
  entries: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [name, source] of Object.entries(entries)) {
    const filename = path.join(root, ...name.split('/'));
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, source);
  }
}

describe('EJS adapter trust boundaries', () => {
  let root: string;
  let engine: EjsEngine;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'nestvexa-ejs-'));
    await files(root, {
      'page.ejs': "<h1><%= title %></h1><%- include('/partials/footer') %>",
      'layout.ejs': '<main><%= body %></main><aside><%= slots.extra %></aside>',
      'partials/footer.ejs': '<footer><%= text %></footer>',
    });
    engine = new EjsEngine({ root });
    await engine.initialize();
  });
  afterEach(async () => {
    await engine.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it('declares honest capabilities', () => {
    expect(engine.name).toBe('ejs');
    expect(engine.extensions).toEqual(['.ejs']);
    expect(engine.capabilities).toEqual({
      layouts: true,
      partials: true,
      slots: true,
      asyncComposition: true,
      streaming: false,
      precompilation: false,
      safeHtml: true,
      viewComposers: true,
    });
  });

  it('escapes interpolation and retains Unicode/RTL through layout, include and slot composition', async () => {
    const result = await engine.render(
      'page',
      { title: '<script>alert(1)</script>', text: 'مرحبا \u200fשלום 🌍' },
      {
        layout: 'layout',
        slots: { extra: SafeHtml.trusted('<b>trusted</b>') },
      },
    );
    expect(result).toBe(
      '<main><h1>&lt;script&gt;alert(1)&lt;/script&gt;</h1><footer>مرحبا \u200fשלום 🌍</footer></main><aside><b>trusted</b></aside>',
    );
  });

  it('escapes script-closing sequences and attribute breakouts; raw output is the documented bypass', async () => {
    await files(root, {
      'script.ejs':
        '<script>const s = "<%= value %>";</script><a title="<%= value %>">x</a>',
      'raw.ejs': '<%- markup %>',
    });
    const hostile = '</script><script>alert(1)</script>" onmouseover="x';
    const html = await engine.render('script', { value: hostile });
    expect(html).not.toContain('</script><script>');
    expect(html).toContain('&lt;/script&gt;&lt;script&gt;');
    expect(html).toContain('&#34; onmouseover=&#34;x');
    expect(await engine.render('raw', { markup: '<i>raw</i>' })).toBe(
      '<i>raw</i>',
    );
  });

  it('renders framework SafeHtml through both output tags but keeps fragment-shaped data escaped', async () => {
    await files(root, {
      'fragment.ejs':
        '<%= widget %>|<%- widget %>|<%= fragment.value %>|<%= typeof widget.value %>',
    });
    expect(
      await engine.render('fragment', {
        widget: SafeHtml.trusted('<div data-nv-component="c1">ok</div>'),
        fragment: { value: '<script>bad</script>' },
      }),
    ).toBe(
      '<div data-nv-component="c1">ok</div>|<div data-nv-component="c1">ok</div>|&lt;script&gt;bad&lt;/script&gt;|undefined',
    );
    await expect(
      engine.render('fragment', {
        fragment: { toString: () => '<script>bad</script>' },
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_MODEL' });
  });

  it('rejects traversal, absolute paths, alternate separators, drive letters, streams and NUL bytes', async () => {
    for (const name of [
      '../secret',
      '/secret',
      'x/../../secret',
      'x\\secret',
      '..\\secret',
      'C:/secret',
      'C:\\secret',
      'page.ejs:stream',
      'secret\0',
      'x//secret',
      './page',
      '',
    ])
      await expect(engine.render(name, {})).rejects.toMatchObject({
        code: 'INVALID_VIEW',
      });
  });

  it('rejects template-authored include traversal before reading outside the root', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'nestvexa-ejs-out-'));
    try {
      await writeFile(path.join(outside, 'secret.ejs'), 'TOP-SECRET');
      const escape = path
        .relative(root, path.join(outside, 'secret'))
        .split(path.sep)
        .join('/');
      for (const reference of [
        escape,
        `/${escape}`,
        '../secret',
        'partials/../../secret',
        'partials\\\\footer',
        'C:/secret',
        path.join(outside, 'secret').split(path.sep).join('/'),
      ]) {
        await writeFile(
          path.join(root, 'hostile.ejs'),
          `<%- include(${JSON.stringify(reference)}) %>`,
        );
        const failure = await engine.render('hostile', {}).then(
          (html) => html,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(ViewError);
        expect(String(failure)).not.toContain('TOP-SECRET');
      }
      await symlink(outside, path.join(root, 'linked'), 'junction');
      await expect(engine.render('linked/secret', {})).rejects.toMatchObject({
        code: 'INVALID_VIEW',
      });
      await writeFile(
        path.join(root, 'hostile.ejs'),
        "<%- include('/linked/secret') %>",
      );
      await expect(engine.render('hostile', {})).rejects.toMatchObject({
        code: 'INVALID_VIEW',
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('resolves relative includes from nested templates and root-relative includes with a leading slash', async () => {
    await files(root, {
      'pages/home.ejs':
        "<%- include('parts/card', { label: 'nested' }) %><%- include('/partials/footer') %>",
      'pages/parts/card.ejs': '<p><%= label %></p>',
    });
    expect(await engine.render('pages/home', { text: 'f' })).toBe(
      '<p>nested</p><footer>f</footer>',
    );
  });

  it('rejects prototype-pollution keys, class values, functions, cycles and accessors without invoking getters', async () => {
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
      JSON.parse('{"constructor":{"prototype":{"polluted":true}}}') as unknown,
      new Date(),
      () => 'secret',
      NaN,
      Infinity,
      1n,
      accessor,
      cyclic,
    ])
      await expect(engine.render('page', { value })).rejects.toMatchObject({
        code: 'UNSAFE_MODEL',
      });
    await expect(
      engine.render(
        'page',
        JSON.parse('{"__proto__":{"title":"polluted"}}') as Record<
          string,
          unknown
        >,
      ),
    ).rejects.toMatchObject({ code: 'UNSAFE_MODEL' });
    expect(calls).toBe(0);
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(Object.prototype).not.toHaveProperty('title');
  });

  it('rejects data that would shadow EJS internals', async () => {
    for (const key of ['include', 'escapeFn', 'locals', '__append', '__line'])
      await expect(engine.render('page', { [key]: 'x' })).rejects.toMatchObject(
        { code: 'UNSAFE_MODEL' },
      );
    expect(
      () => new EjsEngine({ root, helpers: { include: () => 'x' } }),
    ).toThrow(/Reserved/);
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

  it('reloads in development and uses a bounded, explicitly invalidated production cache for views and includes', async () => {
    await files(root, {
      'cached.ejs': "<%= title %>|<%- include('/partials/footer') %>",
    });
    const cached = new EjsEngine({ root, cache: true, cacheEntries: 2 });
    await cached.initialize();
    expect(await cached.render('cached', { title: 'first', text: 'a' })).toBe(
      'first|<footer>a</footer>',
    );
    await files(root, {
      'cached.ejs': 'replacement',
      'partials/footer.ejs': '<footer>changed <%= text %></footer>',
    });
    expect(await engine.render('cached', {})).toBe('replacement');
    expect(await engine.render('page', { title: 't', text: 'b' })).toBe(
      '<h1>t</h1><footer>changed b</footer>',
    );
    expect(await cached.render('cached', { title: 'kept', text: 'c' })).toBe(
      'kept|<footer>c</footer>',
    );
    cached.clearCache();
    expect(await cached.render('cached', {})).toBe('replacement');
    await cached.render('partials/footer', { text: 'z' });
    await cached.render('page', { title: 'x', text: 'y' });
    await writeFile(path.join(root, 'cached.ejs'), 'evicted');
    expect(await cached.render('cached', {})).toBe('evicted');
    await cached.dispose();
    await writeFile(path.join(root, 'cached.ejs'), 'after dispose');
    expect(await cached.render('cached', {})).toBe('after dispose');
  });

  it('keeps helpers isolated, escapes their output, accepts trusted fragments and wraps failures', async () => {
    await files(root, { 'helper.ejs': '<%= greet(title) %>' });
    const custom = new EjsEngine({
      root,
      helpers: { greet: (title) => `Hello ${String(title)}` },
    });
    expect(await custom.render('helper', { title: '<x>' })).toBe(
      'Hello &lt;x&gt;',
    );
    await expect(engine.render('helper', {})).rejects.toMatchObject({
      code: 'RENDER_FAILED',
    });
    expect(
      await engine.render(
        'helper',
        { title: 'x' },
        { helpers: { greet: () => SafeHtml.trusted('<b>ok</b>') } },
      ),
    ).toBe('<b>ok</b>');
    await expect(
      engine.render(
        'helper',
        { title: 'x' },
        { helpers: { greet: async () => 'no' } },
      ),
    ).rejects.toMatchObject({ code: 'RENDER_FAILED' });
    const thrown = new Error('helper failed');
    await expect(
      custom.render(
        'helper',
        { title: 'x' },
        {
          helpers: {
            greet: () => {
              throw thrown;
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'RENDER_FAILED', cause: thrown });
    await expect(
      custom.render('helper', { greet: 'model' }),
    ).rejects.toMatchObject({ code: 'INVALID_VIEW' });
    await custom.dispose();
  });

  it('reports missing includes and template errors with name and line in development only', async () => {
    await files(root, {
      'missing-include.ejs': "first\n<%- include('/absent') %>",
      'broken.ejs': 'one\ntwo\n<%= missing.property %>',
      'malformed.ejs': '<% if (true) { %>',
    });
    await expect(engine.render('missing-include', {})).rejects.toMatchObject({
      code: 'RENDER_FAILED',
      cause: expect.any(Error),
    });
    await expect(engine.render('broken', {})).rejects.toMatchObject({
      code: 'RENDER_FAILED',
      message: 'Unable to render view: broken (broken.ejs:3)',
    });
    await expect(engine.render('malformed', {})).rejects.toMatchObject({
      code: 'RENDER_FAILED',
      cause: expect.any(Error),
    });
    const production = new EjsEngine({ root, cache: true });
    await expect(production.render('broken', {})).rejects.toMatchObject({
      code: 'RENDER_FAILED',
      message: 'Unable to render view: broken',
    });
  });

  it('supports render-local and engine-level partial aliases without stale cached aliases', async () => {
    await files(root, {
      'alias.ejs': "<%- include('card') %>",
      'cards/a.ejs': 'A',
      'cards/b.ejs': 'B',
    });
    const aliased = new EjsEngine({
      root,
      cache: true,
      partials: { card: 'cards/a' },
    });
    expect(await aliased.render('alias', {})).toBe('A');
    expect(
      await aliased.render('alias', {}, { partials: { card: 'cards/b' } }),
    ).toBe('B');
    expect(await aliased.render('alias', {})).toBe('A');
    expect(
      () => new EjsEngine({ root, partials: { card: '../outside' } }),
    ).toThrow(/root-relative/);
    await expect(
      aliased.render('alias', {}, { partials: { __proto__x: 'cards/a' } }),
    ).rejects.toMatchObject({ code: 'INVALID_VIEW' });
  });

  it('honors layout defaults and opt-out and rejects oversized templates', async () => {
    const layout = new EjsEngine({ root, defaultLayout: 'layout' });
    expect(await layout.render('page', { title: 't', text: 'x' })).toContain(
      '<main>',
    );
    expect(
      await layout.render('page', { title: 't', text: 'x' }, { layout: false }),
    ).not.toContain('<main>');
    const small = new EjsEngine({ root, maxTemplateBytes: 2 });
    await expect(small.render('page', {})).rejects.toMatchObject({
      code: 'INVALID_VIEW',
    });
  });

  it('handles Windows-style roots and Express filenames without accepting backslash view IDs', async () => {
    const alternate = new EjsEngine({
      root:
        path.sep === '\\'
          ? root.replaceAll('\\', '/')
          : `${root}${path.sep}.${path.sep}`,
    });
    await alternate.initialize();
    expect(await alternate.render('page', { title: 'w', text: 'x' })).toBe(
      '<h1>w</h1><footer>x</footer>',
    );
    const html = await new Promise<string | undefined>((resolve, reject) =>
      alternate.renderFile(
        path.join(root, 'page.ejs'),
        {
          title: 'MVC',
          text: 'bridge',
          settings: {
            'view options': {
              outputFunctionName: 'x;process.exit(1);//',
              client: true,
            },
          },
          _locals: { secret: 'host' },
        },
        (error, result) => (error ? reject(error) : resolve(result)),
      ),
    );
    expect(html).toBe('<h1>MVC</h1><footer>bridge</footer>');
    const outside = await new Promise<unknown>((resolve) =>
      alternate.renderFile(path.join(root, '..', 'x.ejs'), {}, resolve),
    );
    expect(outside).toMatchObject({ code: 'INVALID_VIEW' });
  });

  it('composes through the registry with request-scoped composers and helpful capability errors', async () => {
    const registry = new ViewEngineRegistry();
    registry.register(engine);
    expect(() =>
      registry.requireAll('ejs', ['layouts', 'safeHtml']),
    ).not.toThrow();
    expect(() =>
      registry.requireAll('ejs', ['streaming', 'precompilation']),
    ).toThrow(
      /does not support streaming, precompilation\. Declared capabilities: layouts, partials, slots/,
    );
    const html = await Promise.all(
      ['Alice', 'Bob'].map((title) =>
        registry.render('ejs', 'page', { text: 'f' }, { title }, [
          async (_view, context: { title: string }) => ({
            title: context.title,
          }),
        ]),
      ),
    );
    expect(html).toEqual([
      '<h1>Alice</h1><footer>f</footer>',
      '<h1>Bob</h1><footer>f</footer>',
    ]);
    await registry.dispose();
  });
});
