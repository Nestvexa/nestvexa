import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DynamicModule, INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pinned, run } from '../packages/cli/dist/index.js';
import {
  freshApp,
  json,
  node,
  ok,
  read,
  repo,
  tsc,
} from './support/cli-fixture.js';

/**
 * EXT-027 / DX-016: `make:resource` generates Zod DTOs, a repository
 * interface with a selectable implementation (in-memory or TypeORM), the
 * service, a validated REST controller, the Live table and tests. The
 * generated app compiles under strict TypeScript, its generated tests pass,
 * and the TypeORM variant serves CRUD against a real database (sql.js).
 */
describe('make:resource --crud --orm', { timeout: 600_000 }, () => {
  let root = '';
  let app: INestApplication | undefined;
  beforeAll(() => {
    root = freshApp('resource-app', { directory: 'cli-resource' });
    ok(run(['init'], root));
  }, 120_000);
  afterAll(async () => {
    await app?.close();
  });

  it('generates DTOs, repositories, service, controller, Live table and tests', () => {
    expect(
      run(['make:resource', 'Order', '--orm', 'prisma'], root).exitCode,
    ).toBe(2);
    ok(run(['make:resource', 'Task', '--crud'], root));
    const typeorm = json(
      run(
        ['make:resource', 'Invoice', '--crud', '--orm', 'typeorm', '--json'],
        root,
      ),
    );
    expect(typeorm.ok).toBe(true);
    expect(typeorm.messages?.join('\n')).toContain(
      'No schema migration was generated',
    );
    expect(typeorm.changes).toEqual(
      expect.arrayContaining([
        'create src/invoice/invoice.dto.ts',
        'create src/invoice/invoice.repository.ts',
        'create src/invoice/invoice.memory-repository.ts',
        'create src/invoice/invoice.typeorm-repository.ts',
        'create src/invoice/invoice.entity.ts',
        'create src/invoice/invoice.service.ts',
        'create src/invoice/invoice.controller.ts',
        'create src/invoice/invoice-table.component.ts',
        'create views/components/invoice-table.hbs',
        'create src/invoice/invoice.dto.spec.ts',
        'create src/invoice/invoice.service.spec.ts',
        'create src/invoice/invoice.controller.spec.ts',
      ]),
    );
    ok(run(['make:resource', 'Note'], root));
    // Re-running a generator with identical output changes nothing.
    expect(
      json(
        run(
          ['make:resource', 'Invoice', '--crud', '--orm', 'typeorm', '--json'],
          root,
        ),
      ),
    ).toMatchObject({ ok: true, changes: [] });
    const pkg = JSON.parse(read(root, 'package.json')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.dependencies).toMatchObject({
      typeorm: pinned.typeorm,
      '@nestjs/typeorm': pinned['@nestjs/typeorm'],
      zod: pinned.zod,
      '@nestvexa/forms': '^0.1.0-alpha.0',
    });
    expect(pkg.devDependencies).toMatchObject({
      vitest: pinned.vitest,
      '@nestjs/testing': pinned['@nestjs/testing'],
    });
    expect(read(root, 'src/invoice/invoice.module.ts')).toContain(
      'imports: [TypeOrmModule.forFeature([InvoiceEntity])]',
    );
    expect(read(root, 'src/task/task.module.ts')).toContain(
      'useClass: MemoryTaskRepository',
    );
    expect(read(root, 'src/note/note.module.ts')).not.toContain('controllers');
    const config = read(root, 'src/nestvexa/nestvexa.config.ts');
    expect(config).toContain(
      "'invoice-table': ['$mount', '$sync', 'create', 'previous', 'next'],",
    );
    const module = read(root, 'src/app.module.ts');
    expect(module).toContain('TaskModule');
    expect(module).toContain('InvoiceModule');
    expect(module).not.toContain('NoteModule');
  });

  it('compiles under strict TypeScript and passes its generated tests', () => {
    const compiled = tsc(root);
    expect(compiled.status, compiled.output).toBe(0);
    writeFileSync(
      join(root, 'vitest.config.mjs'),
      "export default { test: { include: ['dist/src/**/*.spec.js'] } };\n",
    );
    const result = node(
      [
        join(repo, 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        '--root',
        root,
        '--config',
        'vitest.config.mjs',
        '--reporter',
        'dot',
        '--no-color',
      ],
      root,
    );
    expect(result.status, result.output).toBe(0);
    // Task and Invoice: DTO, service and HTTP tests; Note: DTO and service.
    expect(result.output).toMatch(/Test Files\s+8 passed/);
  });

  it('serves validated CRUD through the TypeORM repository on a real database', async () => {
    const load = async <T>(path: string, name: string): Promise<T> => {
      const module = (await import(
        pathToFileURL(join(root, 'dist', path)).href
      )) as Record<string, unknown>;
      return module[name] as T;
    };
    const InvoiceModule = await load<Type>(
      'src/invoice/invoice.module.js',
      'InvoiceModule',
    );
    // The application owns the DataSource; the test uses an in-memory SQLite (sql.js).
    const database: DynamicModule = TypeOrmModule.forRoot({
      type: 'sqljs',
      autoLoadEntities: true,
      synchronize: true,
      logging: false,
    });
    const moduleRef = await Test.createTestingModule({
      imports: [database, InvoiceModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    const url = `${await app.getUrl()}/invoice`;
    const send = async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return {
        status: response.status,
        body: text ? (JSON.parse(text) as unknown) : undefined,
      };
    };
    expect(await send('', 'POST', { name: 'A' })).toMatchObject({
      status: 400,
      body: { errors: { name: ['Enter at least 2 characters.'] } },
    });
    expect((await send('', 'POST', { name: 'Ada', id: 99 })).status).toBe(400);
    const created = await send('', 'POST', { name: '  Ada Lovelace  ' });
    expect(created).toMatchObject({
      status: 201,
      body: { name: 'Ada Lovelace' },
    });
    const id = (created.body as { id: number }).id;
    for (const name of ['Grace Hopper', 'Alan Turing', 'Adele Goldberg'])
      expect((await send('', 'POST', { name })).status).toBe(201);
    expect(await send('?q=ad&size=1&page=2')).toEqual({
      status: 200,
      body: {
        items: [{ id: 4, name: 'Adele Goldberg' }],
        total: 2,
        page: 2,
        size: 1,
      },
    });
    // Search values are bound parameters.
    expect(await send(`?q=${encodeURIComponent("' OR 1=1 --")}`)).toMatchObject(
      {
        body: { total: 0, items: [] },
      },
    );
    expect((await send('?size=101')).status).toBe(400);
    expect((await send('?page=x')).status).toBe(400);
    expect(await send(`/${id}`, 'PATCH', { name: 'Ada King' })).toEqual({
      status: 200,
      body: { id, name: 'Ada King' },
    });
    expect((await send(`/${id}`, 'PATCH', { name: 'x' })).status).toBe(400);
    expect(await send(`/${id}`)).toEqual({
      status: 200,
      body: { id, name: 'Ada King' },
    });
    expect((await send(`/${id}`, 'DELETE')).status).toBe(204);
    expect((await send(`/${id}`)).status).toBe(404);
    expect((await send(`/${id}`, 'DELETE')).status).toBe(404);
    expect((await send(`/${id}`, 'PATCH', { name: 'Again' })).status).toBe(404);
    expect((await send('/not-a-number')).status).toBe(400);
  });
});
