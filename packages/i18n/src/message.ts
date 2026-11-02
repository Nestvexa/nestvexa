import {
  BoundedCache,
  I18nError,
  escapeHtml,
  forbiddenKeys,
  isPlainObject,
} from './errors.js';
import {
  assertTimeZone,
  formatDateValue,
  formatNumberValue,
  plainNumber,
  pluralCategory,
} from './format.js';
import { canonicalLocale } from './locale.js';

export type MessageParam = string | number | boolean | Date | null | undefined;
export type MessageParams = Readonly<Record<string, MessageParam>>;

type Branching = 'plural' | 'selectordinal' | 'select';
export type MessageNode =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'arg'; readonly name: string }
  | { readonly kind: 'pound' }
  | {
      readonly kind: 'number' | 'date' | 'time';
      readonly name: string;
      readonly style: string | undefined;
    }
  | {
      readonly kind: Branching;
      readonly name: string;
      readonly options: ReadonlyMap<string, readonly MessageNode[]>;
    };

export const maxMessageLength = 8192;
const maxDepth = 8;
const maxOptions = 64;
const identifier = /[A-Za-z_][A-Za-z0-9_]{0,63}/y;
const selectorPattern = /[A-Za-z0-9_-]{1,64}/y;
const exactPattern = /=-?\d{1,15}(?:\.\d{1,6})?/y;
const pluralKeywords: ReadonlySet<string> = new Set([
  'zero',
  'one',
  'two',
  'few',
  'many',
  'other',
]);
const styles: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  number: new Set(['integer', 'percent']),
  date: new Set(['short', 'medium', 'long', 'full']),
  time: new Set(['short', 'medium', 'long', 'full']),
});

class Parser {
  index = 0;
  constructor(readonly source: string) {}
  fail(reason: string): never {
    throw new I18nError(
      'MESSAGE',
      `Invalid message syntax at ${this.index}: ${reason}`,
    );
  }
  whitespace(): void {
    while (/\s/.test(this.source[this.index] ?? '')) this.index++;
  }
  match(pattern: RegExp): string | undefined {
    pattern.lastIndex = this.index;
    const found = pattern.exec(this.source);
    if (!found) return undefined;
    this.index += found[0].length;
    return found[0];
  }
  expect(character: string): void {
    if (this.source[this.index] !== character)
      this.fail(`expected ${character}`);
    this.index++;
  }
  message(depth: number, inPlural: boolean): MessageNode[] {
    const nodes: MessageNode[] = [];
    let text = '';
    const flush = (): void => {
      if (text) nodes.push(Object.freeze({ kind: 'text', value: text }));
      text = '';
    };
    while (this.index < this.source.length) {
      const character = this.source[this.index] ?? '';
      if (character === '{') {
        flush();
        this.index++;
        nodes.push(this.argument(depth, inPlural));
      } else if (character === '}') {
        if (depth === 0) this.fail('unmatched }');
        break;
      } else if (character === '#' && inPlural) {
        flush();
        nodes.push(Object.freeze({ kind: 'pound' }));
        this.index++;
      } else if (character === "'") {
        const next = this.source[this.index + 1];
        if (next === "'") {
          text += "'";
          this.index += 2;
        } else if (
          next === '{' ||
          next === '}' ||
          next === '|' ||
          (next === '#' && inPlural)
        ) {
          // ICU quoting: literal text until the next lone apostrophe (or end).
          this.index++;
          while (this.index < this.source.length) {
            const quoted = this.source[this.index] ?? '';
            if (quoted === "'") {
              if (this.source[this.index + 1] === "'") {
                text += "'";
                this.index += 2;
                continue;
              }
              this.index++;
              break;
            }
            text += quoted;
            this.index++;
          }
        } else {
          text += "'";
          this.index++;
        }
      } else {
        text += character;
        this.index++;
      }
    }
    flush();
    return nodes;
  }
  argument(depth: number, inPlural: boolean): MessageNode {
    if (depth >= maxDepth) this.fail('nesting too deep');
    this.whitespace();
    const name = this.match(identifier);
    if (!name || forbiddenKeys.has(name)) return this.fail('argument name');
    this.whitespace();
    if (this.source[this.index] === '}') {
      this.index++;
      return Object.freeze({ kind: 'arg', name });
    }
    this.expect(',');
    this.whitespace();
    const type = this.match(identifier);
    this.whitespace();
    if (type === 'number' || type === 'date' || type === 'time') {
      let style: string | undefined;
      if (this.source[this.index] === ',') {
        this.index++;
        this.whitespace();
        style = this.match(identifier);
        if (!style || !styles[type]?.has(style)) this.fail('unsupported style');
        this.whitespace();
      }
      this.expect('}');
      return Object.freeze({ kind: type, name, style });
    }
    if (type !== 'plural' && type !== 'selectordinal' && type !== 'select')
      return this.fail('unsupported argument type');
    this.expect(',');
    const options = new Map<string, readonly MessageNode[]>();
    for (;;) {
      this.whitespace();
      if (this.source[this.index] === '}') {
        this.index++;
        break;
      }
      if (options.size >= maxOptions) this.fail('too many options');
      let selector: string | undefined;
      if (type !== 'select' && this.source[this.index] === '=')
        selector = this.match(exactPattern);
      else selector = this.match(selectorPattern);
      if (!selector) return this.fail('selector');
      if (this.source.startsWith(':', this.index))
        this.fail('offset is unsupported');
      if (
        type !== 'select' &&
        !selector.startsWith('=') &&
        !pluralKeywords.has(selector)
      )
        this.fail('unknown plural category');
      if (options.has(selector)) this.fail('duplicate selector');
      this.whitespace();
      this.expect('{');
      const body = this.message(depth + 1, inPlural || type !== 'select');
      this.expect('}');
      options.set(selector, Object.freeze(body));
    }
    if (!options.has('other')) this.fail('missing other option');
    return Object.freeze({ kind: type, name, options });
  }
}

const parsed = new BoundedCache<readonly MessageNode[]>(2048);

/** Parses (and caches) the supported ICU MessageFormat subset. */
export function parseMessage(source: string): readonly MessageNode[] {
  if (typeof source !== 'string' || source.length > maxMessageLength)
    throw new I18nError('MESSAGE', 'Message must be a bounded string');
  const cached = parsed.get(source);
  if (cached) return cached;
  const parser = new Parser(source);
  const nodes = parser.message(0, false);
  if (parser.index !== source.length) parser.fail('trailing input');
  return parsed.set(source, Object.freeze(nodes));
}

interface RenderContext {
  readonly locale: string;
  readonly params: MessageParams | undefined;
  readonly escape: boolean;
  readonly timeZone: string;
}

function param(context: RenderContext, name: string): MessageParam {
  const params = context.params;
  if (params === undefined || params === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(params, name);
  if (!descriptor || !('value' in descriptor)) return undefined;
  const value: unknown = descriptor.value;
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    value instanceof Date
  )
    return value;
  throw new I18nError('MESSAGE', `Unsupported value for argument ${name}`);
}

function text(context: RenderContext, value: MessageParam): string {
  let result: string;
  if (value === null || value === undefined) result = '';
  else if (typeof value === 'number')
    result = plainNumber(context.locale, value);
  else if (value instanceof Date)
    result = formatDateValue(
      context.locale,
      value,
      { dateStyle: 'medium' },
      context.timeZone,
    );
  else result = String(value);
  return context.escape ? escapeHtml(result) : result;
}

function required(context: RenderContext, name: string): MessageParam {
  const value = param(context, name);
  if (value === undefined || value === null)
    throw new I18nError('MESSAGE', `Missing argument ${name}`);
  return value;
}

function render(
  nodes: readonly MessageNode[],
  context: RenderContext,
  pound: number | undefined,
): string {
  let output = '';
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        output += node.value;
        break;
      case 'arg': {
        const value = param(context, node.name);
        // A missing simple argument stays visible as its placeholder.
        output +=
          value === undefined
            ? context.escape
              ? escapeHtml(`{${node.name}}`)
              : `{${node.name}}`
            : text(context, value);
        break;
      }
      case 'pound':
        output +=
          pound === undefined ? '#' : plainNumber(context.locale, pound);
        break;
      case 'number': {
        const value = required(context, node.name);
        if (typeof value !== 'number')
          throw new I18nError(
            'MESSAGE',
            `Argument ${node.name} must be a number`,
          );
        const formatted = formatNumberValue(
          context.locale,
          value,
          node.style === 'percent'
            ? { style: 'percent' }
            : node.style === 'integer'
              ? { maximumFractionDigits: 0 }
              : undefined,
        );
        output += context.escape ? escapeHtml(formatted) : formatted;
        break;
      }
      case 'date':
      case 'time': {
        const value = required(context, node.name);
        if (typeof value === 'boolean')
          throw new I18nError(
            'MESSAGE',
            `Argument ${node.name} must be a date`,
          );
        const formatted = formatDateValue(
          context.locale,
          value,
          node.kind === 'date'
            ? { dateStyle: node.style ?? 'medium' }
            : { timeStyle: node.style ?? 'short' },
          context.timeZone,
        );
        output += context.escape ? escapeHtml(formatted) : formatted;
        break;
      }
      case 'plural':
      case 'selectordinal': {
        const value = required(context, node.name);
        if (typeof value !== 'number')
          throw new I18nError(
            'MESSAGE',
            `Argument ${node.name} must be a number`,
          );
        let branch: readonly MessageNode[] | undefined;
        for (const [selector, body] of node.options)
          if (selector.startsWith('=') && Number(selector.slice(1)) === value) {
            branch = body;
            break;
          }
        branch ??=
          node.options.get(
            pluralCategory(
              context.locale,
              value,
              node.kind === 'plural' ? 'cardinal' : 'ordinal',
            ),
          ) ?? node.options.get('other');
        output += render(branch ?? [], context, value);
        break;
      }
      case 'select': {
        const value = required(context, node.name);
        const key = value instanceof Date ? 'other' : String(value);
        output += render(
          node.options.get(key) ?? node.options.get('other') ?? [],
          context,
          pound,
        );
        break;
      }
    }
  }
  return output;
}

/** Internal renderer shared with the I18n class. */
export function renderMessage(
  source: string,
  locale: string,
  params: MessageParams | undefined,
  escape: boolean,
  timeZone: string,
): string {
  if (params !== undefined && params !== null && !isPlainObject(params))
    throw new I18nError('MESSAGE', 'Message params must be a plain object');
  return render(
    parseMessage(source),
    { locale, params, escape, timeZone },
    undefined,
  );
}

/**
 * Formats one ICU-subset message. Interpolated values are HTML-escaped only when
 * `escape` is true; literal message text is never altered.
 */
export function formatMessage(
  locale: string,
  message: string,
  params?: MessageParams,
  options: { readonly escape?: boolean; readonly timeZone?: string } = {},
): string {
  const canonical = canonicalLocale(locale);
  if (!canonical) throw new I18nError('LOCALE', 'Invalid locale');
  return renderMessage(
    message,
    canonical,
    params,
    options.escape === true,
    assertTimeZone(options.timeZone ?? 'UTC'),
  );
}
