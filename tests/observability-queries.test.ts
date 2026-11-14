/**
 * EXT-009: development-only N+1 query detection. ORMs report statements
 * through the structural `record()` hook; statements are counted per request
 * scope by normalized shape and a warning names the repeated shape (never
 * literal values). A real TypeORM data source (sql.js) and a real Nest
 * Express host drive the hook; production disables it completely.
 */
import 'reflect-metadata';
import { Controller, Get } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource, EntitySchema } from 'typeorm';
import type { Logger } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  describeQueryBudgetWarning,
  normalizeQuery,
  queryBudget,
} from '../packages/observability/dist/index.js';
import type {
  QueryBudget,
  QueryBudgetWarning,
} from '../packages/observability/dist/index.js';

interface Author {
  id: number;
  name: string;
}
interface Post {
  id: number;
  authorId: number;
  title: string;
}
const AuthorSchema = new EntitySchema<Author>({
  name: 'author',
  columns: {
    id: { type: Number, primary: true, generated: true },
    name: { type: String },
  },
});
const PostSchema = new EntitySchema<Post>({
  name: 'post',
  columns: {
    id: { type: Number, primary: true, generated: true },
    authorId: { type: Number },
    title: { type: String },
  },
});

/** The whole integration: TypeORM's logger forwards every statement. */
class BudgetLogger implements Logger {
  constructor(private readonly budget: QueryBudget) {}
  logQuery(query: string): void {
    this.budget.record(query);
  }
  logQueryError(): void {}
  logQuerySlow(): void {}
  logSchemaBuild(): void {}
  logMigration(): void {}
  log(): void {}
}

const warnings: QueryBudgetWarning[] = [];
const budget = queryBudget({
  environment: 'development',
  maxIdenticalQueries: 5,
  maxQueries: 40,
  onWarning: (warning) => warnings.push(warning),
});
let database: DataSource;

beforeAll(async () => {
  database = new DataSource({
    type: 'sqljs',
    entities: [AuthorSchema, PostSchema],
    synchronize: true,
    logging: ['query'],
    logger: new BudgetLogger(budget),
  });
  await database.initialize();
  const authors = database.getRepository(AuthorSchema);
  const posts = database.getRepository(PostSchema);
  for (let index = 1; index <= 8; index++) {
    const author = await authors.save({ name: `author-${index}` });
    await posts.save({ authorId: author.id, title: `post by ${index}` });
  }
});
afterAll(async () => {
  await database.destroy();
});

/** The classic N+1: one query for the list, one per row for its children. */
async function nPlusOne(): Promise<number> {
  const authors = await database.getRepository(AuthorSchema).find();
  let total = 0;
  for (const author of authors)
    total += await database
      .getRepository(PostSchema)
      .count({ where: { authorId: author.id } });
  return total;
}
/** The fix: one batched query for every child. */
async function batched(): Promise<number> {
  const authors = await database.getRepository(AuthorSchema).find();
  const rows = await database
    .getRepository(PostSchema)
    .createQueryBuilder('post')
    .where('post.authorId IN (:...ids)', {
      ids: authors.map((author) => author.id),
    })
    .getMany();
  return rows.length;
}

describe('normalizeQuery', () => {
  it('collapses literals, placeholders and IN lists into one shape', () => {
    const shape = 'SELECT * FROM "post" WHERE "authorId" = ?';
    expect(normalizeQuery('SELECT * FROM "post" WHERE "authorId" = 1')).toBe(
      shape,
    );
    expect(
      normalizeQuery('SELECT *  FROM "post"\n WHERE "authorId" = $12'),
    ).toBe(shape);
    expect(normalizeQuery('SELECT * FROM "post" WHERE "authorId" = :id')).toBe(
      shape,
    );
    expect(
      normalizeQuery("SELECT * FROM users WHERE email = 'a''b@example.com'"),
    ).toBe('SELECT * FROM users WHERE email = ?');
    expect(normalizeQuery('SELECT * FROM t WHERE id IN (1, 2, 3)')).toBe(
      normalizeQuery('SELECT * FROM t WHERE id IN (?)'),
    );
    // Casts and identifiers containing digits are kept.
    expect(normalizeQuery('SELECT name::text FROM table2')).toBe(
      'SELECT name::text FROM table2',
    );
  });
});

describe('queryBudget scopes', () => {
  it('warns once when one statement repeats past the limit within a scope', () => {
    const seen: QueryBudgetWarning[] = [];
    const local = queryBudget({
      environment: 'development',
      onWarning: (warning) => seen.push(warning),
    });
    local.run('job:digest', () => {
      for (let id = 1; id <= 9; id++)
        local.record(`SELECT * FROM post WHERE author_id = ${id}`);
      local.record('SELECT count(*) FROM author');
      expect(local.current()?.total).toBe(10);
    });
    expect(seen).toEqual([
      {
        kind: 'n-plus-one',
        scope: 'job:digest',
        statement: 'SELECT * FROM post WHERE author_id = ?',
        count: 6,
        limit: 5,
      },
    ]);
    expect(describeQueryBudgetWarning(seen[0] as QueryBudgetWarning)).toMatch(
      /possible N\+1 in job:digest: the same statement ran 6 times \(limit 5\)/,
    );
  });

  it('never reports literal values from the statement', () => {
    const seen: QueryBudgetWarning[] = [];
    const local = queryBudget({
      environment: 'development',
      maxIdenticalQueries: 1,
      onWarning: (warning) => seen.push(warning),
    });
    local.run('request', () => {
      local.record("SELECT * FROM users WHERE email = 'alice@example.com'");
      local.record({ query: "SELECT * FROM users WHERE email = 'bob@x.io'" });
    });
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen)).not.toMatch(/alice|bob|example/);
  });

  it('warns once when a scope runs too many statements in total', () => {
    const seen: QueryBudgetWarning[] = [];
    const local = queryBudget({
      environment: 'development',
      maxQueries: 3,
      onWarning: (warning) => seen.push(warning),
    });
    local.run('page', () => {
      for (const table of ['a', 'b', 'c', 'd', 'e'])
        local.record({ sql: `SELECT * FROM ${table}` });
    });
    expect(seen).toEqual([
      { kind: 'query-count', scope: 'page', statement: '', count: 4, limit: 3 },
    ]);
  });

  it('keeps concurrent scopes apart and ignores statements outside a scope', async () => {
    const seen: QueryBudgetWarning[] = [];
    const local = queryBudget({
      environment: 'development',
      maxIdenticalQueries: 3,
      onWarning: (warning) => seen.push(warning),
    });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
    const work = (label: string) =>
      local.run(label, async () => {
        for (let index = 0; index < 3; index++) {
          await tick();
          local.record({ text: 'SELECT * FROM post WHERE id = $1' });
        }
        return local.current()?.total;
      });
    // Six identical statements in total, but three per scope: no warning.
    expect(await Promise.all([work('first'), work('second')])).toEqual([3, 3]);
    local.record('SELECT 1');
    expect(local.current()).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it('ignores unusable statements and survives a throwing warning sink', () => {
    const local = queryBudget({
      environment: 'development',
      maxIdenticalQueries: 1,
      onWarning: () => {
        throw new Error('sink down');
      },
    });
    local.run('scope', () => {
      local.record(undefined);
      local.record({ query: 42 });
      local.record('SELECT 1');
      expect(() => local.record('SELECT 2')).not.toThrow();
      expect(local.current()?.total).toBe(2);
    });
    expect(() =>
      queryBudget({ environment: 'development', maxQueries: 0 }),
    ).toThrow(/positive integer/);
  });

  it('is completely off in production', () => {
    const seen: QueryBudgetWarning[] = [];
    const production = queryBudget({
      environment: 'production',
      maxIdenticalQueries: 1,
      onWarning: (warning) => seen.push(warning),
    });
    expect(production.enabled).toBe(false);
    const result = production.run('request', () => {
      for (let index = 0; index < 50; index++)
        production.record('SELECT * FROM post WHERE id = 1');
      return production.current();
    });
    expect(result).toBeUndefined();
    let called = false;
    production.middleware()({ method: 'GET' }, {}, () => {
      called = true;
      expect(production.current()).toBeUndefined();
    });
    expect(called).toBe(true);
    expect(seen).toEqual([]);
  });
});

describe('queryBudget with real TypeORM (sql.js)', () => {
  it('flags the N+1 loop and stays quiet for the batched query', async () => {
    warnings.length = 0;
    expect(await budget.run('authors-n+1', nPlusOne)).toBe(8);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      kind: 'n-plus-one',
      scope: 'authors-n+1',
      count: 6,
      limit: 5,
    });
    expect(warnings[0]?.statement).toMatch(/^SELECT COUNT/i);
    expect(warnings[0]?.statement).toContain('"post"');
    warnings.length = 0;
    expect(await budget.run('authors-batched', batched)).toBe(8);
    expect(warnings).toEqual([]);
  });
});

@Controller()
class AuthorsController {
  @Get('n-plus-one')
  async slow(): Promise<{ posts: number; statements: number | undefined }> {
    return { posts: await nPlusOne(), statements: budget.current()?.total };
  }
  @Get('batched')
  async fast(): Promise<{ posts: number; statements: number | undefined }> {
    return { posts: await batched(), statements: budget.current()?.total };
  }
}

describe('queryBudget middleware on a Nest Express host', () => {
  const port = 4245;
  let app: INestApplication;
  beforeAll(async () => {
    app = await NestFactory.create(
      { module: class QueriesModule {}, controllers: [AuthorsController] },
      { logger: false },
    );
    app.use(budget.middleware());
    await app.listen(port, '127.0.0.1');
  });
  afterAll(() => app.close());

  it('counts statements per request and warns for the N+1 route only', async () => {
    warnings.length = 0;
    const fast = await fetch(`http://127.0.0.1:${port}/batched`);
    expect(await fast.json()).toEqual({ posts: 8, statements: 2 });
    expect(warnings).toEqual([]);
    const responses = await Promise.all([
      fetch(`http://127.0.0.1:${port}/n-plus-one`),
      fetch(`http://127.0.0.1:${port}/n-plus-one`),
    ]);
    for (const response of responses)
      expect(await response.json()).toEqual({ posts: 8, statements: 9 });
    // One warning per request scope: the two requests were counted apart.
    expect(warnings).toHaveLength(2);
    for (const warning of warnings)
      expect(warning).toMatchObject({
        kind: 'n-plus-one',
        scope: 'HTTP GET',
        count: 6,
      });
  });
});
