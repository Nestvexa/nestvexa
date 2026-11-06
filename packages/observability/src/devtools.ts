import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  Inject,
  Module,
  NotFoundException,
  Query,
  Req,
} from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type {
  MemoryInstrumentation,
  MetricSummary,
  SpanRecord,
} from './instrumentation.js';
import type {
  DevtoolsInspector,
  InspectedComponent,
  InspectedRender,
} from './inspector.js';

export const DEVTOOLS_OPTIONS = Symbol('nv:devtools-options');
export interface DevtoolsOptions {
  readonly instrumentation: MemoryInstrumentation;
  /**
   * Live inspector shared with the Live `inspector` option: adds registered
   * components, redacted public state, re-render causes and form errors.
   */
  readonly inspector?: DevtoolsInspector;
  /** Host check for who may read the panel (for example an admin session in development). */
  readonly authorize: (request: object) => boolean | Promise<boolean>;
  readonly path?: string;
  /** Defaults to `process.env.NODE_ENV`; the module refuses to register in production. */
  readonly environment?: string;
}

/** Version of the `data.json` contract (see docs/adr/0034-devtools-browser-extension-scope.md). */
export const DEVTOOLS_SCHEMA = 'nestvexa-devtools/1';
export type DevtoolsRenderer =
  'live' | 'inertia-document' | 'inertia-json' | 'ssr';
/**
 * The stable devtools data contract served at `<path>/data.json`. Fields may
 * be added in later `nestvexa-devtools/1` responses; removing or changing one
 * requires a new schema version.
 */
export interface DevtoolsSnapshot {
  readonly schema: typeof DEVTOOLS_SCHEMA;
  readonly generatedAt: string;
  /** Registered Live components (empty without an inspector). */
  readonly components: readonly InspectedComponent[];
  /** Recent top-level Live renders, newest first. */
  readonly renders: readonly InspectedRender[];
  readonly summary: readonly MetricSummary[];
  /** Recent spans, newest first; each group below is a subset of these. */
  readonly spans: readonly SpanRecord[];
  readonly requests: readonly SpanRecord[];
  readonly actions: readonly SpanRecord[];
  readonly errors: readonly SpanRecord[];
  readonly hooks: readonly SpanRecord[];
  readonly realtime: readonly SpanRecord[];
  readonly jobs: readonly SpanRecord[];
  readonly assets: readonly SpanRecord[];
  readonly renderers: readonly {
    readonly renderer: DevtoolsRenderer;
    readonly count: number;
  }[];
}

const spanLimit = 200;
const groupLimit = 50;
function rendererOf(record: SpanRecord): DevtoolsRenderer | undefined {
  if (record.name === 'nestvexa.live.render') return 'live';
  if (record.name === 'nestvexa.ssr.render') return 'ssr';
  if (record.name === 'nestvexa.inertia.render')
    return record.attributes['nestvexa.inertia.kind'] === 'json'
      ? 'inertia-json'
      : 'inertia-document';
  return undefined;
}

/** Build the devtools data contract from the recorders. */
export function devtoolsSnapshot(
  instrumentation: MemoryInstrumentation,
  inspector?: DevtoolsInspector,
  now: () => Date = () => new Date(),
): DevtoolsSnapshot {
  const spans = instrumentation.records.slice(-spanLimit).reverse();
  const group = (test: (record: SpanRecord) => boolean) =>
    spans.filter(test).slice(0, groupLimit);
  const counts = new Map<DevtoolsRenderer, number>();
  for (const record of instrumentation.records) {
    const renderer = rendererOf(record);
    if (renderer) counts.set(renderer, (counts.get(renderer) ?? 0) + 1);
  }
  return {
    schema: DEVTOOLS_SCHEMA,
    generatedAt: now().toISOString(),
    components: inspector?.components ?? [],
    renders: (inspector?.renders ?? []).slice(0, groupLimit),
    summary: instrumentation.summary(),
    spans,
    requests: group((record) => record.name === 'nestvexa.request'),
    actions: group(
      (record) =>
        record.name === 'nestvexa.live.action' ||
        record.name === 'nestvexa.action',
    ),
    errors: group((record) => record.outcome === 'error'),
    hooks: group((record) => record.name === 'nestvexa.live.hook'),
    realtime: group((record) => record.name.startsWith('nestvexa.realtime.')),
    jobs: group((record) => record.name.startsWith('nestvexa.job.')),
    assets: group((record) => record.name === 'nestvexa.asset.serve'),
    renderers: [...counts].map(([renderer, count]) => ({ renderer, count })),
  };
}

function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
const attribute = (record: SpanRecord, key: string): string => {
  const value = record.attributes[key];
  return value === undefined ? '' : escape(String(value));
};
const ms = (value: number) => `${value.toFixed(1)}`;
const time = (at: number) => escape(new Date(at).toISOString().slice(11, 23));
function table(
  id: string,
  title: string,
  caption: string,
  headings: readonly string[],
  rows: readonly string[],
  empty: string,
): string {
  const head = headings
    .map((heading) => `<th scope="col">${escape(heading)}</th>`)
    .join('');
  const body = rows.length
    ? rows.join('')
    : `<tr><td colspan="${headings.length}">${escape(empty)}</td></tr>`;
  return `<section id="${id}"><h2 id="${id}-title">${escape(title)}</h2><div class="nv-scroll" tabindex="0" role="region" aria-labelledby="${id}-title"><table><caption>${escape(caption)}</caption><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div></section>`;
}
function spanRows(
  records: readonly SpanRecord[],
  columns: readonly ((record: SpanRecord) => string)[],
): string[] {
  return records.map(
    (record) =>
      `<tr class="${record.outcome === 'error' ? 'nv-error' : ''}">${columns
        .map((column) => `<td>${column(record)}</td>`)
        .join('')}</tr>`,
  );
}
const requestId = (record: SpanRecord) =>
  record.requestId === undefined
    ? ''
    : `<code>${escape(record.requestId.slice(0, 13))}</code>`;
const outcome = (record: SpanRecord) =>
  record.outcome === 'error' ? 'error' : 'ok';

/** Server-rendered panel: no script, styles from the panel's own stylesheet. */
export function renderDevtools(
  snapshot: DevtoolsSnapshot,
  options: { readonly path?: string; readonly refresh?: number } = {},
): string {
  const path = escape(options.path ?? '/_nestvexa/devtools');
  const components = table(
    'components',
    'Registered components',
    'Live components registered in this application',
    ['Name', 'View', 'Actions', 'State (writable marked *)', 'Loading'],
    snapshot.components.map(
      (component) =>
        `<tr><th scope="row"><code>${escape(component.name)}</code></th><td><code>${escape(component.view)}</code></td><td>${escape(component.actions.join(', '))}</td><td>${escape(
          component.states
            .map((state) => `${state.name}${state.writable ? '*' : ''}`)
            .join(', '),
        )}</td><td>${component.lazy === false ? 'eager' : `lazy (${component.lazy})`}${component.realtime ? ', realtime' : ''}</td></tr>`,
    ),
    'No inspector configured or no components registered.',
  );
  const renders = `<section id="renders"><h2 id="renders-title">Components on recent pages</h2>${
    snapshot.renders.length
      ? `<ol class="nv-renders">${snapshot.renders
          .map((render) => {
            const errors = render.validationErrors.length
              ? `<p class="nv-error">Validation errors:</p><ul>${render.validationErrors
                  .map(
                    (error) =>
                      `<li><code>${escape(error.field)}</code>: ${escape(error.message)}</li>`,
                  )
                  .join('')}</ul>`
              : '';
            const cause =
              render.cause === 'action'
                ? `action <code>${escape(render.action ?? '')}</code>`
                : render.cause === 'sync'
                  ? `model sync of <code>${escape(render.fields.join(', '))}</code>`
                  : 'mount';
            return `<li><h3><code>${escape(render.component)}</code> <small>revision ${render.revision}</small></h3><p>Re-render cause: ${cause}. State ${render.stateBytes} bytes, HTML ${render.htmlBytes} bytes, at ${time(render.at)}${render.requestId === undefined ? '' : `, request <code>${escape(render.requestId.slice(0, 13))}</code>`}.</p>${errors}<details><summary>Public state (redacted)</summary><pre>${escape(JSON.stringify(render.state, null, 2) ?? 'null')}</pre></details></li>`;
          })
          .join('')}</ol>`
      : '<p>No Live renders recorded yet.</p>'
  }</section>`;
  const actions = table(
    'actions',
    'Actions',
    'Live and server actions, newest first (milliseconds)',
    [
      'Time',
      'Span',
      'Component or group',
      'Action',
      'Duration',
      'Outcome',
      'Response HTML bytes',
      'Request',
    ],
    spanRows(snapshot.actions, [
      (record) => time(record.at),
      (record) => `<code>${escape(record.name)}</code>`,
      (record) =>
        attribute(record, 'nestvexa.component') ||
        attribute(record, 'nestvexa.action.group'),
      (record) => attribute(record, 'nestvexa.action'),
      (record) => ms(record.milliseconds),
      outcome,
      (record) => attribute(record, 'nestvexa.response_html_bytes'),
      requestId,
    ]),
    'No actions recorded yet.',
  );
  const errors = table(
    'errors',
    'Errors (CSRF, authorization, validation, server)',
    'Failed spans with their status and closed error code',
    ['Time', 'Span', 'Component', 'Status', 'Error code', 'Request'],
    spanRows(snapshot.errors, [
      (record) => time(record.at),
      (record) => `<code>${escape(record.name)}</code>`,
      (record) => attribute(record, 'nestvexa.component'),
      (record) =>
        attribute(record, 'status') ||
        attribute(record, 'nestvexa.http.status'),
      (record) =>
        attribute(record, 'nestvexa.error_code') ||
        attribute(record, 'nestvexa.ssr.error_type'),
      requestId,
    ]),
    'No errors recorded.',
  );
  const requests = table(
    'requests',
    'Requests',
    'Requests admitted through requestTracingMiddleware',
    ['Time', 'Method', 'Status', 'Duration', 'Response bytes', 'Request id'],
    spanRows(snapshot.requests, [
      (record) => time(record.at),
      (record) => attribute(record, 'nestvexa.http.method'),
      (record) => attribute(record, 'nestvexa.http.status'),
      (record) => ms(record.milliseconds),
      (record) => attribute(record, 'nestvexa.http.response_bytes'),
      (record) =>
        record.requestId === undefined
          ? ''
          : `<code>${escape(record.requestId)}</code>`,
    ]),
    'No request spans (add requestTracingMiddleware).',
  );
  const hooks = table(
    'hooks',
    'Lifecycle hooks',
    'Component lifecycle hooks that ran (milliseconds)',
    ['Time', 'Component', 'Hook', 'Duration', 'Outcome'],
    spanRows(snapshot.hooks, [
      (record) => time(record.at),
      (record) => attribute(record, 'nestvexa.component'),
      (record) => attribute(record, 'nestvexa.hook'),
      (record) => ms(record.milliseconds),
      outcome,
    ]),
    'No lifecycle hooks recorded.',
  );
  const realtime = table(
    'realtime',
    'Realtime',
    'Subscriptions, connections, publishes and deliveries',
    ['Time', 'Span', 'Transport', 'Channels', 'Channel kind', 'Detail'],
    spanRows(snapshot.realtime, [
      (record) => time(record.at),
      (record) => `<code>${escape(record.name)}</code>`,
      (record) => attribute(record, 'nestvexa.realtime.transport'),
      (record) => attribute(record, 'nestvexa.realtime.channels'),
      (record) => attribute(record, 'nestvexa.realtime.channel_kind'),
      (record) =>
        attribute(record, 'nestvexa.error_code') ||
        attribute(record, 'nestvexa.realtime.close_reason') ||
        attribute(record, 'nestvexa.realtime.payload_bytes'),
    ]),
    'No realtime activity recorded.',
  );
  const jobs = table(
    'jobs',
    'Background jobs',
    'Job runs (milliseconds)',
    ['Time', 'Job', 'Attempt', 'Duration', 'Outcome'],
    spanRows(snapshot.jobs, [
      (record) => time(record.at),
      (record) => attribute(record, 'nestvexa.job'),
      (record) => attribute(record, 'nestvexa.job.attempt'),
      (record) => ms(record.milliseconds),
      outcome,
    ]),
    'No jobs recorded.',
  );
  const renderers = table(
    'renderers',
    'Renderers',
    'Renders by renderer type',
    ['Renderer', 'Count'],
    snapshot.renderers.map(
      (item) =>
        `<tr><th scope="row">${escape(item.renderer)}</th><td>${item.count}</td></tr>`,
    ),
    'No renders recorded.',
  );
  const summary = table(
    'timings',
    'Span timings',
    'Span timings in milliseconds',
    ['Span', 'Count', 'Errors', 'p50', 'p95', 'Max'],
    snapshot.summary.map(
      (item) =>
        `<tr><th scope="row"><code>${escape(item.name)}</code></th><td>${item.count}</td><td>${item.errors}</td><td>${ms(item.p50)}</td><td>${ms(item.p95)}</td><td>${ms(item.max)}</td></tr>`,
    ),
    'No spans recorded yet.',
  );
  const recent = table(
    'spans',
    'Recent spans',
    'Most recent spans with their attributes',
    ['Time', 'Span', 'Outcome', 'Duration', 'Attributes'],
    spanRows(snapshot.spans.slice(0, 50), [
      (record) => time(record.at),
      (record) => `<code>${escape(record.name)}</code>`,
      outcome,
      (record) => ms(record.milliseconds),
      (record) => `<code>${escape(JSON.stringify(record.attributes))}</code>`,
    ]),
    'No spans recorded yet.',
  );
  const sections: readonly [string, string][] = [
    ['components', 'Components'],
    ['renders', 'Renders'],
    ['actions', 'Actions'],
    ['errors', 'Errors'],
    ['requests', 'Requests'],
    ['hooks', 'Hooks'],
    ['realtime', 'Realtime'],
    ['jobs', 'Jobs'],
    ['renderers', 'Renderers'],
    ['timings', 'Timings'],
    ['spans', 'Spans'],
  ];
  const refresh =
    options.refresh === undefined
      ? ''
      : `<meta http-equiv="refresh" content="${options.refresh}">`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh}<title>Nestvexa devtools</title><link rel="icon" href="data:,"><link rel="stylesheet" href="${path}/devtools.css"></head><body><header><h1>Nestvexa devtools <small>(development only)</small></h1><p>Generated ${escape(snapshot.generatedAt)}. ${options.refresh === undefined ? `<a href="${path}?refresh=3">Refresh every 3 seconds</a>` : `<a href="${path}">Stop refreshing</a>`} · <a href="${path}/data.json">data.json</a></p><nav aria-label="Sections"><ul>${sections
    .map(([id, label]) => `<li><a href="#${id}">${label}</a></li>`)
    .join(
      '',
    )}</ul></nav></header><main>${components}${renders}${actions}${errors}${requests}${hooks}${realtime}${jobs}${renderers}${summary}${recent}</main></body></html>`;
}

/** The panel stylesheet (served from the panel path so the CSP needs no inline styles). */
export const devtoolsStylesheet = `:root{color-scheme:light dark;--nv-fg:#1b1b1f;--nv-bg:#ffffff;--nv-muted:#4a4a55;--nv-line:#c9c9d1;--nv-error:#a0001b;--nv-link:#1d4ed8}
@media (prefers-color-scheme:dark){:root{--nv-fg:#ececf1;--nv-bg:#16161a;--nv-muted:#b5b5c0;--nv-line:#3a3a44;--nv-error:#ff8a9a;--nv-link:#93b4ff}}
body{margin:0;padding:1rem;font:14px/1.5 system-ui,sans-serif;color:var(--nv-fg);background:var(--nv-bg)}
a{color:var(--nv-link)}h1{font-size:1.4rem;margin:0 0 .25rem}h2{font-size:1.1rem;margin:1.5rem 0 .5rem}h3{font-size:1rem;margin:0}
small,caption{color:var(--nv-muted)}caption{text-align:start;padding:.25rem 0}
nav ul{display:flex;flex-wrap:wrap;gap:.25rem 1rem;list-style:none;padding:0;margin:.5rem 0}
.nv-scroll{overflow-x:auto}.nv-scroll:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--nv-link);outline-offset:2px}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid var(--nv-line);padding:.25rem .5rem;text-align:start;vertical-align:top}
code,pre{font-family:ui-monospace,monospace;font-size:12px}pre{white-space:pre-wrap;word-break:break-word;margin:.25rem 0}
.nv-error{color:var(--nv-error)}.nv-renders{padding-inline-start:1.25rem}.nv-renders>li{margin-bottom:.75rem}
@media (forced-colors:active){.nv-error{color:Mark}}
`;

/**
 * Development-only panel: registered Live components, redacted public state,
 * re-render causes, actions, lifecycle hooks, errors, requests, realtime,
 * jobs, renderers and span timings recorded by a `MemoryInstrumentation` (and
 * an optional `DevtoolsInspector`). Registration throws in production and
 * every request requires the host `authorize` check. The page runs no script
 * and is served with a `default-src 'none'` Content-Security-Policy.
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
    const explicit = options.environment !== undefined;
    @Controller(path)
    class DevtoolsController {
      constructor(
        @Inject(DEVTOOLS_OPTIONS) private readonly devtools: DevtoolsOptions,
      ) {}
      async #check(request: object): Promise<void> {
        // A process switched to production after registration serves nothing.
        if (!explicit && process.env['NODE_ENV'] === 'production')
          throw new NotFoundException();
        if (!(await this.devtools.authorize(request)))
          throw new ForbiddenException();
      }
      #snapshot(): DevtoolsSnapshot {
        return devtoolsSnapshot(
          this.devtools.instrumentation,
          this.devtools.inspector,
        );
      }
      @Get()
      @Header('Cache-Control', 'no-store')
      @Header('Content-Type', 'text/html; charset=utf-8')
      @Header(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      )
      @Header('X-Content-Type-Options', 'nosniff')
      @Header('Referrer-Policy', 'no-referrer')
      async page(
        @Req() request: object,
        @Query('refresh') refresh: unknown,
      ): Promise<string> {
        await this.#check(request);
        const seconds = typeof refresh === 'string' ? Number(refresh) : NaN;
        return renderDevtools(this.#snapshot(), {
          path,
          ...(Number.isInteger(seconds) && seconds >= 2 && seconds <= 60
            ? { refresh: seconds }
            : {}),
        });
      }
      @Get('devtools.css')
      @Header('Cache-Control', 'no-store')
      @Header('Content-Type', 'text/css; charset=utf-8')
      @Header('X-Content-Type-Options', 'nosniff')
      async stylesheet(@Req() request: object): Promise<string> {
        await this.#check(request);
        return devtoolsStylesheet;
      }
      @Get('data.json')
      @Header('Cache-Control', 'no-store')
      @Header('X-Content-Type-Options', 'nosniff')
      async data(@Req() request: object): Promise<DevtoolsSnapshot> {
        await this.#check(request);
        return this.#snapshot();
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
