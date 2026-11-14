import { ForbiddenException } from '@nestjs/common';
import type {
  ArgumentsHost,
  ExecutionContext,
  HttpServer,
} from '@nestjs/common';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DevErrorFilter,
  describeError,
  renderDevErrorPage,
  templateFailure,
} from '../packages/observability/src/dev-errors.js';
import { traceGuard } from '../packages/observability/src/guard.js';
import type {
  LiveInstrumentation,
  LiveSpan,
} from '../packages/observability/src/instrumentation.js';

// Source-level tests for the development error page and the guard span
// wrapper. tests/dev-errors.test.ts and tests/observability-*.test.ts drive
// the same code through real Nest apps and the built package.

const root = mkdtempSync(join(tmpdir(), 'nv-dev-errors-'));
const views = join(root, 'views');
mkdirSync(join(views, 'pages'), { recursive: true });
writeFileSync(
  join(views, 'pages', 'home.hbs'),
  [
    '<h1>{{title}}</h1>',
    '<p>',
    '{{#each items}}',
    '  {{broken',
    '{{/each}}',
    '</p>',
    '<footer>',
    '</footer>',
  ].join('\n'),
);
writeFileSync(join(root, 'outside.hbs'), 'secret');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const named = (
  name: string,
  message: string,
  extra: Record<string, unknown> = {},
) => Object.assign(Object.assign(new Error(message), { name }), extra);

describe('templateFailure', () => {
  it('reads the engine-reported template file and line from a ViewError', () => {
    expect(
      templateFailure(
        named(
          'ViewError',
          'Unable to render view: pages/home (pages/home.hbs:4)',
        ),
      ),
    ).toEqual({ view: 'pages/home', file: 'pages/home.hbs', line: 4 });
  });

  it('combines the view id with Handlebars line and 0-based column from the cause', () => {
    const cause = named('Error', 'bad', { lineNumber: 4, column: 2 });
    const error = named('ViewError', 'Unable to render view: pages/home', {
      cause,
    });
    expect(templateFailure(error)).toEqual({
      view: 'pages/home',
      line: 4,
      column: 3,
    });
  });

  it('parses Handlebars parse errors and ignores invalid numbers', () => {
    const cause = named('Error', 'Parse error on line 7:\n...', {
      lineNumber: -1,
    });
    expect(
      templateFailure(
        named('ViewError', 'Unable to render view: a', { cause }),
      ),
    ).toEqual({ view: 'a', line: 7 });
    expect(
      templateFailure(named('ViewError', 'Unable to render view: a')),
    ).toEqual({
      view: 'a',
    });
  });

  it('returns Pug filename and line directly', () => {
    expect(
      templateFailure(named('Error', 'pug', { filename: '/v/x.pug', line: 3 })),
    ).toEqual({
      view: '/v/x.pug',
      line: 3,
    });
  });

  it('returns undefined without a view and stops on cause cycles', () => {
    expect(templateFailure(new Error('plain'))).toBeUndefined();
    expect(templateFailure('not an error')).toBeUndefined();
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    Object.assign(a, { cause: b });
    expect(templateFailure(a)).toBeUndefined();
  });
});

describe('describeError', () => {
  const failure = (message: string, cause?: Error) =>
    named('ViewError', message, cause ? { cause } : {});

  it('locates the template with an excerpt and a vscode link', () => {
    const report = describeError(
      failure('Unable to render view: pages/home (pages/home.hbs:4)'),
      {
        viewsRoot: views,
        projectRoot: root,
      },
    );
    expect(report.template?.display).toBe('views/pages/home.hbs:4');
    expect(report.template?.href).toMatch(/^vscode:\/\/file\/.+home\.hbs:4:1$/);
    expect(report.template?.excerpt.map((line) => line.line)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(report.template?.excerpt.find((line) => line.current)?.text).toBe(
      '  {{broken',
    );
  });

  it.each([
    ['cursor', /^cursor:\/\//],
    ['idea', /^idea:\/\/open\?file=.+&line=4$/],
    ['file', /^file:\/\/.+#L4$/],
  ] as const)('links %s editors', (editor, pattern) => {
    const report = describeError(
      failure('Unable to render view: pages/home (pages/home.hbs:4)'),
      {
        viewsRoot: views,
        projectRoot: root,
        editor,
      },
    );
    expect(report.template?.href).toMatch(pattern);
  });

  it('opens the file without a line or excerpt when the engine reported none', () => {
    const report = describeError(failure('Unable to render view: pages/home'), {
      viewsRoot: views,
      projectRoot: join(root, 'elsewhere'),
    });
    expect(report.template?.excerpt).toEqual([]);
    expect(report.template?.display).not.toMatch(/:\d+$/);
    // Outside the project root the absolute path is shown.
    expect(report.template?.display).toContain('home.hbs');
  });

  it('refuses missing roots, unknown views and paths outside the views root', () => {
    const missing = describeError(
      failure('Unable to render view: pages/home'),
      {
        viewsRoot: join(root, 'missing'),
      },
    );
    expect(missing.template).toBeUndefined();
    expect(
      describeError(failure('Unable to render view: nope'), {
        viewsRoot: views,
      }).template,
    ).toBeUndefined();
    expect(
      describeError(failure('Unable to render view: ../outside'), {
        viewsRoot: views,
      }).template,
    ).toBeUndefined();
    expect(
      describeError(
        named('Error', 'pug', { filename: join(root, 'outside.hbs'), line: 1 }),
        {
          viewsRoot: views,
        },
      ).template,
    ).toBeUndefined();
  });

  it('links application frames and keeps node_modules, foreign and malformed frames as text', () => {
    const error = new Error('boom', { cause: new TypeError('inner') });
    error.stack = [
      'Error: boom',
      `    at handler (${join(root, 'src', 'app.ts')}:10:5)`,
      `    at ${pathToFileURL(join(root, 'src', 'b.ts')).href}:3:1`,
      `    at lib (${join(root, 'node_modules', 'x', 'i.js')}:1:1)`,
      '    at elsewhere (/other/place.js:1:1)',
      '    at native',
      '    not a frame',
    ].join('\n');
    const report = describeError(error, { projectRoot: root });
    expect(report.causes).toEqual([{ name: 'TypeError', message: 'inner' }]);
    expect(report.frames).toHaveLength(5);
    expect(report.frames[0]).toMatchObject({
      display: 'src/app.ts:10:5',
      line: 10,
      column: 5,
    });
    expect(report.frames[1]).toMatchObject({ display: 'src/b.ts:3:1' });
    expect(report.frames.slice(2).every((frame) => 'text' in frame)).toBe(true);
  });

  it('describes non-errors by their string form', () => {
    expect(describeError('plain text')).toMatchObject({
      name: 'Error',
      message: 'plain text',
      frames: [],
    });
  });
});

describe('renderDevErrorPage', () => {
  it('escapes every field and renders the template, causes and stack sections', () => {
    const html = renderDevErrorPage({
      name: '<Name>',
      message: `"quote" & 'apostrophe'`,
      causes: [{ name: 'Inner', message: '<b>cause</b>' }],
      template: {
        file: '/v/a.hbs',
        line: 2,
        display: 'a.hbs:2',
        href: 'vscode://file/v/a.hbs:2:1',
        view: '<view>',
        excerpt: [
          { line: 1, text: '<a>', current: false },
          { line: 2, text: '{{x}}', current: true },
        ],
      },
      frames: [
        {
          file: '/p/a.ts',
          line: 1,
          display: 'a.ts:1',
          href: 'vscode://file/p/a.ts:1:1',
        },
        { text: 'at <native>' },
      ],
    });
    expect(html).toContain('<h1>&lt;Name&gt;</h1>');
    expect(html).toContain('&quot;quote&quot; &amp; &#39;apostrophe&#39;');
    expect(html).toContain('&lt;b&gt;cause&lt;/b&gt;');
    expect(html).toContain('<mark>   2 | {{x}}</mark>');
    expect(html).toContain('   1 | &lt;a&gt;');
    expect(html).toContain('<code>&lt;view&gt;</code>');
    expect(html).toContain('<small>at &lt;native&gt;</small>');
    expect(html).not.toContain('<b>cause</b>');
  });

  it('omits empty sections', () => {
    const html = renderDevErrorPage({
      name: 'E',
      message: 'm',
      causes: [],
      frames: [],
    });
    expect(html).not.toContain('Caused by');
    expect(html).not.toContain('Stack');
    expect(html).not.toContain('Template');
    const template = renderDevErrorPage({
      name: 'E',
      message: 'm',
      causes: [],
      frames: [],
      template: {
        file: '/a',
        line: 1,
        display: 'a',
        href: 'h',
        view: 'v',
        excerpt: [],
      },
    });
    expect(template).toContain('Template');
    expect(template).not.toContain('<pre>');
  });
});

describe('DevErrorFilter', () => {
  function server(sent = false) {
    const calls: unknown[][] = [];
    const adapter = {
      isHeadersSent: () => sent,
      end: () => calls.push(['end']),
      setHeader: (_: unknown, name: string, value: string) =>
        calls.push(['header', name, value]),
      reply: (_: unknown, body: unknown, status: number) =>
        calls.push(['reply', status, body]),
    };
    return { adapter: adapter as unknown as HttpServer, calls };
  }
  const host = (accept: unknown, type = 'http') =>
    ({
      getType: () => type,
      switchToHttp: () => ({
        getRequest: () => ({ headers: { accept } }),
        getResponse: () => ({}),
      }),
    }) as unknown as ArgumentsHost;

  it('refuses construction in production', () => {
    expect(
      () => new DevErrorFilter(undefined, { environment: 'production' }),
    ).toThrow('must not be enabled in production');
  });

  it('renders an uncached, CSP-locked HTML page for HTML requests', () => {
    const { adapter, calls } = server();
    new DevErrorFilter(adapter, { environment: 'test' }).catch(
      new Error('<boom>'),
      host('text/html'),
    );
    expect(calls).toContainEqual(['header', 'Cache-Control', 'no-store']);
    expect(calls).toContainEqual([
      'header',
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'",
    ]);
    const reply = calls.find((call) => call[0] === 'reply');
    expect(reply?.[1]).toBe(500);
    expect(String(reply?.[2])).toContain('&lt;boom&gt;');
  });

  it('ends the response when headers were already sent', () => {
    const { adapter, calls } = server(true);
    new DevErrorFilter(adapter, { environment: 'test' }).catch(
      new Error('x'),
      host('text/html'),
    );
    expect(calls).toEqual([['end']]);
  });

  it.each([
    ['a JSON client', host('application/json'), new Error('x')],
    ['a request without headers', host(undefined), new Error('x')],
    ['an HTTP exception', host('text/html'), new ForbiddenException()],
    ['a non-HTTP context', host('text/html', 'rpc'), new Error('x')],
  ])('defers %s to the default Nest handling', (_, context, exception) => {
    const { adapter, calls } = server();
    const filter = new DevErrorFilter(adapter, { environment: 'test' });
    // The base filter needs a full HTTP adapter; reaching it proves deferral.
    expect(() => filter.catch(exception, context)).toThrow();
    expect(
      calls.some(
        (call) => call[0] === 'reply' && String(call[2]).includes('doctype'),
      ),
    ).toBe(false);
  });
});

describe('traceGuard', () => {
  const context = { getType: () => 'http' } as unknown as ExecutionContext;
  function recorder(failStart = false, failEnd = false) {
    const spans: {
      name: string;
      attributes: unknown;
      ended?: [string, unknown];
    }[] = [];
    const instrumentation = {
      start(name: string, attributes: unknown): LiveSpan {
        if (failStart) throw new Error('exporter down');
        const span = { name, attributes } as (typeof spans)[number];
        spans.push(span);
        return {
          end(outcome: string, extra: unknown) {
            if (failEnd) throw new Error('exporter down');
            span.ended = [outcome, extra];
          },
        } as LiveSpan;
      },
    } as unknown as LiveInstrumentation;
    return { instrumentation, spans };
  }
  class SessionGuard {
    constructor(private readonly result: unknown) {}
    canActivate(): unknown {
      if (this.result instanceof Error) throw this.result;
      return this.result;
    }
  }
  const observable = (
    emit: (observer: {
      next(v: unknown): void;
      error(e: unknown): void;
      complete(): void;
    }) => void,
  ) => ({
    subscribe(observer: {
      next(v: unknown): void;
      error(e: unknown): void;
      complete(): void;
    }) {
      emit(observer);
      return { unsubscribe: () => undefined };
    },
  });

  it('validates its inputs and the span name', () => {
    const { instrumentation } = recorder();
    expect(() => traceGuard({} as never, instrumentation)).toThrow(
      'canActivate',
    );
    expect(() =>
      traceGuard(new SessionGuard(true) as never, {} as never),
    ).toThrow('start()');
    expect(() =>
      traceGuard(new SessionGuard(true) as never, instrumentation, 'bad name'),
    ).toThrow('Invalid guard span name');
  });

  it.each([
    [true, true],
    [0, false],
    [Promise.resolve('yes'), true],
  ])('records the decision for %j', async (result, allowed) => {
    const { instrumentation, spans } = recorder();
    const guard = traceGuard(
      new SessionGuard(result) as never,
      instrumentation,
    );
    expect(await guard.canActivate(context)).toBe(allowed);
    expect(spans[0]).toMatchObject({
      name: 'nestvexa.guard',
      attributes: {
        'nestvexa.guard': 'SessionGuard',
        'nestvexa.guard.context': 'http',
      },
      ended: ['ok', { 'nestvexa.guard.allowed': allowed }],
    });
  });

  it('takes the first value of an observable decision, false when it completes empty', async () => {
    const { instrumentation } = recorder();
    const twice = traceGuard(
      new SessionGuard(
        observable((o) => {
          o.next(true);
          o.next(false);
          o.error(new Error('late'));
        }),
      ) as never,
      instrumentation,
    );
    expect(await twice.canActivate(context)).toBe(true);
    const empty = traceGuard(
      new SessionGuard(
        observable((o) => {
          o.complete();
          o.complete();
        }),
      ) as never,
      instrumentation,
    );
    expect(await empty.canActivate(context)).toBe(false);
    const failing = traceGuard(
      new SessionGuard(
        observable((o) => o.error(new Error('denied'))),
      ) as never,
      instrumentation,
    );
    await expect(failing.canActivate(context)).rejects.toThrow('denied');
  });

  it('records HTTP status for thrown HTTP exceptions and rethrows everything', async () => {
    const { instrumentation, spans } = recorder();
    await expect(
      traceGuard(
        new SessionGuard(new ForbiddenException()) as never,
        instrumentation,
        'Named',
      ).canActivate(context),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(spans[0]?.ended).toEqual([
      'error',
      { 'nestvexa.guard.allowed': false, status: 403 },
    ]);
    await expect(
      traceGuard(
        new SessionGuard(new Error('x')) as never,
        instrumentation,
      ).canActivate(context),
    ).rejects.toThrow('x');
    expect(spans[1]?.ended).toEqual([
      'error',
      { 'nestvexa.guard.allowed': false },
    ]);
  });

  it('treats telemetry failures as best effort and names anonymous guards', async () => {
    const anonymous = { canActivate: () => true };
    for (const [failStart, failEnd] of [
      [true, false],
      [false, true],
    ] as const) {
      const { instrumentation, spans } = recorder(failStart, failEnd);
      expect(
        await traceGuard(
          Object.create(anonymous) as never,
          instrumentation,
        ).canActivate(context),
      ).toBe(true);
      if (!failStart)
        expect(spans[0]?.attributes).toMatchObject({
          'nestvexa.guard': 'Object',
        });
    }
    const { instrumentation, spans } = recorder();
    await traceGuard(
      Object.assign(Object.create(null) as object, anonymous) as never,
      instrumentation,
    ).canActivate(context);
    expect(spans[0]?.attributes).toMatchObject({
      'nestvexa.guard': 'anonymous',
    });
  });
});
