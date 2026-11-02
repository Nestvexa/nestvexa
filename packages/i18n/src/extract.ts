import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { namespacePattern, validSegment } from './catalog.js';
import { I18nError, forbiddenKeys, isPlainObject, own } from './errors.js';
import type { CatalogInput } from './catalog.js';

export interface ExtractedLocation {
  readonly file: string;
  readonly line: number;
  /** `dynamic`: a non-literal key; `invalid`: a literal that is not a valid key. */
  readonly reason: 'dynamic' | 'invalid';
}
export interface ExtractedKeys {
  readonly keys: Readonly<Record<string, readonly string[]>>;
  readonly dynamic: readonly ExtractedLocation[];
}
export interface ExtractOptions {
  readonly defaultNamespace?: string;
  /** Helper/function names; defaults: `t`, `tHtml` (.hbs) and `t`, `html` (.ts). */
  readonly functions?: readonly string[];
}

const nameGrammar = /^[A-Za-z_$][\w$]{0,63}$/;
const maxFiles = 10_000;
const maxFileBytes = 2 * 1024 * 1024;

function escapeRegExp(value: string): string {
  return value.replace(/[$]/g, '\\$');
}

function lineAt(starts: readonly number[], index: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((starts[middle] ?? 0) <= index) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/** Reads a quoted literal at `index`; returns undefined when it is not a plain literal. */
function literal(
  source: string,
  index: number,
  allowEscapes: boolean,
): { readonly value: string; readonly end: number } | undefined {
  const quote = source[index];
  if (quote !== '"' && quote !== "'" && quote !== '`') return undefined;
  if (quote === '`' && !allowEscapes) return undefined;
  let value = '';
  for (let cursor = index + 1; cursor < source.length; cursor++) {
    const character = source[cursor] ?? '';
    if (character === quote) return { value, end: cursor + 1 };
    if (character === '\n' && quote !== '`') return undefined;
    if (quote === '`' && character === '$' && source[cursor + 1] === '{')
      return undefined;
    if (character === '\\' && allowEscapes) {
      // Keys never need escapes; keep the raw pair so validation rejects it.
      value += character + (source[cursor + 1] ?? '');
      cursor++;
      continue;
    }
    value += character;
  }
  return undefined;
}

function whitespace(source: string, index: number): number {
  while (/\s/.test(source[index] ?? '')) index++;
  return index;
}

/** Splits `ns:path` into namespace and path, or undefined when invalid. */
function splitKey(
  key: string,
  defaultNamespace: string,
): { readonly namespace: string; readonly path: string } | undefined {
  if (key.length === 0 || key.length > 256) return undefined;
  const separator = key.indexOf(':');
  const namespace = separator < 0 ? defaultNamespace : key.slice(0, separator);
  const keyPath = separator < 0 ? key : key.slice(separator + 1);
  if (
    !namespacePattern.test(namespace) ||
    forbiddenKeys.has(namespace) ||
    !keyPath.split('.').every(validSegment)
  )
    return undefined;
  return { namespace, path: keyPath };
}

/**
 * Extracts literal translation keys from trusted `.hbs` and `.ts` sources.
 * Output is sorted and independent of input order; non-literal keys are reported.
 */
export function extractKeys(
  sources: readonly { readonly file: string; readonly content: string }[],
  options: ExtractOptions = {},
): ExtractedKeys {
  const defaultNamespace = options.defaultNamespace ?? 'common';
  if (
    !namespacePattern.test(defaultNamespace) ||
    forbiddenKeys.has(defaultNamespace)
  )
    throw new I18nError('CONFIG', 'Invalid defaultNamespace');
  for (const name of options.functions ?? [])
    if (!nameGrammar.test(name))
      throw new I18nError('CONFIG', 'Invalid function name');
  const found = new Map<string, Set<string>>();
  const dynamic: ExtractedLocation[] = [];
  const record = (
    key: string,
    file: string,
    starts: readonly number[],
    index: number,
  ): void => {
    const split = splitKey(key, defaultNamespace);
    if (!split) {
      dynamic.push({ file, line: lineAt(starts, index), reason: 'invalid' });
      return;
    }
    let set = found.get(split.namespace);
    if (!set) found.set(split.namespace, (set = new Set()));
    set.add(split.path);
  };
  for (const { file: rawFile, content } of sources) {
    if (typeof rawFile !== 'string' || typeof content !== 'string')
      throw new I18nError(
        'CONFIG',
        'Sources must be { file, content } strings',
      );
    const file = rawFile.replaceAll('\\', '/');
    const starts = [0];
    for (let index = 0; index < content.length; index++)
      if (content[index] === '\n') starts.push(index + 1);
    const template = file.endsWith('.hbs');
    const names =
      options.functions ?? (template ? ['t', 'tHtml'] : ['t', 'html']);
    if (!names.length) continue;
    const alternatives = names.map(escapeRegExp).join('|');
    if (template) {
      const pattern = new RegExp(
        `(?:\\{\\{~?\\s*|\\(\\s*)(?:${alternatives})(?=\\s)`,
        'g',
      );
      for (const match of content.matchAll(pattern)) {
        const start = whitespace(content, match.index + match[0].length);
        const value = literal(content, start, false);
        if (value) record(value.value, file, starts, match.index);
        else
          dynamic.push({
            file,
            line: lineAt(starts, match.index),
            reason: 'dynamic',
          });
      }
      continue;
    }
    const pattern = new RegExp(`(?<![\\w$])(?:${alternatives})\\s*\\(`, 'g');
    for (const match of content.matchAll(pattern)) {
      const before = content.slice(Math.max(0, match.index - 16), match.index);
      if (/\bfunction\s*$/.test(before)) continue;
      let cursor = whitespace(content, match.index + match[0].length);
      const rest = content.slice(cursor, cursor + 256);
      // Typed parameters mean this is a declaration, not a call.
      if (/^[A-Za-z_$][\w$]*\??\s*:/.test(rest) || rest.startsWith(')'))
        continue;
      let value = literal(content, cursor, true);
      if (value) {
        // `i18n.t('ar', 'ns:key')`: the first literal is the locale.
        const next = whitespace(content, value.end);
        if (content[next] === ',') {
          const second = literal(content, whitespace(content, next + 1), true);
          if (second) value = second;
        }
      } else {
        const receiver = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*,\s*/.exec(
          rest,
        );
        if (receiver) {
          cursor += receiver[0].length;
          value = literal(content, cursor, true);
        }
      }
      if (value) record(value.value, file, starts, match.index);
      else
        dynamic.push({
          file,
          line: lineAt(starts, match.index),
          reason: 'dynamic',
        });
    }
  }
  const keys: Record<string, readonly string[]> = Object.create(null) as Record<
    string,
    readonly string[]
  >;
  for (const namespace of [...found.keys()].sort(compare))
    keys[namespace] = Object.freeze(
      [...(found.get(namespace) ?? [])].sort(compare),
    );
  dynamic.sort(
    (a, b) =>
      compare(a.file, b.file) || a.line - b.line || compare(a.reason, b.reason),
  );
  return Object.freeze({
    keys: Object.freeze(keys),
    dynamic: Object.freeze(dynamic.map((entry) => Object.freeze(entry))),
  });
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Walks `root` in sorted order, skipping symlinks, node_modules, dist and dot-directories. */
export async function extractFromDirectory(
  root: string,
  options: {
    readonly extensions?: readonly string[];
    readonly defaultNamespace?: string;
    readonly functions?: readonly string[];
  } = {},
): Promise<ExtractedKeys> {
  const extensions = options.extensions ?? ['.hbs', '.ts'];
  const base = path.resolve(root);
  const sources: { file: string; content: string }[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (a, b) => compare(a.name, b.name),
    );
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (
          ['node_modules', 'dist'].includes(entry.name) ||
          entry.name.startsWith('.')
        )
          continue;
        await walk(full);
      } else if (
        entry.isFile() &&
        !entry.name.endsWith('.d.ts') &&
        extensions.some((extension) => entry.name.endsWith(extension))
      ) {
        if (sources.length >= maxFiles)
          throw new I18nError('CONFIG', 'Too many source files to extract');
        const info = await lstat(full);
        if (info.size > maxFileBytes)
          throw new I18nError('CONFIG', 'Source file is too large to extract');
        sources.push({
          file: path.relative(base, full).split(path.sep).join('/'),
          content: await readFile(full, 'utf8'),
        });
      }
    }
  };
  await walk(base);
  return extractKeys(sources, {
    ...(options.defaultNamespace === undefined
      ? {}
      : { defaultNamespace: options.defaultNamespace }),
    ...(options.functions === undefined
      ? {}
      : { functions: options.functions }),
  });
}

function hasMessage(tree: unknown, keyPath: string): boolean {
  let node: unknown = tree;
  for (const segment of keyPath.split('.')) {
    if (!isPlainObject(node)) return false;
    node = own(node, segment);
  }
  return typeof node === 'string';
}

/** Full `ns:path` keys absent from each listed locale's catalog (no fallback applied). */
export function missingKeys(
  extracted: ExtractedKeys,
  catalogs: CatalogInput,
  locales: readonly string[],
): Readonly<Record<string, readonly string[]>> {
  const result: Record<string, readonly string[]> = Object.create(
    null,
  ) as Record<string, readonly string[]>;
  for (const locale of [...locales].sort(compare)) {
    const catalog = own(catalogs, locale);
    const missing: string[] = [];
    for (const namespace of Object.keys(extracted.keys).sort(compare))
      for (const keyPath of extracted.keys[namespace] ?? [])
        if (!hasMessage(own(catalog, namespace), keyPath))
          missing.push(`${namespace}:${keyPath}`);
    result[locale] = Object.freeze(missing);
  }
  return Object.freeze(result);
}

/** Stable JSON with a trailing newline; no timestamps or absolute paths. */
export function serializeKeys(
  extracted: ExtractedKeys,
  missing?: Readonly<Record<string, readonly string[]>>,
): string {
  const keys: Record<string, readonly string[]> = {};
  for (const namespace of Object.keys(extracted.keys).sort(compare))
    keys[namespace] = extracted.keys[namespace] ?? [];
  return (
    JSON.stringify(
      {
        keys,
        dynamic: extracted.dynamic.map(({ file, line, reason }) => ({
          file,
          line,
          reason,
        })),
        ...(missing === undefined ? {} : { missing }),
      },
      null,
      2,
    ) + '\n'
  );
}
