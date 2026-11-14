import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../packages/cli/dist/index.js';
import {
  boot,
  freshApp,
  json,
  node,
  ok,
  read,
  tsc,
} from './support/cli-fixture.js';
import type { BootedApp } from './support/cli-fixture.js';

// Extensions/CLI round 4 port range 3970-3979.
const port = 3970;

const shapesController = `import { Controller, Delete, Get, Param, Post } from '@nestjs/common';

@Controller({ path: 'shapes' })
export class ShapesController {
  @Get(':id')
  show(@Param('id') id: string) {
    return { id };
  }
  @Get('docs{/:section}')
  docs() {
    return {};
  }
  @Get('files/*path')
  file() {
    return {};
  }
  @Post()
  create() {
    return {};
  }
  @Delete(':id')
  remove() {
    return {};
  }
  @Get(['first', 'second'])
  aliases() {
    return {};
  }
}
`;
/** Statically visible but not registered: Express 5 would refuse the pattern at boot. */
const legacyController = `import { Controller, Get } from '@nestjs/common';

@Controller('legacy')
export class LegacyController {
  @Get('(old)')
  old() {
    return {};
  }
}
`;
/** Must compile: correct names, parameters and query values. */
const usage = `import { isRouteName, route, routeLink } from './nestvexa/routes.js';

export const links = [
  route('HomeController.index'),
  route('HomeController.index', { page: 2, tags: ['a', 'b'] }),
  route('ShapesController.show', { id: 7 }),
  route('ShapesController.docs'),
  route('ShapesController.file', { path: ['a b', 'c'] }),
  routeLink('ShapesController.remove', { id: 'x' }).method,
];
export const known: boolean = isRouteName('ShapesController.show');
`;
/** Every line must be a type error. */
const misuse = `import { route, routeLink } from './nestvexa/routes.js';

// @ts-expect-error: unknown route name
route('ShapesController.missing');
// @ts-expect-error: the id parameter is required
route('ShapesController.show');
// @ts-expect-error: path parameters are strings or numbers
route('ShapesController.show', { id: {} });
// @ts-expect-error: the method of a DELETE route is 'delete'
export const method: 'get' = routeLink('ShapesController.remove', { id: 1 }).method;
`;
const reactPage = `import { Link } from '@inertiajs/react';
import { routeLink } from '../../../src/nestvexa/routes';

export default function Links() {
  return (
    <nav>
      <Link {...routeLink('ShapesController.show', { id: 3 })}>Shape</Link>
      <Link {...routeLink('ShapesController.remove', { id: 3 })} as="button">
        Delete
      </Link>
    </nav>
  );
}
`;
const vuePage = `<script setup lang="ts">
import { Link } from '@inertiajs/vue3';
import { routeLink } from '../../../src/nestvexa/routes';

const shape = routeLink('ShapesController.show', { id: 3 });
</script>

<template>
  <Link v-bind="shape">Shape</Link>
</template>
`;
const sveltePage = `<script lang="ts">
  import { Link } from '@inertiajs/svelte';
  import { routeLink } from '../../../src/nestvexa/routes';

  const shape = routeLink('ShapesController.show', { id: 3 });
</script>

<Link {...shape}>Shape</Link>
`;

describe('nestvexa routes:types', { timeout: 900_000 }, () => {
  let root = '';
  let app: BootedApp | undefined;
  beforeAll(() => {
    root = freshApp('routes-app', { directory: 'cli-routes' });
    ok(run(['init'], root));
    ok(run(['make:page', 'Home'], root));
    for (const framework of ['react', 'vue', 'svelte'])
      ok(run(['add', framework], root));
    writeFileSync(
      join(root, 'src/pages/shapes.controller.ts'),
      shapesController,
    );
    writeFileSync(
      join(root, 'src/pages/legacy.controller.ts'),
      legacyController,
    );
    writeFileSync(
      join(root, 'src/app.module.ts'),
      read(root, 'src/app.module.ts')
        .replace(
          "import { Module } from '@nestjs/common';",
          "import { Module } from '@nestjs/common';\nimport { ShapesController } from './pages/shapes.controller.js';",
        )
        .replace(
          'controllers: [AppController',
          'controllers: [ShapesController, AppController',
        ),
    );
  }, 120_000);
  afterAll(() => app?.stop());

  it('generates the typed map, skips irreversible patterns and wires the view helper once', () => {
    const dry = run(['routes:types', '--dry-run'], root);
    ok(dry);
    expect(dry.stdout.join('\n')).toContain('create src/nestvexa/routes.ts');
    expect(run(['routes:types', '--check'], root).exitCode).toBe(1);
    const result = json(run(['routes:types', '--json'], root));
    expect(result.ok).toBe(true);
    expect(result.messages?.join('\n')).toContain(
      'Skipped LegacyController.old (/legacy/(old))',
    );
    const map = read(root, 'src/nestvexa/routes.ts');
    expect(map).toContain(
      "'ShapesController.show': { method: 'GET', path: '/shapes/:id' },",
    );
    expect(map).toContain(
      "'ShapesController.aliases': { method: 'GET', path: '/shapes/first' },",
    );
    expect(map).toContain(
      "'ShapesController.docs': { readonly section?: RouteValue };",
    );
    expect(map).toContain(
      "'ShapesController.file': { readonly path: RouteValue | readonly RouteValue[] };",
    );
    expect(map).toContain("'HomeController.index': Record<never, never>;");
    expect(map).not.toContain('LegacyController');
    const main = read(root, 'src/main.ts');
    expect(main.match(/configureRouteHelpers\(app\);/g)).toHaveLength(1);
    expect(main.indexOf('configureRouteHelpers(app)')).toBeLessThan(
      main.indexOf('await configureNestvexa(app)'),
    );
    // Up to date, idempotent.
    ok(run(['routes:types', '--check'], root));
    expect(json(run(['routes:types', '--json'], root))).toMatchObject({
      ok: true,
      changes: [],
    });
    expect(json(run(['inspect:routes', '--json'], root)).data).toEqual(
      expect.arrayContaining([
        {
          method: 'DELETE',
          path: '/shapes/:id',
          handler: 'ShapesController.remove',
          file: 'src/pages/shapes.controller.ts',
        },
      ]),
    );
  });

  it('type-checks route names, parameters and the Inertia link helpers of every framework', () => {
    writeFileSync(join(root, 'src/route-usage.ts'), usage);
    writeFileSync(join(root, 'src/route-misuse.ts'), misuse);
    const server = tsc(root);
    expect(server.status, server.output).toBe(0);
    for (const [framework, file, content] of [
      ['react', 'Links.tsx', reactPage],
      ['vue', 'Links.vue', vuePage],
      ['svelte', 'Links.svelte', sveltePage],
    ] as const) {
      mkdirSync(join(root, 'client', framework, 'pages'), { recursive: true });
      writeFileSync(join(root, 'client', framework, 'pages', file), content);
    }
    const react = tsc(root, 'client/react/tsconfig.json');
    expect(react.status, react.output).toBe(0);
    const vue = node(
      [
        join(root, 'node_modules/vue-tsc/bin/vue-tsc.js'),
        '-p',
        'client/vue/tsconfig.json',
      ],
      root,
    );
    expect(vue.status, vue.output).toBe(0);
    const svelte = node(
      [
        join(root, 'node_modules/svelte-check/bin/svelte-check'),
        '--tsconfig',
        'client/svelte/tsconfig.json',
        '--fail-on-warnings',
        '--output',
        'machine',
      ],
      root,
    );
    expect(svelte.status, svelte.output).toBe(0);
  });

  it('builds the same URLs as RouteTable and refuses unsafe or missing parameters', async () => {
    const routes = (await import(
      pathToFileURL(join(root, 'dist/src/nestvexa/routes.js')).href
    )) as {
      route: (name: string, params?: Record<string, unknown>) => string;
      routeLink: (
        name: string,
        params?: Record<string, unknown>,
      ) => { href: string; method: string };
      isRouteName: (name: string) => boolean;
    };
    const helpers = (await import(
      pathToFileURL(join(root, 'dist/src/nestvexa/route-helpers.js')).href
    )) as { routeTable: { url(name: string, params?: object): string } };
    const cases: [string, Record<string, unknown>?][] = [
      ['HomeController.index'],
      ['HomeController.index', { page: 2, tags: ['a', 'b'], empty: null }],
      ['ShapesController.show', { id: 'a/b?c#d' }],
      ['ShapesController.docs'],
      ['ShapesController.docs', { section: 'intro' }],
      ['ShapesController.file', { path: ['a b', 'c'] }],
      ['ShapesController.file', { path: 'x/y' }],
    ];
    for (const [name, params] of cases)
      expect(routes.route(name, params), name).toBe(
        helpers.routeTable.url(name, params),
      );
    expect(routes.route('ShapesController.show', { id: 'a/b?c#d' })).toBe(
      '/shapes/a%2Fb%3Fc%23d',
    );
    expect(routes.route('ShapesController.file', { path: 'x/y' })).toBe(
      '/shapes/files/x/y',
    );
    expect(routes.route('ShapesController.docs', { section: 'intro' })).toBe(
      '/shapes/docs/intro',
    );
    expect(routes.routeLink('ShapesController.remove', { id: 1 })).toEqual({
      href: '/shapes/1',
      method: 'delete',
    });
    expect(() => routes.route('ShapesController.show')).toThrow(TypeError);
    expect(() => routes.route('ShapesController.show', { id: '..' })).toThrow(
      /parameter id/,
    );
    expect(() => routes.route('ShapesController.missing')).toThrow(
      'Unknown route: ShapesController.missing',
    );
    expect(() => routes.route('__proto__')).toThrow('Unknown route');
    expect(() =>
      routes.route('HomeController.index', { q: { nested: true } }),
    ).toThrow(/query parameter q/);
    expect(routes.isRouteName('toString')).toBe(false);
  });

  it('renders {{route}} links in Handlebars views of the running app', async () => {
    writeFileSync(
      join(root, 'views/pages/home.hbs'),
      '<h1>{{title}}</h1>\n<a id="shape" href="{{route "ShapesController.show" id="a b"}}">Shape</a>\n<a id="list" href="{{route "HomeController.index" page=2}}">Home</a>\n',
    );
    app = await boot(root, port);
    const html = await (await fetch(`${app.origin}/home`)).text();
    expect(html).toContain('<a id="shape" href="/shapes/a%20b">Shape</a>');
    // Handlebars may escape "=" in attribute values.
    expect(html).toMatch(
      /<a id="list" href="\/home\?page(=|&#x3D;)2">Home<\/a>/,
    );
    // The rendered link is a real route of the app.
    expect((await fetch(`${app.origin}/shapes/a%20b`)).status).toBe(200);
  });

  it('reports a stale map after a route changes', () => {
    writeFileSync(
      join(root, 'src/pages/shapes.controller.ts'),
      shapesController.replace("@Get(':id')", "@Get('by-id/:id')"),
    );
    const stale = run(['routes:types', '--check'], root);
    expect(stale.exitCode).toBe(1);
    expect(stale.stdout.join('\n')).toContain('is out of date');
    ok(run(['routes:types'], root));
    expect(read(root, 'src/nestvexa/routes.ts')).toContain(
      "path: '/shapes/by-id/:id'",
    );
  });
});
