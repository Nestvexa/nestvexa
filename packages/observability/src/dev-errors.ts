import { Catch, HttpException } from '@nestjs/common';
import type { ArgumentsHost, HttpServer } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** How source locations become links on the development error page. */
export type DevErrorEditor = 'vscode' | 'cursor' | 'idea' | 'file';
export interface DevErrorOptions {
  /** Template root (the Nestvexa `views.root`); enables template locations and excerpts. */
  readonly viewsRoot?: string;
  /** Stack frames under this directory (outside node_modules) are linked. Default `process.cwd()`. */
  readonly projectRoot?: string;
  /** Default `vscode` (`vscode://file/<path>:<line>:<column>`). */
  readonly editor?: DevErrorEditor;
  /** Defaults to `process.env.NODE_ENV`; construction is refused in production. */
  readonly environment?: string;
}
export interface SourceLocation {
  /** Absolute path. */
  readonly file: string;
  readonly line: number;
  readonly column?: number;
  /** `relative/path:line[:column]` shown as link text. */
  readonly display: string;
  readonly href: string;
}
export interface TemplateLocation extends SourceLocation {
  /** View id as the engine reported it (for example `pages/home`). */
  readonly view: string;
  readonly excerpt: readonly {
    readonly line: number;
    readonly text: string;
    readonly current: boolean;
  }[];
}
export interface DevErrorReport {
  readonly name: string;
  readonly message: string;
  readonly causes: readonly {
    readonly name: string;
    readonly message: string;
  }[];
  readonly template?: TemplateLocation;
  /** Application frames (linked) and other frames (text only), innermost first. */
  readonly frames: readonly (SourceLocation | { readonly text: string })[];
}

const templateExtensions = ['', '.hbs', '.ejs', '.pug', '.njk'];
const maxExcerptBytes = 1024 * 1024;

function errors(error: unknown): Error[] {
  const chain: Error[] = [];
  let current: unknown = error;
  while (current instanceof Error && chain.length < 10) {
    if (chain.includes(current)) break;
    chain.push(current);
    current = current.cause;
  }
  return chain;
}
function numberProperty(value: object, name: string): number | undefined {
  const found: unknown = Reflect.get(value, name);
  return typeof found === 'number' && Number.isSafeInteger(found) && found > 0
    ? found
    : undefined;
}
function editorLink(
  editor: DevErrorEditor,
  file: string,
  line: number,
  column = 1,
): string {
  const path = file.replaceAll('\\', '/');
  if (editor === 'file') return `${pathToFileURL(file).href}#L${line}`;
  if (editor === 'idea')
    return `idea://open?file=${encodeURIComponent(file)}&line=${line}`;
  return `${editor}://file/${path.startsWith('/') ? path.slice(1) : path}:${line}:${column}`;
}
function location(
  file: string,
  line: number,
  column: number | undefined,
  root: string,
  editor: DevErrorEditor,
): SourceLocation {
  const local = relative(root, file).replaceAll('\\', '/');
  const shown = local && !local.startsWith('..') ? local : file;
  return {
    file,
    line,
    ...(column === undefined ? {} : { column }),
    display: `${shown}:${line}${column === undefined ? '' : `:${column}`}`,
    href: editorLink(editor, file, line, column),
  };
}
/** Resolve a view id to an existing file inside `root` (symlink escapes refused). */
function viewFile(root: string, view: string): string | undefined {
  let base: string;
  try {
    base = realpathSync(root);
  } catch {
    return undefined;
  }
  const candidates = isAbsolute(view)
    ? [view]
    : templateExtensions.map((extension) =>
        resolve(base, `${view}${extension}`),
      );
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
      const real = realpathSync(candidate);
      const local = relative(base, real);
      if (local && !local.startsWith('..') && !isAbsolute(local)) return real;
    } catch {
      // Unreadable candidates are skipped.
    }
  }
  return undefined;
}
/** View id and 1-based line of a template failure, from any first-party engine. */
export function templateFailure(
  error: unknown,
): { view: string; line?: number; column?: number } | undefined {
  let view: string | undefined;
  let line: number | undefined;
  let column: number | undefined;
  for (const item of errors(error)) {
    if (item.name === 'ViewError') {
      // Engines in debug mode: "Unable to render view: <view> (<template>:<line>)".
      const located = /\(([^()\s]+):(\d+)\)\s*$/.exec(item.message);
      if (located?.[1] && located[2])
        return { view: located[1], line: Number(located[2]) };
      view ??= /^Unable to render view: ([^\s(]+)/.exec(item.message)?.[1];
      continue;
    }
    // Handlebars exceptions and parse errors.
    line ??= numberProperty(item, 'lineNumber');
    if (line !== undefined) column ??= numberProperty(item, 'column');
    line ??=
      Number(/Parse error on line (\d+)/.exec(item.message)?.[1]) || undefined;
    // Pug errors carry the absolute filename and line.
    const filename: unknown = Reflect.get(item, 'filename');
    const pugLine = numberProperty(item, 'line');
    if (typeof filename === 'string' && pugLine !== undefined)
      return { view: filename, line: pugLine };
  }
  if (view === undefined) return undefined;
  return {
    view,
    ...(line === undefined ? {} : { line }),
    // Handlebars columns are 0-based.
    ...(column === undefined ? {} : { column: column + 1 }),
  };
}
function excerpt(file: string, line: number): TemplateLocation['excerpt'] {
  try {
    if (statSync(file).size > maxExcerptBytes) return [];
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    const first = Math.max(1, line - 3);
    const last = Math.min(lines.length, line + 3);
    const out: { line: number; text: string; current: boolean }[] = [];
    for (let number = first; number <= last; number++)
      out.push({
        line: number,
        text: lines[number - 1] ?? '',
        current: number === line,
      });
    return out;
  } catch {
    return [];
  }
}
function frames(
  stack: string | undefined,
  root: string,
  editor: DevErrorEditor,
): DevErrorReport['frames'] {
  const out: (SourceLocation | { text: string })[] = [];
  for (const raw of (stack ?? '').split('\n').slice(1, 31)) {
    const text = raw.trim();
    if (!text.startsWith('at ')) continue;
    const match = /\(?((?:file:\/\/)?[^()\s]+?):(\d+):(\d+)\)?$/.exec(text);
    let file = match?.[1];
    if (file?.startsWith('file://'))
      try {
        file = fileURLToPath(file);
      } catch {
        file = undefined;
      }
    const local = file ? relative(root, file) : '..';
    if (
      !file ||
      !match?.[2] ||
      !isAbsolute(file) ||
      local.startsWith('..') ||
      local.split(/[\\/]/).includes('node_modules')
    ) {
      out.push({ text });
      continue;
    }
    out.push(location(file, Number(match[2]), Number(match[3]), root, editor));
  }
  return out;
}
/** Structured description of an error for the development page. */
export function describeError(
  error: unknown,
  options: DevErrorOptions = {},
): DevErrorReport {
  const root = resolve(options.projectRoot ?? process.cwd());
  const editor = options.editor ?? 'vscode';
  const chain = errors(error);
  const first = chain[0];
  const failure = templateFailure(error);
  let template: TemplateLocation | undefined;
  if (failure && options.viewsRoot) {
    const file = viewFile(options.viewsRoot, failure.view);
    if (file) {
      const line = failure.line ?? 1;
      const found = location(file, line, failure.column, root, editor);
      template = {
        ...found,
        // Without a reported line the link opens the file; the text names only the file.
        ...(failure.line === undefined
          ? { display: found.display.replace(/:\d+(?::\d+)?$/, '') }
          : {}),
        view: failure.view,
        excerpt: failure.line === undefined ? [] : excerpt(file, line),
      };
    }
  }
  return {
    name: first?.name ?? 'Error',
    message: first?.message ?? String(error),
    causes: chain
      .slice(1)
      .map((item) => ({ name: item.name, message: item.message })),
    ...(template ? { template } : {}),
    frames: frames(first?.stack, root, editor),
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
function link(source: SourceLocation): string {
  return `<a href="${escape(source.href)}"><code>${escape(source.display)}</code></a>`;
}
export function renderDevErrorPage(report: DevErrorReport): string {
  const template = report.template
    ? `<section aria-labelledby="nv-template"><h2 id="nv-template">Template</h2><p>${link(report.template)} (view <code>${escape(report.template.view)}</code>)</p>${
        report.template.excerpt.length
          ? `<pre><code>${report.template.excerpt
              .map(
                (line) =>
                  `${line.current ? '<mark>' : ''}${String(line.line).padStart(4)} | ${escape(line.text)}${line.current ? '</mark>' : ''}`,
              )
              .join('\n')}</code></pre>`
          : ''
      }</section>`
    : '';
  const causes = report.causes.length
    ? `<h2>Caused by</h2><ol>${report.causes
        .map(
          (cause) =>
            `<li><strong>${escape(cause.name)}</strong>: ${escape(cause.message)}</li>`,
        )
        .join('')}</ol>`
    : '';
  const stack = report.frames.length
    ? `<h2>Stack</h2><ol class="frames">${report.frames
        .map((frame) =>
          'href' in frame
            ? `<li>${link(frame)}</li>`
            : `<li><small>${escape(frame.text)}</small></li>`,
        )
        .join('')}</ol>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(report.name)} · Nestvexa development error</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:2rem;max-width:72rem}pre{background:#f4f4f5;padding:1rem;overflow:auto}mark{background:#fde68a}.frames small{color:#52525b}</style></head><body><main><p>Development only. Nothing on this page is sent in production.</p><h1>${escape(report.name)}</h1><p>${escape(report.message)}</p>${template}${causes}${stack}</main></body></html>`;
}

function accepts(host: ArgumentsHost): boolean {
  const request: unknown = host.switchToHttp().getRequest();
  const headers: unknown =
    request && typeof request === 'object'
      ? Reflect.get(request, 'headers')
      : undefined;
  const accept: unknown =
    headers && typeof headers === 'object'
      ? Reflect.get(headers, 'accept')
      : undefined;
  return typeof accept === 'string' && accept.includes('text/html');
}

/**
 * Development-only catch-all filter. Server errors on HTML requests render a
 * page with the message, cause chain, the template `file:line` with an excerpt
 * and clickable editor links; everything else (HTTP exceptions, JSON clients,
 * non-HTTP contexts) keeps Nest's default handling. Construction throws in
 * production so it cannot be enabled there by mistake.
 */
@Catch()
export class DevErrorFilter extends BaseExceptionFilter {
  readonly #options: DevErrorOptions;
  readonly #server: HttpServer | undefined;
  constructor(applicationRef?: HttpServer, options: DevErrorOptions = {}) {
    super(applicationRef);
    const environment =
      options.environment ?? process.env['NODE_ENV'] ?? 'development';
    if (environment === 'production')
      throw new Error(
        'The Nestvexa development error page must not be enabled in production',
      );
    this.#options = options;
    this.#server = applicationRef;
  }
  override catch(exception: unknown, host: ArgumentsHost): void {
    const server = this.#server ?? this.httpAdapterHost?.httpAdapter;
    if (
      !server ||
      host.getType() !== 'http' ||
      exception instanceof HttpException ||
      !accepts(host)
    ) {
      super.catch(exception, host);
      return;
    }
    const response: unknown = host.switchToHttp().getResponse();
    if (server.isHeadersSent(response)) {
      server.end(response);
      return;
    }
    const html = renderDevErrorPage(describeError(exception, this.#options));
    server.setHeader(response, 'Content-Type', 'text/html; charset=utf-8');
    server.setHeader(response, 'Cache-Control', 'no-store');
    server.setHeader(
      response,
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    server.reply(response, html, 500);
  }
}
