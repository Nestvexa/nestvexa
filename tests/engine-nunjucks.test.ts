import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NunjucksEngine } from '../packages/engine-nunjucks/dist/index.js';
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

describe('Nunjucks adapter trust boundaries', () => {
  let root: string;
  let engine: NunjucksEngine;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'nestvexa-njk-'));
    await files(root, {
      'page.njk': '<h1>{{ title }}</h1>{% include "partials/footer.njk" %}',
      'layout.njk': '<main>{{ body }}</main><aside>{{ slots.extra }}</aside>',
      'partials/footer.njk': '<footer>{{ text }}</footer>',
    });
    engine = new NunjucksEngine({ root });
    await engine.initialize();
  });
  afterEach(async () => {
    await engine.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it('declares honest capabilities', () => {
    expect(engine.name).toBe('nunjucks');
    expect(engine.extensions).toEqual(['.njk']);
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

  it('composes native extends/blocks and imported macros', async () => {
    await files(root, {
      'base.njk':
        '<body>{% block content %}{% endblock %}{% include "partials/footer.njk" %}</body>',
      'macros.njk':
        '{% macro badge(label) %}<span class="badge">{{ label }}</span>{% endmacro %}',
      'child.njk':
        '{% extends "base.njk" %}{% from "macros.njk" import badge %}{% block content %}{{ badge(title) }}{% endblock %}',
    });
    expect(await engine.render('child', { title: '<x>', text: 'f' })).toBe(
      '<body><span class="badge">&lt;x&gt;</span><footer>f</footer></body>',
    );
  });

  it('escapes script-closing sequences and attribute breakouts; the safe filter is the documented bypass', async () => {
    await files(root, {
      'script.njk':
        '<script>const s = "{{ value }}";</script><a title="{{ value }}">x</a>',
      'raw.njk': '{{ markup | safe }}',
    });
    const hostile = '</script><script>alert(1)</script>" onmouseover="x';
    const html = await engine.render('script', { value: hostile });
    expect(html).not.toContain('</script><script>');
    expect(html).toContain('&lt;/script&gt;&lt;script&gt;');
    expect(html).toContain('&quot; onmouseover=&quot;x');
    expect(await engine.render('raw', { markup: '<i>raw</i>' })).toBe(
      '<i>raw</i>',
    );
  });

  it('renders framework SafeHtml unescaped but keeps fragment-shaped data escaped', async () => {
    await files(root, {
      'fragment.njk': '{{ widget }}|{{ fragment.value }}|{{ fragment.val }}',
    });
    expect(
      await engine.render('fragment', {
        widget: SafeHtml.trusted('<div data-nv-component="c1">ok</div>'),
        fragment: { value: '<script>bad</script>', val: '<i>x</i>' },
      }),
    ).toBe(
      '<div data-nv-component="c1">ok</div>|&lt;script&gt;bad&lt;/script&gt;|&lt;i&gt;x&lt;/i&gt;',
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
      'C:/secret',
      'page.njk:stream',
      'secret\0',
      'x//secret',
      './page',
    ])
      await expect(engine.render(name, {})).rejects.toMatchObject({
        code: 'INVALID_VIEW',
      });
  });

  it('rejects include/extends/import traversal and symlink escapes before reading outside the root', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'nestvexa-njk-out-'));
    try {
      await writeFile(path.join(outside, 'secret.njk'), 'TOP-SECRET');
      const escape = path
        .relative(root, path.join(outside, 'secret.njk'))
        .split(path.sep)
        .join('/');
      for (const statement of [
        `{% include "${escape}" %}`,
        `{% extends "${escape}" %}`,
        `{% import "${escape}" as x %}`,
        '{% include "../secret.njk" %}',
        '{% include "./partials/footer.njk" %}',
        `{% include "${path.join(outside, 'secret.njk').split(path.sep).join('/')}" %}`,
        '{% include "partials\\\\footer.njk" %}',
        '{% include "C:/secret.njk" %}',
      ]) {
        await writeFile(path.join(root, 'hostile.njk'), statement);
        const failure = await engine.render('hostile', {}).then(
          (html) => html,
          (error: unknown) => error,
        );
        expect(failure).toMatchObject({ code: 'INVALID_VIEW' });
        expect(String(failure)).not.toContain('TOP-SECRET');
      }
      await symlink(outside, path.join(root, 'linked'), 'junction');
      await expect(engine.render('linked/secret', {})).rejects.toMatchObject({
        code: 'INVALID_VIEW',
      });
      await writeFile(
        path.join(root, 'hostile.njk'),
        '{% include "linked/secret.njk" %}',
      );
      await expect(engine.render('hostile', {})).rejects.toMatchObject({
        code: 'INVALID_VIEW',
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
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
      Infinity,
      1n,
      accessor,
      cyclic,
    ])
      await expect(engine.render('page', { value })).rejects.toMatchObject({
        code: 'UNSAFE_MODEL',
      });
    let value: unknown = null;
    for (let n = 0; n < 34; n++) value = { value };
    await expect(engine.render('page', { value })).rejects.toMatchObject({
      code: 'UNSAFE_MODEL',
    });
    await expect(
      engine.render('page', { [Symbol('hidden')]: 'value' }),
    ).rejects.toMatchObject({ code: 'UNSAFE_MODEL' });
    expect(calls).toBe(0);
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('reloads in development and uses an explicitly invalidated production cache', async () => {
    await files(root, {
      'cached.njk': '{{ title }}|{% include "partials/footer.njk" %}',
    });
    const cached = new NunjucksEngine({ root, cache: true });
    await cached.initialize();
    expect(await cached.render('cached', { title: 'first', text: 'a' })).toBe(
      'first|<footer>a</footer>',
    );
    await files(root, {
      'cached.njk': 'replacement',
      'partials/footer.njk': '<footer>changed {{ text }}</footer>',
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
    await writeFile(path.join(root, 'cached.njk'), 'retained');
    expect(await cached.render('cached', {})).toBe('replacement');
    await cached.dispose();
    expect(await cached.render('cached', {})).toBe('retained');
  });

  it('keeps globals, filters and render helpers isolated, escapes their output and wraps failures', async () => {
    await files(root, {
      'helper.njk': '{{ greet(title) }}|{{ title | shout }}',
      'local.njk': '{{ widget() }}',
    });
    const custom = new NunjucksEngine({
      root,
      helpers: { greet: (title) => `Hello ${String(title)}` },
      filters: { shout: (value) => `${String(value).toUpperCase()}!` },
    });
    expect(await custom.render('helper', { title: '<x>' })).toBe(
      'Hello &lt;x&gt;|&lt;X&gt;!',
    );
    await expect(engine.render('helper', {})).rejects.toMatchObject({
      code: 'RENDER_FAILED',
    });
    expect(
      await engine.render(
        'local',
        {},
        { helpers: { widget: () => SafeHtml.trusted('<b>ok</b>') } },
      ),
    ).toBe('<b>ok</b>');
    await expect(
      engine.render('local', {}, { helpers: { widget: async () => 'no' } }),
    ).rejects.toMatchObject({ code: 'RENDER_FAILED' });
    const thrown = new Error('helper failed');
    const failure = await engine
      .render(
        'local',
        {},
        {
          helpers: {
            widget: () => {
              throw thrown;
            },
          },
        },
      )
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'RENDER_FAILED' });
    let cause: unknown = failure;
    const chain: unknown[] = [];
    while (cause instanceof Error) {
      chain.push(cause);
      cause = cause.cause;
    }
    expect(chain).toContain(thrown);
    await expect(
      engine.render(
        'local',
        { widget: 'model' },
        { helpers: { widget: () => 'x' } },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_VIEW' });
    expect(
      () => new NunjucksEngine({ root, filters: { 'a b': () => 1 } }),
    ).toThrow(/alias/);
    await custom.dispose();
  });

  it('reports missing includes and template errors with name and line in development only', async () => {
    await files(root, {
      'missing-include.njk': 'first\n{% include "absent.njk" %}',
      'broken.njk': 'one\ntwo\n{{ missing.property() }}',
      'malformed.njk': 'one\ntwo\n{% if title %}{% endfor %}',
      'outer.njk': 'outer\n{% include "broken.njk" %}',
    });
    await expect(engine.render('missing-include', {})).rejects.toMatchObject({
      code: 'RENDER_FAILED',
      cause: expect.any(Error),
    });
    await expect(engine.render('broken', {})).rejects.toMatchObject({
      code: 'RENDER_FAILED',
      message: 'Unable to render view: broken (broken.njk:3)',
    });
    await expect(engine.render('malformed', {})).rejects.toMatchObject({
      code: 'RENDER_FAILED',
      message: 'Unable to render view: malformed (malformed.njk:3)',
    });
    await expect(engine.render('outer', {})).rejects.toMatchObject({
      code: 'RENDER_FAILED',
      message: 'Unable to render view: outer (broken.njk:3)',
    });
    await expect(engine.render('absent', {})).rejects.toBeInstanceOf(ViewError);
    const production = new NunjucksEngine({ root, cache: true });
    await expect(production.render('broken', {})).rejects.toMatchObject({
      code: 'RENDER_FAILED',
      message: 'Unable to render view: broken',
    });
  });

  it('supports render-local and engine-level partial aliases without stale cached aliases', async () => {
    await files(root, {
      'alias.njk': '{% include "card" %}',
      'cards/a.njk': 'A',
      'cards/b.njk': 'B',
    });
    const aliased = new NunjucksEngine({
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
      () => new NunjucksEngine({ root, partials: { card: '../outside' } }),
    ).toThrow(/root-relative/);
  });

  it('honors layout defaults and opt-out and rejects oversized templates', async () => {
    const layout = new NunjucksEngine({ root, defaultLayout: 'layout' });
    expect(await layout.render('page', { title: 't', text: 'x' })).toContain(
      '<main>',
    );
    expect(
      await layout.render('page', { title: 't', text: 'x' }, { layout: false }),
    ).not.toContain('<main>');
    const small = new NunjucksEngine({ root, maxTemplateBytes: 2 });
    await expect(small.render('page', {})).rejects.toMatchObject({
      code: 'INVALID_VIEW',
    });
    await files(root, { 'big-include.njk': '{% include "huge.njk" %}' });
    await files(root, { 'huge.njk': 'x'.repeat(64) });
    const tight = new NunjucksEngine({ root, maxTemplateBytes: 32 });
    await expect(tight.render('big-include', {})).rejects.toMatchObject({
      code: 'INVALID_VIEW',
    });
  });

  it('handles Windows-style roots and Express filenames without accepting backslash view IDs', async () => {
    const alternate = new NunjucksEngine({
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
        path.join(root, 'page.njk'),
        {
          title: 'MVC',
          text: 'bridge',
          settings: { views: '/' },
          _locals: { secret: 'host' },
        },
        (error, result) => (error ? reject(error) : resolve(result)),
      ),
    );
    expect(html).toBe('<h1>MVC</h1><footer>bridge</footer>');
    const outside = await new Promise<unknown>((resolve) =>
      alternate.renderFile(path.join(root, '..', 'x.njk'), {}, resolve),
    );
    expect(outside).toMatchObject({ code: 'INVALID_VIEW' });
  });

  it('reports unsupported capabilities helpfully at startup through the registry', () => {
    const registry = new ViewEngineRegistry();
    registry.register(engine);
    expect(() =>
      registry.requireAll('nunjucks', ['layouts', 'slots']),
    ).not.toThrow();
    expect(() => registry.requireAll('nunjucks', ['streaming'])).toThrow(
      /Engine nunjucks does not support streaming/,
    );
  });
});
