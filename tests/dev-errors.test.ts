import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EjsEngine } from '../packages/engine-ejs/dist/index.js';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import { NunjucksEngine } from '../packages/engine-nunjucks/dist/index.js';
import { PugEngine } from '../packages/engine-pug/dist/index.js';
import {
  DevErrorFilter,
  describeError,
  renderDevErrorPage,
  templateFailure,
} from '../packages/observability/dist/index.js';

let root = '';
let views = '';
async function failure(render: () => Promise<string>): Promise<unknown> {
  try {
    await render();
  } catch (error) {
    return error;
  }
  throw new Error('expected the render to fail');
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'nestvexa-dev-errors-'));
  views = path.join(root, 'views');
  await mkdir(path.join(views, 'pages'), { recursive: true });
  await writeFile(
    path.join(views, 'pages', 'broken.hbs'),
    '<h1>{{title}}</h1>\n<p>\n{{title bar=}}\n</p>\n',
  );
  await writeFile(
    path.join(views, 'pages', 'helper.hbs'),
    '<h1>{{title}}</h1>\n{{missing title}}\n',
  );
  await writeFile(
    path.join(views, 'pages', 'broken.ejs'),
    '<h1><%= title %></h1>\n<p><%= nope.value %></p>\n',
  );
  await writeFile(
    path.join(views, 'pages', 'broken.pug'),
    'h1= title\np= nope.value\n',
  );
  await writeFile(
    path.join(views, 'pages', 'broken.njk'),
    '<h1>{{ title }}</h1>\n{% if %}\n',
  );
  await writeFile(path.join(root, 'secret.txt'), 'top secret\n');
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('development error page source locations', () => {
  it('locates Handlebars parse and runtime errors with an excerpt and editor link', async () => {
    const engine = new HbsEngine({ root: views });
    await engine.initialize();
    const parse = describeError(
      await failure(() => engine.render('pages/broken', { title: 'x' })),
      { viewsRoot: views, projectRoot: root },
    );
    expect(parse.template).toMatchObject({
      view: 'pages/broken',
      line: 3,
      display: 'views/pages/broken.hbs:3',
    });
    expect(parse.template?.href).toMatch(
      /^vscode:\/\/file\/.+\/views\/pages\/broken\.hbs:3:1$/,
    );
    expect(parse.template?.excerpt.find((line) => line.current)).toEqual({
      line: 3,
      text: '{{title bar=}}',
      current: true,
    });
    const runtime = describeError(
      await failure(() => engine.render('pages/helper', { title: 'x' })),
      { viewsRoot: views, projectRoot: root, editor: 'idea' },
    );
    // The HBS adapter's debug mode also locates runtime errors (missing helpers).
    expect(runtime.template).toMatchObject({
      view: 'pages/helper',
      display: 'views/pages/helper.hbs:2',
    });
    expect(runtime.template?.excerpt.find((line) => line.current)).toEqual({
      line: 2,
      text: '{{missing title}}',
      current: true,
    });
    expect(runtime.template?.href).toContain('idea://open?file=');
    await engine.dispose();
  });

  it('locates EJS, Pug and Nunjucks failures reported in debug mode', async () => {
    const ejs = new EjsEngine({ root: views, debug: true });
    const pug = new PugEngine({ root: views, debug: true });
    const nunjucks = new NunjucksEngine({ root: views, debug: true });
    for (const engine of [ejs, pug, nunjucks]) await engine.initialize();
    for (const [engine, file] of [
      [ejs, 'broken.ejs'],
      [pug, 'broken.pug'],
      [nunjucks, 'broken.njk'],
    ] as const) {
      const report = describeError(
        await failure(() => engine.render('pages/broken', { title: 'x' })),
        { viewsRoot: views, projectRoot: root, editor: 'file' },
      );
      expect(report.template, file).toMatchObject({
        display: `views/pages/${file}:2`,
      });
      expect(report.template?.href).toMatch(
        new RegExp(`^file:///.+/views/pages/${file.replace('.', '\\.')}#L2$`),
      );
    }
    for (const engine of [ejs, pug, nunjucks]) await engine.dispose();
  });

  it('never reads files outside the views root and escapes everything it prints', () => {
    const escape = new Error(
      'Unable to render view: ../secret.txt (../secret.txt:1)',
    );
    escape.name = 'ViewError';
    expect(templateFailure(escape)).toEqual({
      view: '../secret.txt',
      file: '../secret.txt',
      line: 1,
    });
    const report = describeError(escape, {
      viewsRoot: views,
      projectRoot: root,
    });
    expect(report.template).toBeUndefined();
    const absolute = Object.assign(new Error('Pug failure'), {
      filename: path.join(root, 'secret.txt'),
      line: 1,
    });
    expect(
      describeError(absolute, { viewsRoot: views }).template,
    ).toBeUndefined();
    const html = renderDevErrorPage(
      describeError(new Error('<script>alert(1)</script>'), {
        viewsRoot: views,
      }),
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('top secret');
  });

  it('links application stack frames and leaves dependency frames as text', () => {
    const error = new Error('boom');
    error.stack = [
      'Error: boom',
      `    at handler (${path.join(root, 'src', 'app.controller.ts')}:12:7)`,
      `    at run (${path.join(root, 'node_modules', 'lib', 'index.js')}:1:1)`,
      '    at node:internal/process/task_queues:95:5',
    ].join('\n');
    const report = describeError(error, { projectRoot: root });
    expect(report.frames[0]).toMatchObject({
      display: 'src/app.controller.ts:12:7',
      line: 12,
      column: 7,
    });
    expect(report.frames.slice(1).every((frame) => 'text' in frame)).toBe(true);
  });

  it('refuses to construct in production', () => {
    expect(
      () => new DevErrorFilter(undefined, { environment: 'production' }),
    ).toThrow(/must not be enabled in production/);
    expect(
      () => new DevErrorFilter(undefined, { environment: 'development' }),
    ).not.toThrow();
  });
});
