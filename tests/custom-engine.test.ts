import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SafeHtml,
  TemplateRoot,
  ViewEngineRegistry,
  copyViewModel,
  expressViewModel,
  invokeViewHelper,
  normalizeViewId,
  resolveTemplateReference,
  type ViewCapabilities,
  type ViewEngineAdapter,
} from '../packages/views/dist/index.js';
import { TokenEngine } from '../examples/custom-engine/src/engine.js';

describe('third-party custom engine example', () => {
  let root: string;
  let engine: TokenEngine;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'nestvexa-tokens-'));
    await writeFile(
      path.join(root, 'page.tok'),
      '<h1>{{ title }}</h1><p>{{ user.name }}</p>',
    );
    await writeFile(
      path.join(root, 'layout.tok'),
      '<main>{{ body }}</main><aside>{{ slots.side }}</aside>',
    );
    engine = new TokenEngine({ root });
    await engine.initialize();
  });
  afterEach(async () => {
    await engine.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it('escapes values, emits only server SafeHtml raw and composes layouts and slots', async () => {
    expect(
      await engine.render(
        'page',
        { title: '<b>"x"</b>', user: { name: 'سلام' } },
        {
          layout: 'layout',
          slots: { side: SafeHtml.trusted('<nav>ok</nav>') },
        },
      ),
    ).toBe(
      '<main><h1>&lt;b&gt;&quot;x&quot;&lt;/b&gt;</h1><p>سلام</p></main><aside><nav>ok</nav></aside>',
    );
    expect(await engine.render('page', {})).toBe('<h1></h1><p></p>');
  });

  it('rejects unsupported render features and invalid view names', async () => {
    await expect(
      engine.render('page', {}, { partials: { a: 'page' } }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await expect(
      engine.render('page', {}, { helpers: { a: () => 1 } }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await expect(
      engine.render('page', {}, { theme: 'dark' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    for (const name of ['../x', '/x', 'a\\b', 'C:/x', 'x\0'])
      await expect(engine.render(name, {})).rejects.toMatchObject({
        code: 'INVALID_VIEW',
      });
    await expect(
      engine.render(
        'page',
        JSON.parse('{"__proto__":{"x":1}}') as Record<string, unknown>,
      ),
    ).rejects.toMatchObject({ code: 'UNSAFE_MODEL' });
  });

  it('reports syntax and value errors with template name and line in development', async () => {
    await writeFile(path.join(root, 'broken.tok'), 'a\nb\n{{ not valid }}');
    await writeFile(path.join(root, 'object.tok'), 'a\n{{ user }}');
    await expect(engine.render('broken', {})).rejects.toMatchObject({
      code: 'RENDER_FAILED',
      message: 'Unable to render view: broken (broken.tok:3)',
    });
    await expect(
      engine.render('object', { user: { name: 'x' } }),
    ).rejects.toMatchObject({
      code: 'RENDER_FAILED',
      message: 'Unable to render view: object (object.tok:2)',
    });
    const production = new TokenEngine({ root, cache: true });
    await expect(production.render('broken', {})).rejects.toMatchObject({
      message: 'Unable to render view: broken',
    });
  });
});

describe('adapter registration and startup capability checks', () => {
  const capabilities: ViewCapabilities = {
    layouts: true,
    partials: false,
    slots: false,
    asyncComposition: false,
    streaming: false,
    precompilation: false,
    safeHtml: true,
    viewComposers: false,
  };
  function adapter(
    overrides: Partial<ViewEngineAdapter> = {},
  ): ViewEngineAdapter {
    return {
      name: 'plugin',
      extensions: ['.tpl'],
      capabilities,
      initialize: async () => undefined,
      render: async () => '',
      dispose: async () => undefined,
      ...overrides,
    };
  }

  it('rejects malformed third-party adapters at registration with every problem listed', () => {
    const registry = new ViewEngineRegistry();
    const incomplete = adapter({
      extensions: ['tpl'],
      capabilities: { layouts: true } as unknown as ViewCapabilities,
    });
    expect(() => registry.register(incomplete)).toThrow(
      /Invalid view engine adapter plugin: extensions must be strings such as "\.ejs"; capability "partials" must be declared as a boolean/,
    );
    expect(() =>
      registry.register(
        adapter({ render: 'nope' as unknown as ViewEngineAdapter['render'] }),
      ),
    ).toThrow(/render\(\) must be a function/);
    expect(() => registry.get('plugin')).toThrow(/Unknown engine/);
  });

  it('names all missing and declared capabilities in one startup error', () => {
    const registry = new ViewEngineRegistry();
    registry.register(adapter());
    expect(() =>
      registry.requireAll('plugin', ['layouts', 'safeHtml']),
    ).not.toThrow();
    let failure: unknown;
    try {
      registry.requireAll('plugin', ['layouts', 'partials', 'streaming']);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message:
        'Engine plugin does not support partials, streaming. Declared capabilities: layouts, safeHtml. Choose an engine that declares them or remove the dependent feature.',
    });
    expect(() =>
      registry.requireAll('plugin', [
        'telepathy' as unknown as keyof ViewCapabilities,
      ]),
    ).toThrow(/Unknown view capability: telepathy/);
  });
});

describe('@nestvexa/views adapter kit', () => {
  it('normalizes view IDs and template references with HBS-equivalent strictness', () => {
    expect(normalizeViewId('a/b', '.ejs')).toBe('a/b.ejs');
    expect(normalizeViewId('a/b.ejs', '.ejs')).toBe('a/b.ejs');
    for (const view of [
      '',
      '../a',
      'a/..',
      '/a',
      'a\\b',
      'C:a',
      'a\0',
      'a//b',
      './a',
      'x'.repeat(241),
    ])
      expect(() => normalizeViewId(view, '.ejs')).toThrow(/root-relative/);
    expect(resolveTemplateReference('pages/home.ejs', 'card')).toBe(
      'pages/card',
    );
    expect(resolveTemplateReference('pages/home.ejs', '/card')).toBe('card');
    expect(resolveTemplateReference(undefined, 'card')).toBe('card');
    for (const reference of [
      '../card',
      '//card',
      'a/./b',
      '/../x',
      'C:/x',
      'a\\b',
      '/',
    ])
      expect(() =>
        resolveTemplateReference('pages/home.ejs', reference),
      ).toThrow(/root-relative/);
  });

  it('contains template files by real path and maps filenames back to IDs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nestvexa-kit-'));
    try {
      await mkdir(path.join(root, 'nested'));
      await writeFile(path.join(root, 'nested', 'view.tpl'), '\uFEFFbody');
      const templates = new TemplateRoot({ root, extension: '.tpl' });
      await templates.assertDirectory();
      const filename = await templates.resolve('nested/view');
      expect(templates.resolveSync('nested/view')).toBe(filename);
      expect(await templates.read(filename)).toBe('body');
      expect(templates.readSync(filename)).toBe('body');
      expect(
        templates.viewFromFile(path.join(root, 'nested', 'view.tpl')),
      ).toBe('nested/view.tpl');
      expect(templates.viewFromFile(filename)).toBe('nested/view.tpl');
      expect(
        templates.viewFromFile(path.join(root, '..', 'x.tpl')),
      ).toBeUndefined();
      expect(templates.viewFromFile(root)).toBeUndefined();
      const tiny = new TemplateRoot({
        root,
        extension: '.tpl',
        maxTemplateBytes: 2,
      });
      await expect(tiny.read(filename)).rejects.toMatchObject({
        code: 'INVALID_VIEW',
      });
      expect(() => tiny.readSync(filename)).toThrow(/oversized/);
      await expect(
        templates.read(path.join(root, 'nested')),
      ).rejects.toMatchObject({
        code: 'INVALID_VIEW',
      });
      expect(() => new TemplateRoot({ root, extension: 'tpl' })).toThrow(
        /extension/,
      );
      expect(() => new TemplateRoot({ root: '', extension: '.tpl' })).toThrow(
        /root/,
      );
      expect(
        () =>
          new TemplateRoot({ root, extension: '.tpl', maxTemplateBytes: 0 }),
      ).toThrow(/positive/);
      await expect(
        new TemplateRoot({
          root: filename,
          extension: '.tpl',
        }).assertDirectory(),
      ).rejects.toMatchObject({ code: 'INVALID_VIEW' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('copies public models into null-prototype data and maps only SafeHtml through the trusted hook', () => {
    const marker = { trusted: true };
    const copied = copyViewModel(
      { a: [1, { b: SafeHtml.trusted('<i>') }], c: null, d: undefined },
      () => marker,
    );
    expect(Object.getPrototypeOf(copied)).toBeNull();
    expect(copied['a']).toEqual([1, { b: marker }]);
    expect(() => copyViewModel([], () => marker)).toThrow(/must be an object/);
    expect(() =>
      copyViewModel({ a: [1, 2, 3] }, () => marker, { maxNodes: 3 }),
    ).toThrow(/structural limits/);
    expect(() =>
      copyViewModel({ a: { b: {} } }, () => marker, { maxDepth: 1 }),
    ).toThrow(/structural limits/);
  });

  it('strips Express host metadata and refuses async helpers', async () => {
    const model = expressViewModel({
      title: 'x',
      settings: { 'view options': { client: true } },
      _locals: { secret: true },
      cache: true,
    });
    expect(Object.keys(model)).toEqual(['title']);
    expect(invokeViewHelper((value) => `#${String(value)}`, [1])).toBe('#1');
    expect(() => invokeViewHelper(async () => 1, [])).toThrow(/Async helpers/);
    expect(() =>
      invokeViewHelper(() => ({ then: () => undefined }), []),
    ).toThrow(/Async helpers/);
  });
});
