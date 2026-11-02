import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { I18nError, forbiddenKeys, isPlainObject } from './errors.js';
import { canonicalLocale } from './locale.js';
import { maxMessageLength, parseMessage } from './message.js';

export type CatalogInput = Readonly<
  Record<string, Readonly<Record<string, unknown>>>
>;

export const namespacePattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const segmentPattern = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;
const maxDepth = 16;
export const catalogLimits = Object.freeze({
  entries: 100_000,
  bytes: 8 * 1024 * 1024,
  fileBytes: 1024 * 1024,
});

export interface CatalogBudget {
  entries: number;
  bytes: number;
}

/** Validates a key path segment used in `ns:a.b.c` keys. */
export function validSegment(value: string): boolean {
  return segmentPattern.test(value) && !forbiddenKeys.has(value);
}

/**
 * Validates one namespace tree and flattens it into `ns:a.b` -> message. Accessors,
 * symbols, non-plain objects, prototype keys, arrays and non-string leaves fail.
 * Every message is parsed so syntax errors surface at startup.
 */
export function flattenNamespace(
  namespace: string,
  tree: unknown,
  into: Map<string, string>,
  budget: CatalogBudget,
): void {
  if (!namespacePattern.test(namespace) || forbiddenKeys.has(namespace))
    throw new I18nError('CATALOG', 'Invalid catalog namespace');
  const visit = (value: unknown, prefix: string, depth: number): void => {
    if (depth > maxDepth)
      throw new I18nError('CATALOG', 'Catalog nesting is too deep');
    if (!isPlainObject(value))
      throw new I18nError('CATALOG', 'Catalog nodes must be plain objects');
    if (Object.getOwnPropertySymbols(value).length)
      throw new I18nError('CATALOG', 'Catalog symbol keys are unsupported');
    for (const key of Object.getOwnPropertyNames(value)) {
      if (!validSegment(key))
        throw new I18nError('CATALOG', 'Invalid or unsafe catalog key');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
        throw new I18nError('CATALOG', 'Catalog keys must be data properties');
      const child: unknown = descriptor.value;
      const full = prefix ? `${prefix}.${key}` : key;
      if (typeof child === 'string') {
        if (child.length > maxMessageLength)
          throw new I18nError('CATALOG', 'Catalog message is too long');
        if (++budget.entries > catalogLimits.entries)
          throw new I18nError('CATALOG', 'Catalog has too many entries');
        budget.bytes += Buffer.byteLength(child) + full.length;
        if (budget.bytes > catalogLimits.bytes)
          throw new I18nError('CATALOG', 'Catalogs exceed the size limit');
        try {
          parseMessage(child);
        } catch (error) {
          throw new I18nError(
            'CATALOG',
            `Invalid message at ${namespace}:${full}`,
            { cause: error },
          );
        }
        into.set(`${namespace}:${full}`, child);
      } else visit(child, full, depth + 1);
    }
  };
  visit(tree, '', 0);
}

/**
 * Reads `<directory>/<locale>/<namespace>.json` for allowlisted locales only.
 * Locale and namespace names are grammar-checked, so no path segment can traverse;
 * real paths must remain inside the directory (symlinks escaping it fail).
 */
export async function loadCatalogs(
  directory: string,
  options: {
    readonly locales: readonly string[];
    readonly namespaces?: readonly string[];
    readonly maxBytes?: number;
  },
): Promise<CatalogInput> {
  const maxBytes = options.maxBytes ?? catalogLimits.fileBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new I18nError('CONFIG', 'maxBytes must be a positive integer');
  for (const namespace of options.namespaces ?? [])
    if (!namespacePattern.test(namespace) || forbiddenKeys.has(namespace))
      throw new I18nError('CONFIG', 'Invalid namespace name');
  const root = await realpath(path.resolve(directory));
  if (!(await stat(root)).isDirectory())
    throw new I18nError('CONFIG', 'Catalog directory is not a directory');
  const inside = (file: string): boolean => {
    const relative = path.relative(root, file);
    return (
      relative !== '' &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative)
    );
  };
  const result: Record<string, Record<string, unknown>> = Object.create(
    null,
  ) as Record<string, Record<string, unknown>>;
  const budget: CatalogBudget = { entries: 0, bytes: 0 };
  for (const requested of options.locales) {
    const locale = canonicalLocale(requested);
    if (!locale || locale !== requested)
      throw new I18nError('CONFIG', 'Catalog locales must be canonical tags');
    const localeDirectory = path.join(root, locale);
    let info;
    try {
      info = await lstat(localeDirectory);
    } catch {
      continue;
    }
    if (!info.isDirectory())
      throw new I18nError('CATALOG', 'Locale catalog path is not a directory');
    const namespaces =
      options.namespaces ??
      (await readdir(localeDirectory))
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -5))
        .filter(
          (name) => namespacePattern.test(name) && !forbiddenKeys.has(name),
        )
        .sort();
    const entry: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const namespace of namespaces) {
      const candidate = path.join(localeDirectory, `${namespace}.json`);
      let file: string;
      try {
        file = await realpath(candidate);
      } catch {
        continue;
      }
      if (!inside(file))
        throw new I18nError('CATALOG', 'Catalog file escapes the directory');
      const fileInfo = await stat(file);
      if (!fileInfo.isFile() || fileInfo.size > maxBytes)
        throw new I18nError('CATALOG', 'Catalog file is invalid or too large');
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(file, 'utf8'));
      } catch (error) {
        throw new I18nError('CATALOG', 'Catalog file is not valid JSON', {
          cause: error,
        });
      }
      // Validate early; JSON.parse creates own "__proto__" keys which fail here.
      flattenNamespace(namespace, parsed, new Map(), budget);
      entry[namespace] = parsed;
    }
    result[locale] = Object.freeze(entry);
  }
  return Object.freeze(result);
}
