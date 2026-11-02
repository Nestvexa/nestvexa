import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PugEngine } from '../packages/engine-pug/dist/index.js';
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

describe('Pug adapter trust boundaries', () => {
  let root: string;
  let engine: PugEngine;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'nestvexa-pug-'));
    await files(root, {
      'page.pug': 'h1= title\ninclude /partials/footer',
      'layout.pug': 'main= body\naside= slots.extra',
      'partials/footer.pug': 'footer= text',
    });
    engine = new PugEngine({ root });
    await engine.initialize();
  });
  afterEach(async () => {
    await engine.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it('declares honest capabilities and rejects render-time partial alias maps', async () => {
    expect(engine.name).toBe('pug');
    expect(engine.extensions).toEqual(['.pug']);
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
    await expect(
      engine.render('page', {}, { partials: { footer: 'partials/footer' } }),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: expect.stringContaining('include'),
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

  it('composes native extends/block layouts and mixins', async () => {
    await files(root, {
      'base.pug':
        'doctype html\nhtml\n  body\n    block content\n    include /partials/footer',
      'child.pug':
        'extends /base\nmixin badge(label)\n  span.badge= label\nblock content\n  +badge(title)',
    });
    expect(await engine.render('child', { title: '<x>', text: 'f' })).toBe(
      '<!DOCTYPE html><html><body><span class="badge">&lt;x&gt;</span><footer>f</footer></body></html>',
    );
  });

  it('escapes script-closing sequences and attribute breakouts; unescaped output is the documented bypass', async () => {
    await files(root, {
      'script.pug': 'script const s = "#{value}";\na(title=value) x',
      'raw.pug': 'div!= markup',
    });
    const hostile = '</script><script>alert(1)</script>" onmouseover="x';
    const html = await engine.render('script', { value: hostile });
    expect(html).not.toContain('</script><script>');
    expect(html).toContain('&lt;/script&gt;&lt;script&gt;');
    expect(html).toContain('&quot; onmouseover=&quot;x');
    expect(await engine.render('raw', { markup: '<i>raw</i>' })).toBe(
      '<div><i>raw</i></div>',
    );
  });

  it('renders framework SafeHtml in text but never as raw attribute markup', async () => {
    await files(root, {
      'fragment.pug':
        'div= widget\ndiv #{widget}\ndiv!= widget\np= fragment.value\na(title=widget) x',
    });
    const html = await engine.render('fragment', {
      widget: SafeHtml.trusted('<em data-nv-component="c1">ok</em>'),
      fragment: { value: '<script>bad</script>' },
    });
    expect(html).toBe(
      '<div><em data-nv-component="c1">ok</em></div><div><em data-nv-component="c1">ok</em></div><div><em data-nv-component="c1">ok</em></div><p>&lt;script&gt;bad&lt;/script&gt;</p><a title="{}">x</a>',
    );
    await expect(
      engine.render('fragment', {
        fragment: { toString: () => '<script>bad</script>' },
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_MODEL' });
  });

  it('accepts Live client directive attributes without hand-escaping', async () => {
    await files(root, {
      'counter.pug':
        'output= count\nbutton(type="button" nv:click="increment" x-data="{ open: false }" @click="open = !open") +',
    });
    expect(await engine.render('counter', { count: 1 })).toBe(
      '<output>1</output><button type="button" nv:click="increment" x-data="{ open: false }" @click="open = !open">+</button>',
    );
  });

  it('rejects traversal, absolute paths, alternate separators, drive letters, streams and NUL bytes', async () => {
    for (const name of [
      '../secret',
      '/secret',
      'x/../../secret',
      'x\\secret',
      'C:/secret',
      'page.pug:stream',
      'secret\0',
      'x//secret',
      './page',
    ])
      await expect(engine.render(name, {})).rejects.toMatchObject({
        code: 'INVALID_VIEW',
      });
  });

  it('rejects include/extends traversal and symlink escapes before reading outside the root', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'nestvexa-pug-out-'));
    try {
      await writeFile(path.join(outside, 'secret.pug'), 'p TOP-SECRET');
      await writeFile(path.join(outside, 'secret.txt'), 'TOP-SECRET');
      const escape = path
        .relative(root, path.join(outside, 'secret'))
        .split(path.sep)
        .join('/');
      for (const statement of [
        `include ${escape}`,
        `include /${escape}`,
        `include ${escape}.txt`,
        'include ../secret',
        `extends ${escape}`,
        'include partials\\footer',
        'include C:/secret',
      ]) {
        await writeFile(path.join(root, 'hostile.pug'), statement);
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
      await writeFile(path.join(root, 'hostile.pug'), 'include /linked/secret');
      await expect(engine.render('hostile', {})).rejects.toMatchObject({
        code: 'INVALID_VIEW',
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('resolves relative includes from nested templates and allows raw text includes inside the root', async () => {
    await files(root, {
      'pages/home.pug':
        'include parts/card\ninclude /partials/footer\nstyle\n  include /assets/site.css',
      'pages/parts/card.pug': 'p= label',
      'assets/site.css': 'p{color:red}',
    });
    expect(
      await engine.render('pages/home', { label: 'nested', text: 'f' }),
    ).toBe('<p>nested</p><footer>f</footer><style>p{color:red}</style>');
  });

  it('allows only registered filters and never loads jstransformer modules', async () => {
    await files(root, {
      'filtered.pug': 'div\n  :shout\n    hello',
      'unknown.pug': 'div\n  :markdown-it\n    # hi',
    });
    const filtered = new PugEngine({
      root,
      filters: { shout: (text) => text.toUpperCase() },
    });
    expect(await filtered.render('filtered', {})).toBe('<div>HELLO</div>');
    await expect(filtered.render('unknown', {})).rejects.toMatchObject({
      code: 'INVALID_VIEW',
      message: 'Unregistered Pug filter: markdown-it',
    });
    await expect(engine.render('filtered', {})).rejects.toMatchObject({
      code: 'INVALID_VIEW',
    });
    expect(
      () => new PugEngine({ root, filters: { 'bad name': (text) => text } }),
    ).toThrow(/filter/);
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
      1n,
      accessor,
      cyclic,
    ])
      await expect(engine.render('page', { value })).rejects.toMatchObject({
        code: 'UNSAFE_MODEL',
      });
    for (const key of ['pug', 'pug_html', 'self', 'locals'])
      await expect(engine.render('page', { [key]: 'x' })).rejects.toMatchObject(
        { code: 'UNSAFE_MODEL' },
      );
    let value: unknown = null;
    for (let n = 0; n < 34; n++) value = { value };
    await expect(engine.render('page', { value })).rejects.toMatchObject({
      code: 'UNSAFE_MODEL',
    });
    expect(calls).toBe(0);
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('reloads in development and uses a bounded, explicitly invalidated production cache', async () => {
    await files(root, { 'cached.pug': 'p= title\ninclude /partials/footer' });
    const cached = new PugEngine({ root, cache: true, cacheEntries: 2 });
    await cached.initialize();
    expect(await cached.render('cached', { title: 'first', text: 'a' })).toBe(
      '<p>first</p><footer>a</footer>',
    );
    await files(root, {
      'cached.pug': 'p replacement',
      'partials/footer.pug': 'footer changed #{text}',
    });
    expect(await engine.render('cached', {})).toBe('<p>replacement</p>');
    expect(await cached.render('cached', { title: 'kept', text: 'c' })).toBe(
      '<p>kept</p><footer>c</footer>',
    );
    cached.clearCache();
    expect(await cached.render('cached', {})).toBe('<p>replacement</p>');
    await cached.render('partials/footer', { text: 'z' });
    await cached.render('layout', { body: 'b' });
    await writeFile(path.join(root, 'cached.pug'), 'p evicted');
    expect(await cached.render('cached', {})).toBe('<p>evicted</p>');
    await cached.dispose();
    await writeFile(path.join(root, 'cached.pug'), 'p disposed');
    expect(await cached.render('cached', {})).toBe('<p>disposed</p>');
  });

  it('keeps helpers isolated, escapes their output, accepts trusted fragments and wraps failures', async () => {
    await files(root, { 'helper.pug': 'p= greet(title)' });
    const custom = new PugEngine({
      root,
      helpers: { greet: (title) => `Hello ${String(title)}` },
    });
    expect(await custom.render('helper', { title: '<x>' })).toBe(
      '<p>Hello &lt;x&gt;</p>',
    );
    await expect(engine.render('helper', {})).rejects.toMatchObject({
      code: 'RENDER_FAILED',
    });
    expect(
      await engine.render(
        'helper',
        {},
        { helpers: { greet: () => SafeHtml.trusted('<b>ok</b>') } },
      ),
    ).toBe('<p><b>ok</b></p>');
    await expect(
      engine.render('helper', {}, { helpers: { greet: async () => 'no' } }),
    ).rejects.toMatchObject({ code: 'RENDER_FAILED' });
    const thrown = new Error('helper failed');
    await expect(
      custom.render(
        'helper',
        {},
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
    expect(
      () => new PugEngine({ root, helpers: { pug_html: () => 1 } }),
    ).toThrow(/Reserved/);
  });

  it('reports missing includes, compile errors and runtime errors with name and line in development only', async () => {
    await files(root, {
      'missing-include.pug': 'p first\ninclude /absent',
      'broken.pug': 'p one\np two\np= missing.property',
      'malformed.pug': 'div\n  p ok\n p bad',
    });
    await expect(engine.render('missing-include', {})).rejects.toMatchObject({
      code: 'RENDER_FAILED',
      cause: expect.any(Error),
    });
    await expect(engine.render('broken', {})).rejects.toMatchObject({
      code: 'RENDER_FAILED',
      message: 'Unable to render view: broken (broken.pug:3)',
    });
    await expect(engine.render('malformed', {})).rejects.toMatchObject({
      code: 'RENDER_FAILED',
      message: 'Unable to render view: malformed (malformed.pug:3)',
    });
    const production = new PugEngine({ root, cache: true });
    await expect(production.render('broken', {})).rejects.toMatchObject({
      code: 'RENDER_FAILED',
      message: 'Unable to render view: broken',
    });
  });

  it('honors layout defaults and opt-out and rejects oversized templates', async () => {
    const layout = new PugEngine({ root, defaultLayout: 'layout' });
    expect(await layout.render('page', { title: 't', text: 'x' })).toContain(
      '<main>',
    );
    expect(
      await layout.render('page', { title: 't', text: 'x' }, { layout: false }),
    ).not.toContain('<main>');
    const small = new PugEngine({ root, maxTemplateBytes: 2 });
    await expect(small.render('page', {})).rejects.toMatchObject({
      code: 'INVALID_VIEW',
    });
    await files(root, { 'big-include.pug': 'include /partials/footer' });
    const tight = new PugEngine({ root, maxTemplateBytes: 24 });
    await files(root, { 'partials/footer.pug': `footer ${'x'.repeat(64)}` });
    await expect(tight.render('big-include', {})).rejects.toMatchObject({
      code: 'INVALID_VIEW',
    });
  });

  it('handles Windows-style roots and Express filenames without accepting backslash view IDs', async () => {
    const alternate = new PugEngine({
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
        path.join(root, 'page.pug'),
        {
          title: 'MVC',
          text: 'bridge',
          settings: { 'view options': { basedir: '/' } },
          _locals: { secret: 'host' },
        },
        (error, result) => (error ? reject(error) : resolve(result)),
      ),
    );
    expect(html).toBe('<h1>MVC</h1><footer>bridge</footer>');
    const outside = await new Promise<unknown>((resolve) =>
      alternate.renderFile(path.join(root, '..', 'x.pug'), {}, resolve),
    );
    expect(outside).toMatchObject({ code: 'INVALID_VIEW' });
  });

  it('reports unsupported capabilities helpfully at startup through the registry', () => {
    const registry = new ViewEngineRegistry();
    registry.register(engine);
    expect(() =>
      registry.requireAll('pug', ['layouts', 'partials']),
    ).not.toThrow();
    expect(() => registry.require('pug', 'precompilation')).toThrow(
      /Engine pug does not support precompilation\. Declared capabilities: .*safeHtml/,
    );
  });
});
