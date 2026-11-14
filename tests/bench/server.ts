/**
 * Benchmark servers for `pnpm bench` (scripts/bench.mjs), one target per
 * process so the load generator never shares the server's event loop:
 *
 *   BENCH_TARGET=<target> BENCH_PORT=4210 node --expose-gc --import tsx tests/bench/server.ts
 *
 * Targets render the same data with the same Handlebars templates
 * (tests/bench/views):
 * - `nestvexa-hbs`:     NestvexaModule MVC page, a Live list component and a
 *                       no-op Live action, with the production view cache on
 *                       (`views.cache` defaults to false);
 * - `plain-hbs`:        plain NestJS + Express with Handlebars registered as
 *                       the Express view engine (the Nest MVC recipe), and a
 *                       plain JSON POST route as the no-op baseline;
 * - `nestvexa-inertia`: `@nestvexa/inertia` page;
 * - `plain-inertia`:    a hand-written responder following the official
 *                       Inertia protocol (X-Inertia JSON page object, HTML
 *                       root with `data-page`, 409 on version mismatch), as an
 *                       official server adapter does. No first-party Nest
 *                       adapter exists to compare with.
 *
 * Every target exposes `GET /__bench/heap` (heap after a forced full GC).
 */
import 'reflect-metadata';
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Module,
  Post,
  Query,
  Render,
  Req,
  Res,
} from '@nestjs/common';
import type { DynamicModule, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  Action,
  LiveComponent,
  LiveRuntime,
  MemoryLiveStore,
  NestvexaModule,
  State,
  configureNestvexa,
} from '../../packages/nestvexa/dist/index.js';
import {
  InertiaModule,
  InertiaPage,
} from '../../packages/inertia/dist/index.js';

const target = process.env['BENCH_TARGET'] ?? '';
const port = Number(process.env['BENCH_PORT'] ?? 4210);
const views = fileURLToPath(new URL('./views', import.meta.url));
const origin = `http://127.0.0.1:${port}`;
const csrf = 'bench-csrf-token-0123456789abcdefghijklmnop';

export interface Row {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly total: number;
}
/** Deterministic table data shared by every target. */
function rows(count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    name: `Customer ${index + 1} <${(index * 37) % 1000}>`,
    status: index % 3 ? 'paid' : 'open',
    total: (index * 7919) % 100_000,
  }));
}
function rowCount(value: string | undefined, fallback = 50): number {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 5_000
    ? parsed
    : fallback;
}
const model = (count: number) => ({
  title: 'Benchmark page',
  summary: `${count} rows rendered on the server`,
  rows: rows(count),
});

function collect(): void {
  const gc: unknown = Reflect.get(globalThis, 'gc');
  if (typeof gc === 'function')
    for (let pass = 0; pass < 3; pass++) Reflect.apply(gc, undefined, []);
}
@Controller('__bench')
class HeapController {
  @Get('heap')
  heap() {
    collect();
    return { heapUsed: process.memoryUsage().heapUsed };
  }
}

// --- Nestvexa MVC + Live -------------------------------------------------

/** Mount size for the next `/live` mount (mount hooks take no input). */
let mountRows = 10;
@LiveComponent({ name: 'bench-list', view: 'bench-list' })
class BenchList {
  @State() rows: Row[] = [];
  @State() version = 0;
  mount(): void {
    this.rows = rows(mountRows);
  }
  /** Changes nothing: measures the action pipeline itself. */
  @Action() noop(): void {}
  /** Touches one row: a typical small update. */
  @Action() touch(): void {
    this.version++;
  }
}

interface BenchRequest {
  headers: Record<string, string | string[] | undefined>;
}
@Controller()
class NestvexaPages {
  constructor(@Inject(LiveRuntime) private readonly live: LiveRuntime) {}
  @Get('page')
  @Render('page')
  page(@Query('rows') count?: string) {
    return model(rowCount(count));
  }
  @Get('live')
  @Header('Cache-Control', 'no-store')
  async mount(@Req() request: BenchRequest, @Query('rows') count?: string) {
    mountRows = rowCount(count, 10);
    return (await this.live.mount(BenchList, request)).value;
  }
}
function nestvexaHbs(): Type<object> {
  @Module({
    imports: [
      NestvexaModule.forRoot(
        {
          views: { root: views, layout: 'layout', cache: true },
          live: { enabled: true },
        },
        {
          components: [BenchList],
          useFactory: () => ({
            origin,
            maxRequestsPerMinute: 1_000_000,
            store: new MemoryLiveStore({ maxEntries: 20_000 }),
            // One identity per simulated user (header), so per-identity
            // limits and locks behave as with real users.
            resolveIdentity: (request: object) => ({
              binding: `bench/session/user/${String(
                Reflect.get(
                  Object(Reflect.get(request, 'headers')),
                  'x-bench-user',
                ) ?? 'anonymous',
              )}`,
              csrfToken: csrf,
            }),
            authorize: () => true,
          }),
        },
      ),
    ],
    controllers: [NestvexaPages, HeapController],
  })
  class NestvexaBench {}
  return NestvexaBench;
}

// --- Plain NestJS + Handlebars -------------------------------------------

interface Handlebars {
  compile(source: string): (context: object) => string;
}
/** The engine-hbs package's own Handlebars, so both targets run one version. */
const handlebars = createRequire(
  new URL('../../packages/engine-hbs/package.json', import.meta.url),
)('handlebars') as Handlebars;
const compiled = new Map<string, (context: object) => string>();
function template(name: string): (context: object) => string {
  let found = compiled.get(name);
  if (!found) {
    found = handlebars.compile(readFileSync(`${views}/${name}.hbs`, 'utf8'));
    compiled.set(name, found);
  }
  return found;
}
@Controller()
class PlainPages {
  @Get('page')
  @Render('page')
  page(@Query('rows') count?: string) {
    return model(rowCount(count));
  }
  /** The no-op baseline: a JSON POST route with a validated body. */
  @Post('noop')
  @HttpCode(200)
  noop(@Body() body: unknown) {
    const revision = Number(Reflect.get(Object(body), 'revision') ?? 0);
    return { revision: revision + 1 };
  }
}
function plainHbs(): Type<object> {
  @Module({ controllers: [PlainPages, HeapController] })
  class PlainBench {}
  return PlainBench;
}

// --- Inertia --------------------------------------------------------------

const assetVersion = 'bench-1';
@Controller()
class InertiaPages {
  @Get('page')
  @InertiaPage('Table')
  page(@Query('rows') count?: string) {
    return model(rowCount(count));
  }
}
function nestvexaInertia(): Type<object> {
  @Module({
    imports: [
      InertiaModule.forRoot({
        version: assetVersion,
        session: false,
        entry: { scripts: ['/assets/app.js'] },
      }) as DynamicModule,
    ],
    controllers: [InertiaPages, HeapController],
  })
  class InertiaBench {}
  return InertiaBench;
}

interface PlainResponse {
  status(code: number): PlainResponse;
  setHeader(name: string, value: string): void;
  send(body: string): void;
  json(body: unknown): void;
  type(value: string): PlainResponse;
}
const escapeAttribute = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
@Controller()
class OfficialStyleInertia {
  /** The protocol as the official server adapters implement it. */
  @Get('page')
  page(
    @Req() request: BenchRequest & { url: string },
    @Res() response: PlainResponse,
    @Query('rows') count?: string,
  ): void {
    const page = {
      component: 'Table',
      props: { errors: {}, ...model(rowCount(count)) },
      url: request.url,
      version: assetVersion,
      clearHistory: false,
      encryptHistory: false,
    };
    response.setHeader('Vary', 'X-Inertia');
    if (request.headers['x-inertia'] === 'true') {
      if (request.headers['x-inertia-version'] !== assetVersion) {
        response.setHeader('X-Inertia-Location', request.url);
        response.status(409).send('');
        return;
      }
      response.setHeader('X-Inertia', 'true');
      response.json(page);
      return;
    }
    response
      .type('html')
      .send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Table</title><script type="module" src="/assets/app.js"></script></head><body><div id="app" data-page="${escapeAttribute(JSON.stringify(page))}"></div></body></html>`,
      );
  }
}
function plainInertia(): Type<object> {
  @Module({ controllers: [OfficialStyleInertia, HeapController] })
  class OfficialInertiaBench {}
  return OfficialInertiaBench;
}

const modules: Readonly<Record<string, () => Type<object>>> = {
  'nestvexa-hbs': nestvexaHbs,
  'plain-hbs': plainHbs,
  'nestvexa-inertia': nestvexaInertia,
  'plain-inertia': plainInertia,
};
const factory = modules[target];
if (!factory) throw new Error(`Unknown BENCH_TARGET ${target}`);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
  throw new Error('BENCH_PORT must be a TCP port');
const app = await NestFactory.create<NestExpressApplication>(factory(), {
  logger: ['error'],
});
if (target === 'plain-hbs') {
  // The Nest MVC recipe with Handlebars as the Express view engine; the
  // layout is applied the same way the Nestvexa renderer applies it.
  app.engine(
    'hbs',
    (
      path: string,
      options: object,
      done: (error: unknown, html?: string) => void,
    ) => {
      try {
        const name = path.slice(views.length + 1).replace(/\.hbs$/, '');
        const body = template(name)(options);
        done(null, template('layout')({ ...options, body }));
      } catch (error) {
        done(error);
      }
    },
  );
  app.setBaseViewsDir(views);
  app.setViewEngine('hbs');
} else if (target === 'nestvexa-hbs') await configureNestvexa(app);
await app.listen(port, '127.0.0.1');
console.log(`bench:${target}:ready`);
