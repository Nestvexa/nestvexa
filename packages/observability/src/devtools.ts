import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  Inject,
  Module,
  NotFoundException,
  Req,
} from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type {
  MemoryInstrumentation,
  MetricSummary,
  SpanRecord,
} from './instrumentation.js';

export const DEVTOOLS_OPTIONS = Symbol('nv:devtools-options');
export interface DevtoolsOptions {
  readonly instrumentation: MemoryInstrumentation;
  /** Host check for who may read the panel (for example an admin session in development). */
  readonly authorize: (request: object) => boolean | Promise<boolean>;
  readonly path?: string;
  /** Defaults to `process.env.NODE_ENV`; the module refuses to register in production. */
  readonly environment?: string;
}
function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
export function renderDevtools(
  summary: readonly MetricSummary[],
  records: readonly SpanRecord[],
): string {
  const rows = summary
    .map(
      (item) =>
        `<tr><th scope="row">${escape(item.name)}</th><td>${item.count}</td><td>${item.errors}</td><td>${item.p50.toFixed(1)}</td><td>${item.p95.toFixed(1)}</td><td>${item.max.toFixed(1)}</td></tr>`,
    )
    .join('');
  const recent = records
    .slice(-50)
    .reverse()
    .map(
      (record) =>
        `<li><code>${escape(record.name)}</code> ${escape(record.outcome)} ${record.milliseconds.toFixed(1)} ms <small>${escape(JSON.stringify(record.attributes))}</small></li>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nestvexa devtools</title></head><body><main><h1>Nestvexa devtools (development only)</h1><table><caption>Span timings in milliseconds</caption><thead><tr><th scope="col">Span</th><th scope="col">Count</th><th scope="col">Errors</th><th scope="col">p50</th><th scope="col">p95</th><th scope="col">Max</th></tr></thead><tbody>${rows}</tbody></table><h2>Recent spans</h2><ul>${recent}</ul></main></body></html>`;
}

/**
 * Development-only panel: span summaries and recent spans recorded by a
 * `MemoryInstrumentation`. Registration throws in production; requests also
 * require the host `authorize` check. No state, identities or tokens are recorded.
 */
@Module({})
export class DevtoolsModule {
  static register(options: DevtoolsOptions): DynamicModule {
    const environment =
      options.environment ?? process.env['NODE_ENV'] ?? 'development';
    if (environment === 'production')
      throw new Error('Nestvexa devtools must not be registered in production');
    if (typeof options.authorize !== 'function')
      throw new Error(
        'Nestvexa devtools requires an authorize(request) policy',
      );
    const path = options.path ?? '/_nestvexa/devtools';
    if (!/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(path))
      throw new Error('Invalid devtools path');
    @Controller(path)
    class DevtoolsController {
      constructor(
        @Inject(DEVTOOLS_OPTIONS) private readonly devtools: DevtoolsOptions,
      ) {}
      async #check(request: object): Promise<void> {
        if (!(await this.devtools.authorize(request)))
          throw new ForbiddenException();
      }
      @Get()
      @Header('Cache-Control', 'no-store')
      @Header('Content-Type', 'text/html; charset=utf-8')
      @Header(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'",
      )
      async page(@Req() request: object): Promise<string> {
        await this.#check(request);
        return renderDevtools(
          this.devtools.instrumentation.summary(),
          this.devtools.instrumentation.records,
        );
      }
      @Get('spans.json')
      @Header('Cache-Control', 'no-store')
      async json(@Req() request: object) {
        await this.#check(request);
        return {
          summary: this.devtools.instrumentation.summary(),
          recent: this.devtools.instrumentation.records.slice(-200),
        };
      }
      @Get('*rest')
      missing(): never {
        throw new NotFoundException();
      }
    }
    return {
      module: DevtoolsModule,
      controllers: [DevtoolsController],
      providers: [{ provide: DEVTOOLS_OPTIONS, useValue: options }],
    };
  }
}
