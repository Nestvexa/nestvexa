import 'reflect-metadata';
import { Controller, Delete, Get, Module, Post } from '@nestjs/common';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import {
  NestvexaError,
  RouteName,
  buildPath,
  collectRoutes,
  generateRouteModule,
  moduleControllers,
} from '../packages/core/dist/index.js';

@Controller('admin/users')
class UsersController {
  @Get()
  index(): void {}
  @Get(':id')
  show(): void {}
  @Post(':id/avatar')
  @RouteName('users.avatar')
  upload(): void {}
  @Delete(':id')
  remove(): void {}
  helper(): void {}
}
@Controller()
class FilesController {
  @Get('files/*path')
  download(): void {}
  @Get('reports{/:year}')
  reports(): void {}
}
@Module({ controllers: [FilesController] })
class FilesModule {}
@Module({
  imports: [
    FilesModule,
    { module: class Dynamic {}, controllers: [UsersController] },
  ],
})
class AppModule {}

const directories: string[] = [];
afterAll(async () => {
  for (const directory of directories)
    await rm(directory, { recursive: true, force: true });
});

describe('collectRoutes', () => {
  it('reads Nest controller metadata without starting the application', () => {
    const routes = collectRoutes(moduleControllers(AppModule), {
      globalPrefix: '/api/',
    });
    expect(
      routes.map((route) => [route.name, route.method, route.path]),
    ).toEqual([
      ['files.download', 'GET', '/api/files/*path'],
      ['files.reports', 'GET', '/api/reports{/:year}'],
      ['users.index', 'GET', '/api/admin/users'],
      ['users.show', 'GET', '/api/admin/users/:id'],
      ['users.avatar', 'POST', '/api/admin/users/:id/avatar'],
      ['users.remove', 'DELETE', '/api/admin/users/:id'],
    ]);
    expect(routes[0]?.params).toEqual([
      { name: 'path', wildcard: true, optional: false },
    ]);
    expect(routes[1]?.params).toEqual([
      { name: 'year', wildcard: false, optional: true },
    ]);
  });
  it('rejects duplicate names and invalid custom names', () => {
    @Controller('a')
    class DupController {
      @Get('x')
      @RouteName('dup.same')
      first(): void {}
      @Get('y')
      @RouteName('dup.same')
      second(): void {}
    }
    expect(() => collectRoutes([DupController])).toThrow(NestvexaError);
    expect(() => RouteName('Bad Name')).toThrow(NestvexaError);
  });
});

describe('buildPath', () => {
  it('percent-encodes values so they can never add segments, queries or hosts', () => {
    expect(buildPath('/admin/users/:id', { id: '../../x?y=1#z' })).toBe(
      '/admin/users/..%2F..%2Fx%3Fy%3D1%23z',
    );
    expect(buildPath('/files/*path', { path: ['a b', 'c/d'] })).toBe(
      '/files/a%20b/c%2Fd',
    );
    expect(buildPath('/reports{/:year}')).toBe('/reports');
    expect(buildPath('/reports{/:year}', { year: 2026 })).toBe('/reports/2026');
    expect(
      buildPath('/admin/users', {}, { q: 'a&b', page: 2, skip: undefined }),
    ).toBe('/admin/users?page=2&q=a%26b');
  });
  it('rejects missing, unknown and non-primitive parameters', () => {
    expect(() => buildPath('/users/:id')).toThrow(/Missing/);
    expect(() => buildPath('/users/:id', { id: 1, extra: 2 })).toThrow(
      /Unknown/,
    );
    expect(() =>
      buildPath('/users/:id', { id: { toString: () => 'x' } }),
    ).toThrow(/Invalid/);
    expect(() => buildPath('/users/:id', { id: Number.NaN })).toThrow(
      /Invalid/,
    );
  });
});

describe('generateRouteModule', () => {
  const source = generateRouteModule(
    collectRoutes(moduleControllers(AppModule)),
  );
  it('emits a standalone module whose route() builds encoded URLs', async () => {
    expect(source).not.toMatch(/^import /m);
    const output = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const directory = await mkdtemp(join(tmpdir(), 'nestvexa-routes-'));
    directories.push(directory);
    const file = join(directory, 'routes.mjs');
    await writeFile(file, output);
    const generated = (await import(pathToFileURL(file).href)) as {
      route: (name: string, params?: object, query?: object) => string;
      routes: Record<string, { method: string; path: string }>;
    };
    expect(generated.route('users.show', { id: 'a/b' })).toBe(
      '/admin/users/a%2Fb',
    );
    expect(generated.route('users.index', {}, { page: 3 })).toBe(
      '/admin/users?page=3',
    );
    expect(generated.route('files.download', { path: ['x', 'y z'] })).toBe(
      '/files/x/y%20z',
    );
    expect(generated.route('files.reports')).toBe('/reports');
    expect(generated.routes['users.avatar']).toEqual({
      method: 'POST',
      path: '/admin/users/:id/avatar',
    });
    expect(() => generated.route('users.show', {})).toThrow(/Missing/);
  });
  it('type-checks names and parameters at compile time', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nestvexa-routes-types-'));
    directories.push(directory);
    await writeFile(join(directory, 'routes.ts'), source);
    await writeFile(
      join(directory, 'usage.ts'),
      [
        "import { route } from './routes.js';",
        "route('users.show', { id: 1 });",
        "route('users.index');",
        "route('files.reports');",
        "route('files.reports', { year: 2026 });",
        '// @ts-expect-error unknown route name',
        "route('users.missing');",
        '// @ts-expect-error required parameter',
        "route('users.show');",
        '// @ts-expect-error wrong parameter name',
        "route('users.show', { userId: 1 });",
      ].join('\n'),
    );
    const program = ts.createProgram([join(directory, 'usage.ts')], {
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
      noEmit: true,
      types: [],
    });
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      );
    expect(diagnostics).toEqual([]);
    // Creating a TypeScript program is slow on shared CI hosts.
  }, 90_000);
});
