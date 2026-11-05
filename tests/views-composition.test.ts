import 'reflect-metadata';
import { Controller, Get, Post } from '@nestjs/common';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import { EjsEngine } from '../packages/engine-ejs/dist/index.js';
import { PugEngine } from '../packages/engine-pug/dist/index.js';
import { NunjucksEngine } from '../packages/engine-nunjucks/dist/index.js';
import { ViteAssets } from '../packages/vite/dist/index.js';
import {
  RouteTable,
  SafeHtml,
  TemplateRoot,
  ViewError,
  assetHelpers,
  grantPermissions,
  helperArguments,
  pageMetaHelpers,
  permissionHelpers,
  resolveTemplateReference,
  routeHelpers,
  routesFromControllers,
  type ViewEngineAdapter,
} from '../packages/views/dist/index.js';

let base: string;
async function files(entries: Readonly<Record<string, string>>): Promise<void> {
  for (const [name, content] of Object.entries(entries)) {
    const file = path.join(base, ...name.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}
const dirs = () => ({
  root: path.join(base, 'views'),
  namespaces: { admin: path.join(base, 'admin') },
  themes: { dark: path.join(base, 'themes', 'dark') },
});
beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'nestvexa-compose-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('namespaced and themed template resolution', () => {
  beforeEach(async () => {
    await files({
      'views/page.hbs': 'base page',
      'views/vendor/admin/users/index.hbs': 'app override',
      'admin/users/index.hbs': 'package index',
      'admin/users/show.hbs': 'package show',
      'themes/dark/page.hbs': 'dark page',
      'themes/dark/vendor/admin/users/show.hbs': 'dark show',
    });
  });
  it('canonicalizes IDs and rejects unknown, malformed and escaping names', () => {
    const root = new TemplateRoot({ ...dirs(), extension: '.hbs' });
    expect(root.id('admin::users/index')).toBe('admin::users/index.hbs');
    expect(root.id('page')).toBe('page.hbs');
    expect(root.namespaces).toEqual(['admin']);
    expect(root.themes).toEqual(['dark']);
    for (const name of [
      'shop::x',
      'Admin::x',
      'admin::../x',
      'admin::/x',
      'admin::a::b',
      '::x',
      'constructor::x',
      'C:/x',
    ])
      expect(() => root.id(name), name).toThrow(ViewError);
    expect(() => root.theme('light')).toThrow('Unknown view theme');
    expect(
      () =>
        new TemplateRoot({
          root: base,
          extension: '.hbs',
          namespaces: { 'bad name': base },
        }),
    ).toThrow('Invalid view namespace name');
    expect(
      () =>
        new TemplateRoot({
          root: base,
          extension: '.hbs',
          themes: { constructor: base },
        }),
    ).toThrow('Invalid view theme name');
  });
  it('searches theme, application vendor override, then the namespace root', async () => {
    const root = new TemplateRoot({ ...dirs(), extension: '.hbs' });
    const read = async (view: string, theme?: string) =>
      root.read(await root.resolve(view, undefined, theme));
    expect(await read('page')).toBe('base page');
    expect(await read('page', 'dark')).toBe('dark page');
    expect(await read('admin::users/index')).toBe('app override');
    expect(await read('admin::users/index', 'dark')).toBe('app override');
    expect(await read('admin::users/show')).toBe('package show');
    expect(await read('admin::users/show', 'dark')).toBe('dark show');
    expect(
      root.readSync(root.resolveSync('admin::users/show', undefined, 'dark')),
    ).toBe('dark show');
    await expect(root.resolve('admin::users/none')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('maps files back to the view they provide or override', () => {
    const root = new TemplateRoot({ ...dirs(), extension: '.hbs' });
    expect(
      root.viewFromFile(path.join(base, 'admin', 'users', 'show.hbs')),
    ).toBe('admin::users/show.hbs');
    expect(
      root.viewFromFile(
        path.join(base, 'views', 'vendor', 'admin', 'users', 'index.hbs'),
      ),
    ).toBe('admin::users/index.hbs');
    expect(
      root.viewFromFile(
        path.join(
          base,
          'themes',
          'dark',
          'vendor',
          'admin',
          'users',
          'show.hbs',
        ),
      ),
    ).toBe('admin::users/show.hbs');
    expect(
      root.viewFromFile(path.join(base, 'themes', 'dark', 'page.hbs')),
    ).toBe('page.hbs');
    expect(root.viewFromFile(path.join(base, 'elsewhere.hbs'))).toBeUndefined();
  });
  it('keeps template references inside the including namespace', () => {
    expect(resolveTemplateReference('admin::users/index.ejs', 'row')).toBe(
      'admin::users/row',
    );
    expect(resolveTemplateReference('admin::users/index.ejs', '/row')).toBe(
      'admin::row',
    );
    expect(resolveTemplateReference('users/index.ejs', 'admin::row')).toBe(
      'admin::row',
    );
    for (const reference of ['admin::../x', '../x', 'Bad::x'])
      expect(() =>
        resolveTemplateReference('admin::users/index.ejs', reference),
      ).toThrow(ViewError);
  });
});

describe('HBS namespaces, themes and nested layouts', () => {
  beforeEach(async () => {
    await files({
      'views/page.hbs': '<p>{{title}}</p>{{> card}}',
      'views/partials/card.hbs': '<i>card</i>',
      'views/layouts/base.hbs':
        '<html><body>{{body}}<aside>{{slots.side}}</aside></body></html>',
      'views/layouts/section.hbs':
        '{{!< layouts/base}}\n<section>{{body}}</section>',
      'views/layouts/admin.hbs':
        '{{!< layouts/section}}<div class="admin">{{body}}</div>',
      'views/layouts/loop-a.hbs': '{{!< layouts/loop-b}}{{body}}',
      'views/layouts/loop-b.hbs': '{{!< layouts/loop-a}}{{body}}',
      'admin/users/index.hbs': '<h1>{{title}}</h1>',
      'admin/layouts/panel.hbs': '{{!< layouts/base}}<nav>panel</nav>{{body}}',
      'themes/dark/partials/card.hbs': '<i>dark card</i>',
      'themes/dark/layouts/base.hbs': '<html class="dark">{{body}}</html>',
    });
  });
  const engine = (cache = false) =>
    new HbsEngine({
      ...dirs(),
      cache,
      partials: { card: 'partials/card' },
    });
  it('renders namespaced views and layouts through each inherited parent', async () => {
    const hbs = engine();
    await hbs.initialize();
    expect(
      await hbs.render(
        'admin::users/index',
        { title: '<Users>' },
        {
          layout: 'layouts/admin',
          slots: { side: SafeHtml.trusted('<b>s</b>') },
        },
      ),
    ).toBe(
      '<html><body><section><div class="admin"><h1>&lt;Users&gt;</h1></div></section><aside><b>s</b></aside></body></html>',
    );
    expect(
      await hbs.render(
        'page',
        { title: 'x' },
        { layout: 'admin::layouts/panel' },
      ),
    ).toBe(
      '<html><body><nav>panel</nav><p>x</p><i>card</i><aside></aside></body></html>',
    );
    expect(await hbs.render('page', { title: 'x' }, { layout: false })).toBe(
      '<p>x</p><i>card</i>',
    );
    await expect(
      hbs.render('page', { title: 'x' }, { layout: 'layouts/loop-a' }),
    ).rejects.toMatchObject({ code: 'INVALID_VIEW' });
    await expect(hbs.render('shop::page', {})).rejects.toMatchObject({
      code: 'INVALID_VIEW',
    });
  });
  it('applies theme overrides to views, partials and layouts per render, also when cached', async () => {
    const hbs = engine(true);
    await hbs.initialize();
    for (let round = 0; round < 2; round++) {
      expect(
        await hbs.render(
          'page',
          { title: 't' },
          { layout: 'layouts/section', theme: 'dark' },
        ),
      ).toBe(
        '<html class="dark"><section><p>t</p><i>dark card</i></section></html>',
      );
      expect(await hbs.render('page', { title: 't' }, { layout: false })).toBe(
        '<p>t</p><i>card</i>',
      );
    }
    await expect(
      hbs.render('page', {}, { theme: 'light' }),
    ).rejects.toMatchObject({ code: 'INVALID_VIEW' });
  });
  it('precompiles layout inheritance and refuses themes without sources', async () => {
    const compiler = engine();
    const source = await compiler.precompile([
      'page',
      'partials/card',
      'layouts/base',
      'layouts/section',
      'admin::users/index',
    ]);
    expect(source).toContain('nvParentLayout: "layouts/base.hbs"');
    const file = path.join(base, 'views.precompiled.mjs');
    await writeFile(file, source);
    const module = (await import(pathToFileURL(file).href)) as {
      default: Readonly<Record<string, object>>;
    };
    const production = new HbsEngine({
      root: path.join(base, 'missing'),
      namespaces: { admin: path.join(base, 'missing-admin') },
      themes: dirs().themes,
      precompiled: module.default,
      partials: { card: 'partials/card' },
    });
    await production.initialize();
    expect(
      await production.render(
        'admin::users/index',
        { title: 'P' },
        { layout: 'layouts/section' },
      ),
    ).toBe(
      '<html><body><section><h1>P</h1></section><aside></aside></body></html>',
    );
    await expect(
      production.render('page', {}, { theme: 'dark' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  });
});

describe('HBS development errors name the template and line', () => {
  beforeEach(async () => {
    await files({
      'views/parse.hbs': 'one\ntwo\n{{#if title}}\nnever closed',
      'views/missing-partial.hbs': 'a\n\nb {{> absent}}',
      'views/helper.hbs': 'x\n{{> row}}',
      'views/partials/row.hbs': 'first\nsecond {{explode 1}}',
      'views/missing-helper.hbs': '1\n2\n3\n{{nothere title}}',
      'views/builtin.hbs': '\n{{#with}}{{/with}}',
      'views/fine.hbs': '{{absentValue}}ok',
      'views/layouts/broken.hbs': '{{!< layouts/base}}\n\n{{explode 2}}',
      'views/layouts/base.hbs': '{{body}}',
    });
  });
  const create = (debug?: boolean) =>
    new HbsEngine({
      root: path.join(base, 'views'),
      ...(debug === undefined ? {} : { debug }),
      partials: { row: 'partials/row' },
      helpers: {
        explode: () => {
          throw new Error('helper exploded');
        },
      },
    });
  it.each([
    ['parse', 'parse.hbs:4'],
    ['missing-partial', 'missing-partial.hbs:3'],
    ['helper', 'partials/row.hbs:2'],
    ['missing-helper', 'missing-helper.hbs:4'],
    ['builtin', 'builtin.hbs:2'],
  ])('%s', async (view, location) => {
    const engine = create();
    await engine.initialize();
    const error = await engine
      .render(view, { title: 't' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ViewError);
    expect(error).toMatchObject({
      code: 'RENDER_FAILED',
      message: `Unable to render view: ${view} (${location})`,
      cause: expect.any(Error),
    });
  });
  it('locates failures inside layouts and keeps plain missing values empty', async () => {
    const engine = create();
    await engine.initialize();
    await expect(
      engine.render('fine', {}, { layout: 'layouts/broken' }),
    ).rejects.toThrow('Unable to render view: fine (layouts/broken.hbs:3)');
    expect(await engine.render('fine', {})).toBe('ok');
  });
  it('omits locations in production mode', async () => {
    const engine = create(false);
    await engine.initialize();
    await expect(engine.render('helper', {})).rejects.toThrow(
      /^Unable to render view: helper$/,
    );
  });
});

describe('EJS, Pug and Nunjucks namespaces and themes', () => {
  const cases: readonly {
    name: string;
    ext: string;
    page: string;
    partial: string;
    themed: string;
    create: (options: ReturnType<typeof dirs>) => ViewEngineAdapter;
  }[] = [
    {
      name: 'ejs',
      ext: 'ejs',
      page: '<h1><%= title %></h1><%- include("row") %>',
      partial: '<i>row</i>',
      themed: '<i>dark row</i>',
      create: (options) => new EjsEngine(options),
    },
    {
      name: 'pug',
      ext: 'pug',
      page: 'h1= title\ninclude row',
      partial: 'i row',
      themed: 'i dark row',
      create: (options) => new PugEngine(options),
    },
    {
      name: 'nunjucks',
      ext: 'njk',
      page: '<h1>{{ title }}</h1>{% include "admin::users/row.njk" %}',
      partial: '<i>row</i>',
      themed: '<i>dark row</i>',
      create: (options) => new NunjucksEngine(options),
    },
  ];
  it.each(cases)('$name', async (fixture) => {
    await files({
      [`admin/users/index.${fixture.ext}`]: fixture.page,
      [`admin/users/row.${fixture.ext}`]: fixture.partial,
      [`themes/dark/vendor/admin/users/row.${fixture.ext}`]: fixture.themed,
      [`views/home.${fixture.ext}`]: fixture.partial,
    });
    const engine = fixture.create(dirs());
    await engine.initialize();
    for (let round = 0; round < 2; round++) {
      expect(await engine.render('admin::users/index', { title: '<T>' })).toBe(
        '<h1>&lt;T&gt;</h1><i>row</i>',
      );
      expect(
        await engine.render(
          'admin::users/index',
          { title: 'D' },
          { theme: 'dark' },
        ),
      ).toBe('<h1>D</h1><i>dark row</i>');
    }
    await expect(engine.render('nope::x', {})).rejects.toMatchObject({
      code: 'INVALID_VIEW',
    });
    await expect(
      engine.render('home', {}, { theme: 'light' }),
    ).rejects.toMatchObject({ code: 'INVALID_VIEW' });
    await engine.dispose();
  });
});

@Controller('users')
class UsersController {
  @Get(':id')
  show(): void {}
  @Post()
  create(): void {}
  helper(): void {}
}
@Controller()
class HomeController {
  @Get()
  index(): void {}
}

describe('route link helpers', () => {
  const table = new RouteTable({
    'users.show': '/users/:id',
    'files.show': '/files/*path',
    'posts.list': '/posts{/:page}',
    home: '/',
  });
  it('encodes parameters per segment and moves the rest into the query', () => {
    expect(table.url('users.show', { id: 7 })).toBe('/users/7');
    expect(table.url('users.show', { id: 'a b/../c?d#e' })).toBe(
      '/users/a%20b%2F..%2Fc%3Fd%23e',
    );
    expect(
      table.url('users.show', { id: 1, tab: 'x&y', tags: ['a', 'b'] }),
    ).toBe('/users/1?tab=x%26y&tags=a&tags=b');
    expect(table.url('files.show', { path: ['docs', 'a b.txt'] })).toBe(
      '/files/docs/a%20b.txt',
    );
    expect(table.url('files.show', { path: 'docs/x' })).toBe('/files/docs/x');
    expect(table.url('posts.list')).toBe('/posts');
    expect(table.url('posts.list', { page: 2 })).toBe('/posts/2');
    expect(table.url('home')).toBe('/');
    expect(
      new RouteTable(
        { a: '/x/:id' },
        { base: '/app', origin: 'https://e.test/ignored' },
      ).url('a', { id: 1 }),
    ).toBe('https://e.test/app/x/1');
  });
  it('fails closed on unknown routes, missing or unsafe values and bad patterns', () => {
    expect(() => table.url('users.missing')).toThrow('Unknown route');
    expect(() => table.url('users.show')).toThrow('parameter id');
    for (const id of ['', '.', '..', { toString: () => 'x' }, Number.NaN])
      expect(() => table.url('users.show', { id: id as string })).toThrow(
        ViewError,
      );
    expect(() => table.url('files.show', { path: 'a/../b' })).toThrow(
      ViewError,
    );
    expect(() =>
      table.url('users.show', { id: 1, q: { a: 1 } as never }),
    ).toThrow('query parameter');
    for (const pattern of [
      'users',
      '/a/(.*)',
      '/a/:id?',
      '/a/{/:b{/:c}}',
      '/a/:',
      '/a\\b',
    ])
      expect(() => new RouteTable({ x: pattern }), pattern).toThrow(ViewError);
    expect(
      () => new RouteTable({ x: '/x' }, { origin: 'javascript:alert(1)' }),
    ).toThrow('http(s)');
    expect(
      () => new RouteTable({ x: '/x' }, { base: '//evil.test' }),
    ).toThrow();
  });
  it('reads Nest controller metadata into named routes', () => {
    expect(
      routesFromControllers([UsersController, HomeController], {
        prefix: 'api',
      }),
    ).toEqual({
      'UsersController.show': '/api/users/:id',
      'UsersController.create': '/api/users',
      'HomeController.index': '/api',
    });
    expect(
      routesFromControllers([UsersController], {
        name: (controller, method) =>
          `${controller.replace('Controller', '').toLowerCase()}.${method}`,
      }),
    ).toMatchObject({ 'users.show': '/users/:id' });
    class Plain {}
    expect(() => routesFromControllers([Plain])).toThrow(
      'not a Nest controller',
    );
  });
  it('exposes route() to HBS hash arguments, EJS objects and Nunjucks keywords', async () => {
    await files({
      'views/link.hbs':
        '<a href="{{route "users.show" id=user.id tab="a&b"}}">x</a>',
      'views/link.ejs':
        '<a href="<%= route("users.show", { id: user.id }) %>">x</a>',
      'views/link.njk': '<a href="{{ route("users.show", id=user.id) }}">x</a>',
    });
    const helpers = routeHelpers(table);
    const root = path.join(base, 'views');
    const user = { id: '"><script>' };
    expect(
      await new HbsEngine({ root, helpers }).render('link', { user }),
    ).toBe('<a href="/users/%22%3E%3Cscript%3E?tab&#x3D;a%26b">x</a>');
    expect(
      await new EjsEngine({ root, helpers }).render('link', { user }),
    ).toBe('<a href="/users/%22%3E%3Cscript%3E">x</a>');
    expect(
      await new NunjucksEngine({ root, helpers }).render('link', { user }),
    ).toBe('<a href="/users/%22%3E%3Cscript%3E">x</a>');
    expect(helperArguments(['a', { __keywords: true, b: 1 }])).toEqual({
      positional: ['a'],
      named: { b: 1 },
    });
  });
});

describe('page metadata, permission and asset helpers', () => {
  it('renders escaped title and meta tags and rejects unsafe canonical URLs', async () => {
    await files({
      'views/head.hbs':
        '<head>{{metaTags meta}}</head><h1>{{pageTitle meta}}</h1>',
      'views/head.ejs': '<head><%= metaTags(meta) %></head>',
    });
    const helpers = pageMetaHelpers({
      titleTemplate: '%s · Site',
      defaultTitle: 'Site',
    });
    const root = path.join(base, 'views');
    const meta = {
      title: '<Docs> & "more"',
      description: 'A "quoted" <description>',
      canonical: 'https://example.test/docs?a=1&b=2',
      robots: 'noindex',
      openGraph: { type: 'article' },
      meta: { 'twitter:card': 'summary' },
    };
    const html = await new HbsEngine({ root, helpers }).render('head', {
      meta,
    });
    expect(html).toBe(
      '<head><title>&lt;Docs&gt; &amp; &quot;more&quot; · Site</title>' +
        '<meta name="description" content="A &quot;quoted&quot; &lt;description&gt;">' +
        '<link rel="canonical" href="https://example.test/docs?a=1&amp;b=2">' +
        '<meta name="robots" content="noindex">' +
        '<meta property="og:type" content="article">' +
        '<meta name="twitter:card" content="summary"></head>' +
        '<h1>&lt;Docs&gt; &amp; &quot;more&quot; · Site</h1>',
    );
    expect(
      await new EjsEngine({ root, helpers }).render('head', { meta: {} }),
    ).toBe('<head><title>Site</title></head>');
    for (const bad of [
      { canonical: 'javascript:alert(1)' },
      { canonical: '//evil.test/x' },
      { meta: { 'bad name': 'x' } },
      { title: 42 },
    ])
      await expect(
        new HbsEngine({ root, helpers }).render('head', { meta: bad }),
      ).rejects.toMatchObject({ code: 'RENDER_FAILED' });
    expect(() => pageMetaHelpers({ titleTemplate: 'no placeholder' })).toThrow(
      ViewError,
    );
  });
  it('delegates can/cannot to the host policy and fails closed', async () => {
    await files({
      'views/perm.hbs':
        '{{#if (can "posts.edit" post)}}edit{{/if}}|{{#if (cannot "posts.delete" post)}}no-delete{{/if}}|{{#if (can "boom")}}boom{{/if}}|{{#if (can "truthy")}}truthy{{/if}}|{{#if (can "<bad>")}}bad{{/if}}',
      'views/perm.njk': '{% if can("posts.edit", post) %}edit{% endif %}',
    });
    const calls: unknown[] = [];
    const helpers = permissionHelpers((ability, subject) => {
      calls.push([ability, subject]);
      if (ability === 'boom') throw new Error('policy failure');
      if (ability === 'truthy') return 'yes' as unknown as boolean;
      return (
        ability === 'posts.edit' &&
        (subject as { owner: string }).owner === 'me'
      );
    });
    const root = path.join(base, 'views');
    const hbs = new HbsEngine({ root });
    expect(
      await hbs.render('perm', { post: { owner: 'me' } }, { helpers }),
    ).toBe('edit|no-delete|||');
    expect(
      await hbs.render('perm', { post: { owner: 'you' } }, { helpers }),
    ).toBe('|no-delete|||');
    expect(calls).not.toContainEqual(['<bad>', undefined]);
    expect(
      await new NunjucksEngine({ root }).render(
        'perm',
        { post: { owner: 'me' } },
        { helpers },
      ),
    ).toBe('edit');
    const granted = grantPermissions(
      (ability, subject) => ability === 'posts.edit' && subject === 1,
      { canEdit: ['posts.edit', 1], canDelete: ['posts.delete', 1] },
    );
    expect(granted).toEqual({ canEdit: true, canDelete: false });
    expect(
      grantPermissions(() => {
        throw new Error('x');
      }, ['a', '__proto__']),
    ).toEqual({ a: false });
  });
  it('emits asset tags from a manifest provider, including ViteAssets', async () => {
    await files({
      'views/assets.hbs': '<head>{{assetTags "app" nonce=nonce}}</head>',
      'views/assets.ejs': '<head><%= assetTags("app") %></head>',
    });
    const root = path.join(base, 'views');
    const vite = new ViteAssets({
      mode: 'development',
      apps: { app: { entries: ['client/main.ts'] } },
    });
    const nonce = 'abcdefghijklmnopqrstuv==';
    const hbs = new HbsEngine({ root, helpers: assetHelpers(vite) });
    const html = await hbs.render('assets', { nonce });
    expect(html).toContain(
      '<script type="module" src="/@vite/client" nonce="abcdefghijklmnopqrstuv=="></script>',
    );
    expect(html).toContain('src="/client/main.ts"');
    await expect(
      hbs.render('assets', { nonce: '"><script>' }),
    ).rejects.toMatchObject({ code: 'RENDER_FAILED' });
    const provider = {
      tags: (name: string, options?: { nonce?: string }) =>
        `<link rel="stylesheet" href="/${name}.css" data-nonce="${options?.nonce ?? ''}">`,
    };
    expect(
      await new EjsEngine({ root, helpers: assetHelpers(provider) }).render(
        'assets',
        {},
      ),
    ).toBe(
      '<head><link rel="stylesheet" href="/app.css" data-nonce=""></head>',
    );
    expect(() => assetHelpers({} as never)).toThrow(ViewError);
  });
});
