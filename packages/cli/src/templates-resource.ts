import type { Names } from './context.js';
import type { TestRunner } from './templates-app.js';

/**
 * `make:resource` templates: Zod DTOs shared by REST and Live, a repository
 * interface with a selectable implementation (`--orm memory|typeorm`), the
 * service, module, REST controller (`--crud`), Live table and generated tests.
 */
export const resourceOrms = ['memory', 'typeorm'] as const;
export type ResourceOrm = (typeof resourceOrms)[number];
export interface ResourceOptions {
  readonly esm: boolean;
  readonly orm: ResourceOrm;
  readonly crud: boolean;
  readonly runner: TestRunner;
  readonly platform: 'express' | 'fastify';
}
const token = (n: Names) =>
  `${n.kebab.toUpperCase().replaceAll('-', '_')}_REPOSITORY`;
const ext = (options: ResourceOptions) => (options.esm ? '.js' : '');
function testImports(runner: TestRunner): string {
  return runner === 'vitest'
    ? "import { describe, expect, it } from 'vitest';"
    : "import { describe, expect, it } from '@jest/globals';";
}

export function resourceDto(n: Names): string {
  return `import { zodAdapter } from '@nestvexa/forms';
import { z } from 'zod';

/**
 * Input rules shared by the REST controller and the Live table. The server
 * always validates; unknown keys are rejected.
 */
export const create${n.pascal}Schema = z.strictObject({
  name: z.string().trim().min(2, 'Enter at least 2 characters.').max(80, 'Use at most 80 characters.'),
});
export const update${n.pascal}Schema = create${n.pascal}Schema.partial();
/** List query: optional search, 1-based page, bounded page size. */
export const ${n.camel}QuerySchema = z.strictObject({
  q: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
});

export type Create${n.pascal}Dto = z.infer<typeof create${n.pascal}Schema>;
export type Update${n.pascal}Dto = z.infer<typeof update${n.pascal}Schema>;
export type ${n.pascal}Query = z.infer<typeof ${n.camel}QuerySchema>;

export const create${n.pascal}Adapter = zodAdapter(create${n.pascal}Schema);
export const update${n.pascal}Adapter = zodAdapter(update${n.pascal}Schema);
export const ${n.camel}QueryAdapter = zodAdapter(${n.camel}QuerySchema);
`;
}
export function resourceRepository(n: Names, options: ResourceOptions): string {
  return `import type { Create${n.pascal}Dto, ${n.pascal}Query, Update${n.pascal}Dto } from './${n.kebab}.dto${ext(options)}';

export interface ${n.pascal} {
  readonly id: number;
  readonly name: string;
}
export interface ${n.pascal}Page {
  readonly items: readonly ${n.pascal}[];
  readonly total: number;
  readonly page: number;
  readonly size: number;
}

/**
 * Data access of ${n.pascal}Service. \`${n.pascal}Module\` binds the implementation
 * chosen with \`make:resource --orm\`; tests use the in-memory one.
 */
export interface ${n.pascal}Repository {
  list(query: ${n.pascal}Query): Promise<${n.pascal}Page>;
  find(id: number): Promise<${n.pascal} | undefined>;
  create(input: Create${n.pascal}Dto): Promise<${n.pascal}>;
  /** Undefined when the record does not exist. */
  update(id: number, input: Update${n.pascal}Dto): Promise<${n.pascal} | undefined>;
  /** False when the record does not exist. */
  remove(id: number): Promise<boolean>;
}
export const ${token(n)} = Symbol('${n.pascal}Repository');
`;
}
export function resourceMemoryRepository(
  n: Names,
  options: ResourceOptions,
): string {
  return `import { Injectable } from '@nestjs/common';
import type { Create${n.pascal}Dto, ${n.pascal}Query, Update${n.pascal}Dto } from './${n.kebab}.dto${ext(options)}';
import type { ${n.pascal}, ${n.pascal}Page, ${n.pascal}Repository } from './${n.kebab}.repository${ext(options)}';

/** In-process ${n.pascal}Repository: one list per application process, lost on restart. */
@Injectable()
export class Memory${n.pascal}Repository implements ${n.pascal}Repository {
  #items: ${n.pascal}[] = [];
  #next = 1;
  async list({ q, page, size }: ${n.pascal}Query): Promise<${n.pascal}Page> {
    const needle = q?.toLowerCase();
    const matches = needle ? this.#items.filter((item) => item.name.toLowerCase().includes(needle)) : this.#items;
    return { items: matches.slice((page - 1) * size, page * size), total: matches.length, page, size };
  }
  async find(id: number): Promise<${n.pascal} | undefined> {
    return this.#items.find((item) => item.id === id);
  }
  async create(input: Create${n.pascal}Dto): Promise<${n.pascal}> {
    const item = { id: this.#next++, name: input.name };
    this.#items = [...this.#items, item];
    return item;
  }
  async update(id: number, input: Update${n.pascal}Dto): Promise<${n.pascal} | undefined> {
    const current = await this.find(id);
    if (!current) return undefined;
    const item = { ...current, ...(input.name === undefined ? {} : { name: input.name }) };
    this.#items = this.#items.map((entry) => (entry.id === id ? item : entry));
    return item;
  }
  async remove(id: number): Promise<boolean> {
    const before = this.#items.length;
    this.#items = this.#items.filter((item) => item.id !== id);
    return this.#items.length !== before;
  }
}
`;
}
export function resourceEntity(n: Names): string {
  return `import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * TypeORM entity of ${n.pascal}. No migration is generated: create one with the
 * TypeORM CLI (\`typeorm migration:generate\`) and review it before running it.
 */
@Entity('${n.kebab.replaceAll('-', '_')}')
export class ${n.pascal}Entity {
  // Assigned by TypeORM when a row is loaded or inserted.
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 80 })
  name!: string;
}
`;
}
export function resourceTypeOrmRepository(
  n: Names,
  options: ResourceOptions,
): string {
  return `import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Like } from 'typeorm';
import type { Repository } from 'typeorm';
import type { Create${n.pascal}Dto, ${n.pascal}Query, Update${n.pascal}Dto } from './${n.kebab}.dto${ext(options)}';
import { ${n.pascal}Entity } from './${n.kebab}.entity${ext(options)}';
import type { ${n.pascal}, ${n.pascal}Page, ${n.pascal}Repository } from './${n.kebab}.repository${ext(options)}';

const plain = ({ id, name }: ${n.pascal}Entity): ${n.pascal} => ({ id, name });

/** ${n.pascal}Repository over TypeORM. Values are bound as parameters, never concatenated into SQL. */
@Injectable()
export class TypeOrm${n.pascal}Repository implements ${n.pascal}Repository {
  constructor(@InjectRepository(${n.pascal}Entity) private readonly rows: Repository<${n.pascal}Entity>) {}
  async list({ q, page, size }: ${n.pascal}Query): Promise<${n.pascal}Page> {
    const [items, total] = await this.rows.findAndCount({
      // "%" and "_" in q act as LIKE wildcards; the value itself is a bound parameter.
      ...(q ? { where: { name: Like(\`%\${q}%\`) } } : {}),
      order: { id: 'ASC' },
      skip: (page - 1) * size,
      take: size,
    });
    return { items: items.map(plain), total, page, size };
  }
  async find(id: number): Promise<${n.pascal} | undefined> {
    const row = await this.rows.findOneBy({ id });
    return row ? plain(row) : undefined;
  }
  async create(input: Create${n.pascal}Dto): Promise<${n.pascal}> {
    return plain(await this.rows.save(this.rows.create({ name: input.name })));
  }
  async update(id: number, input: Update${n.pascal}Dto): Promise<${n.pascal} | undefined> {
    const row = await this.rows.findOneBy({ id });
    if (!row) return undefined;
    if (input.name !== undefined) row.name = input.name;
    return plain(await this.rows.save(row));
  }
  async remove(id: number): Promise<boolean> {
    const result = await this.rows.delete({ id });
    return (result.affected ?? 0) > 0;
  }
}
`;
}
export function resourceService(n: Names, options: ResourceOptions): string {
  return `import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Create${n.pascal}Dto, ${n.pascal}Query, Update${n.pascal}Dto } from './${n.kebab}.dto${ext(options)}';
import { ${token(n)} } from './${n.kebab}.repository${ext(options)}';
import type { ${n.pascal}, ${n.pascal}Page, ${n.pascal}Repository } from './${n.kebab}.repository${ext(options)}';

/** ${n.pascal} use cases. Generated by \`nestvexa make:resource\`; add authorization per record here. */
@Injectable()
export class ${n.pascal}Service {
  constructor(@Inject(${token(n)}) private readonly repository: ${n.pascal}Repository) {}
  list(query: ${n.pascal}Query): Promise<${n.pascal}Page> {
    return this.repository.list(query);
  }
  async get(id: number): Promise<${n.pascal}> {
    const item = await this.repository.find(id);
    if (!item) throw new NotFoundException();
    return item;
  }
  create(input: Create${n.pascal}Dto): Promise<${n.pascal}> {
    return this.repository.create(input);
  }
  async update(id: number, input: Update${n.pascal}Dto): Promise<${n.pascal}> {
    const item = await this.repository.update(id, input);
    if (!item) throw new NotFoundException();
    return item;
  }
  async remove(id: number): Promise<void> {
    if (!(await this.repository.remove(id))) throw new NotFoundException();
  }
}
`;
}
export function resourceModule(n: Names, options: ResourceOptions): string {
  const e = ext(options);
  const typeorm = options.orm === 'typeorm';
  const lines = [
    "import { Module } from '@nestjs/common';",
    ...(typeorm ? ["import { TypeOrmModule } from '@nestjs/typeorm';"] : []),
    ...(options.crud
      ? [`import { ${n.pascal}Controller } from './${n.kebab}.controller${e}';`]
      : []),
    ...(typeorm
      ? [
          `import { ${n.pascal}Entity } from './${n.kebab}.entity${e}';`,
          `import { TypeOrm${n.pascal}Repository } from './${n.kebab}.typeorm-repository${e}';`,
        ]
      : [
          `import { Memory${n.pascal}Repository } from './${n.kebab}.memory-repository${e}';`,
        ]),
    `import { ${token(n)} } from './${n.kebab}.repository${e}';`,
    `import { ${n.pascal}Service } from './${n.kebab}.service${e}';`,
  ];
  const implementation = typeorm
    ? `TypeOrm${n.pascal}Repository`
    : `Memory${n.pascal}Repository`;
  return `${lines.join('\n')}

/**
 * Provides ${n.pascal}Service with the ${typeorm ? 'TypeORM' : 'in-memory'} repository; listed in liveImports so the Live
 * table can inject it.${typeorm ? ' Register TypeOrmModule.forRoot(...) (your DataSource) in AppModule.' : ''}
 */
@Module({
${typeorm ? `  imports: [TypeOrmModule.forFeature([${n.pascal}Entity])],\n` : ''}${options.crud ? `  controllers: [${n.pascal}Controller],\n` : ''}  providers: [${n.pascal}Service, { provide: ${token(n)}, useClass: ${implementation} }],
  exports: [${n.pascal}Service],
})
export class ${n.pascal}Module {}
`;
}
export function resourceController(n: Names, options: ResourceOptions): string {
  const e = ext(options);
  return `import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { FormValidationPipe } from '@nestvexa/forms';
import { create${n.pascal}Adapter, ${n.camel}QueryAdapter, update${n.pascal}Adapter } from './${n.kebab}.dto${e}';
import type { Create${n.pascal}Dto, ${n.pascal}Query, Update${n.pascal}Dto } from './${n.kebab}.dto${e}';
import type { ${n.pascal}, ${n.pascal}Page } from './${n.kebab}.repository${e}';
import { ${n.pascal}Service } from './${n.kebab}.service${e}';

/**
 * REST routes generated by \`nestvexa make:resource --crud\`. Invalid input is a
 * 400 with field errors; add guards before production.
 */
@Controller('${n.kebab}')
export class ${n.pascal}Controller {
  constructor(@Inject(${n.pascal}Service) private readonly ${n.camel}: ${n.pascal}Service) {}

  @Get()
  list(@Query(new FormValidationPipe(${n.camel}QueryAdapter)) query: ${n.pascal}Query): Promise<${n.pascal}Page> {
    return this.${n.camel}.list(query);
  }

  @Get(':id')
  show(@Param('id', ParseIntPipe) id: number): Promise<${n.pascal}> {
    return this.${n.camel}.get(id);
  }

  @Post()
  create(@Body(new FormValidationPipe(create${n.pascal}Adapter)) body: Create${n.pascal}Dto): Promise<${n.pascal}> {
    return this.${n.camel}.create(body);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new FormValidationPipe(update${n.pascal}Adapter)) body: Update${n.pascal}Dto,
  ): Promise<${n.pascal}> {
    return this.${n.camel}.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.${n.camel}.remove(id);
  }
}
`;
}
export function resourceComponent(n: Names, options: ResourceOptions): string {
  const e = ext(options);
  return `import { Inject } from '@nestjs/common';
import { Action, Computed, LiveComponent, State } from 'nestvexa';
import type { LiveUpdateContext } from 'nestvexa';
import { create${n.pascal}Adapter } from './${n.kebab}.dto${e}';
import type { ${n.pascal}Page } from './${n.kebab}.repository${e}';
import { ${n.pascal}Service } from './${n.kebab}.service${e}';

const pageSize = 10;
const text = (max: number) => ({
  writable: true as const,
  validate: (value: unknown) => typeof value === 'string' && value.length <= max,
});

/** Live CRUD table: search, pages and a validated create form over ${n.pascal}Service. */
@LiveComponent({ name: '${n.kebab}-table', view: 'components/${n.kebab}-table' })
export class ${n.pascal}TableComponent {
  constructor(@Inject(${n.pascal}Service) private readonly ${n.camel}: ${n.pascal}Service) {}
  @State(text(80)) draft = '';
  @State(text(80)) search = '';
  @State() page = 1;
  @State() error = '';
  #result: ${n.pascal}Page = { items: [], total: 0, page: 1, size: pageSize };

  /** Loads the visible page before every render (the rows are not part of the client state). */
  async beforeRender(): Promise<void> {
    const q = this.search.trim();
    this.#result = await this.${n.camel}.list({ ...(q ? { q } : {}), page: this.page, size: pageSize });
  }
  afterUpdate(update: LiveUpdateContext): void {
    if (update.field === 'search') this.page = 1;
  }
  @Computed() get rows() {
    return this.#result.items.map((item) => ({ ...item }));
  }
  @Computed() get summary() {
    const { total, page } = this.#result;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    return { total, page, pages, previous: page > 1, next: page < pages };
  }
  @Action() async create(): Promise<void> {
    const result = await create${n.pascal}Adapter.validate({ name: this.draft });
    if (!result.ok) {
      this.error = result.errors['name']?.[0] ?? 'Check the name.';
      return;
    }
    await this.${n.camel}.create(result.value);
    this.draft = '';
    this.error = '';
  }
  @Action() previous(): void {
    this.page = Math.max(1, this.page - 1);
  }
  @Action() next(): void {
    this.page += 1;
  }
}
`;
}
export function resourceView(n: Names): string {
  return `<section aria-label="${n.pascal}">
  <form nv:submit="create">
    <label for="${n.kebab}-draft">Name</label>
    <input id="${n.kebab}-draft" nv:model="draft" value="{{draft}}" maxlength="80" aria-invalid="{{#if error}}true{{else}}false{{/if}}" aria-describedby="${n.kebab}-error" />
    <button type="submit">Add</button>
    <p id="${n.kebab}-error" role="alert">{{error}}</p>
  </form>
  <label for="${n.kebab}-search">Search</label>
  <input id="${n.kebab}-search" type="search" nv:model.live.debounce.300ms="search" value="{{search}}" maxlength="80" />
  <ul>
    {{#each rows}}<li data-nv-key="${n.kebab}-{{id}}">{{name}}</li>{{else}}<li>No items yet.</li>{{/each}}
  </ul>
  <nav aria-label="${n.pascal} pages">
    {{#if summary.previous}}<button type="button" nv:click="previous">Previous</button>{{else}}<button type="button" disabled>Previous</button>{{/if}}
    <span>Page {{summary.page}} of {{summary.pages}} ({{summary.total}} total)</span>
    {{#if summary.next}}<button type="button" nv:click="next">Next</button>{{else}}<button type="button" disabled>Next</button>{{/if}}
  </nav>
</section>
`;
}

// ---------------------------------------------------------------- tests

export function resourceServiceTest(
  n: Names,
  options: ResourceOptions,
): string {
  const e = ext(options);
  return `import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
${testImports(options.runner)}
import { Memory${n.pascal}Repository } from './${n.kebab}.memory-repository${e}';
import { ${n.pascal}Service } from './${n.kebab}.service${e}';

describe('${n.pascal}Service', () => {
  it('creates, searches, pages, updates and removes records', async () => {
    const service = new ${n.pascal}Service(new Memory${n.pascal}Repository());
    const first = await service.create({ name: 'Alpha' });
    await service.create({ name: 'Beta' });
    await service.create({ name: 'Alphabet' });
    expect((await service.list({ q: 'alpha', page: 1, size: 20 })).total).toBe(2);
    expect(await service.list({ page: 2, size: 2 })).toMatchObject({ total: 3, items: [{ name: 'Alphabet' }] });
    expect(await service.update(first.id, { name: 'Gamma' })).toEqual({ id: first.id, name: 'Gamma' });
    await service.remove(first.id);
    await expect(service.get(first.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.remove(first.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});
`;
}
export function resourceDtoTest(n: Names, options: ResourceOptions): string {
  return `${testImports(options.runner)}
import { create${n.pascal}Adapter, ${n.camel}QueryAdapter, update${n.pascal}Adapter } from './${n.kebab}.dto${ext(options)}';

describe('${n.pascal} DTOs', () => {
  it('trims valid names and rejects short, long and unknown fields', async () => {
    expect(await create${n.pascal}Adapter.validate({ name: '  Ada  ' })).toEqual({ ok: true, value: { name: 'Ada' } });
    for (const input of [{ name: 'A' }, { name: 'x'.repeat(81) }, { name: 'Ada', admin: true }, {}]) {
      const result = await create${n.pascal}Adapter.validate(input);
      expect(result.ok).toBe(false);
    }
    expect(await update${n.pascal}Adapter.validate({})).toEqual({ ok: true, value: {} });
  });
  it('coerces and bounds the list query', async () => {
    expect(await ${n.camel}QueryAdapter.validate({ page: '2' })).toEqual({ ok: true, value: { page: 2, size: 20 } });
    expect((await ${n.camel}QueryAdapter.validate({ size: '1000' })).ok).toBe(false);
    expect((await ${n.camel}QueryAdapter.validate({ page: '0' })).ok).toBe(false);
  });
});
`;
}
export function resourceControllerTest(
  n: Names,
  options: ResourceOptions,
): string {
  const e = ext(options);
  const fastify = options.platform === 'fastify';
  return `import 'reflect-metadata';
${testImports(options.runner)}
import { Test } from '@nestjs/testing';
${fastify ? "import { FastifyAdapter } from '@nestjs/platform-fastify';\n" : ''}import { ${n.pascal}Controller } from './${n.kebab}.controller${e}';
import { Memory${n.pascal}Repository } from './${n.kebab}.memory-repository${e}';
import { ${token(n)} } from './${n.kebab}.repository${e}';
import { ${n.pascal}Service } from './${n.kebab}.service${e}';

describe('${n.pascal}Controller (HTTP)', () => {
  it('validates input and serves the CRUD routes', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [${n.pascal}Controller],
      providers: [${n.pascal}Service, { provide: ${token(n)}, useClass: Memory${n.pascal}Repository }],
    }).compile();
    const app = moduleRef.createNestApplication(${fastify ? 'new FastifyAdapter(), ' : ''}{ logger: false });
    await app.listen(0, '127.0.0.1');
    try {
      const url = \`\${await app.getUrl()}/${n.kebab}\`;
      const send = (path: string, method: string, body?: unknown) =>
        fetch(\`\${url}\${path}\`, {
          method,
          headers: { 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const invalid = await send('', 'POST', { name: 'A' });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ errors: { name: expect.any(Array) } });
      const created = await send('', 'POST', { name: 'Ada' });
      expect(created.status).toBe(201);
      const item = (await created.json()) as { id: number };
      expect(await (await send('?q=ad', 'GET')).json()).toEqual({ items: [{ id: item.id, name: 'Ada' }], total: 1, page: 1, size: 20 });
      expect((await send('?size=500', 'GET')).status).toBe(400);
      expect(await (await send(\`/\${item.id}\`, 'PATCH', { name: 'Grace' })).json()).toEqual({ id: item.id, name: 'Grace' });
      expect((await send(\`/\${item.id}\`, 'DELETE')).status).toBe(204);
      expect((await send(\`/\${item.id}\`, 'GET')).status).toBe(404);
      expect((await send('/abc', 'GET')).status).toBe(400);
    } finally {
      await app.close();
    }
    // Booting Nest takes a few seconds on a cold or loaded machine.
  }, 60_000);
});
`;
}
