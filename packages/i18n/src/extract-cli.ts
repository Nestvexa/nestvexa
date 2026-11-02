#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { loadCatalogs } from './catalog.js';
import { canonicalLocale } from './locale.js';
import { extractFromDirectory, missingKeys, serializeKeys } from './extract.js';

const usage =
  'Usage: nestvexa-i18n-extract <root> [--out file] [--namespace common] [--catalogs dir --locales en,ar]';

interface Arguments {
  readonly root: string;
  readonly out?: string;
  readonly namespace?: string;
  readonly catalogs?: string;
  readonly locales?: readonly string[];
}

function parse(argv: readonly string[]): Arguments {
  let root: string | undefined;
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] ?? '';
    if (argument.startsWith('--')) {
      const name = argument.slice(2);
      const value = argv[index + 1];
      if (!['out', 'namespace', 'catalogs', 'locales'].includes(name))
        throw new Error(`Unknown option ${argument}`);
      if (value === undefined || value.startsWith('--') || flags.has(name))
        throw new Error(`Option ${argument} requires one value`);
      flags.set(name, value);
      index++;
    } else if (root === undefined) root = argument;
    else throw new Error('Only one root directory is accepted');
  }
  if (root === undefined) throw new Error('A root directory is required');
  const locales = flags
    .get('locales')
    ?.split(',')
    .map((locale) => locale.trim());
  if (flags.has('catalogs') !== (locales !== undefined))
    throw new Error('--catalogs and --locales must be used together');
  for (const locale of locales ?? [])
    if (canonicalLocale(locale) !== locale)
      throw new Error('--locales must list canonical locale tags');
  const out = flags.get('out');
  const namespace = flags.get('namespace');
  const catalogs = flags.get('catalogs');
  return {
    root,
    ...(out === undefined ? {} : { out }),
    ...(namespace === undefined ? {} : { namespace }),
    ...(catalogs === undefined ? {} : { catalogs }),
    ...(locales === undefined ? {} : { locales }),
  };
}

async function main(): Promise<number> {
  let options: Arguments;
  try {
    options = parse(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Invalid arguments');
    console.error(usage);
    return 2;
  }
  const extracted = await extractFromDirectory(
    options.root,
    options.namespace === undefined
      ? {}
      : { defaultNamespace: options.namespace },
  );
  let missing: Readonly<Record<string, readonly string[]>> | undefined;
  if (options.catalogs !== undefined && options.locales !== undefined) {
    const catalogs = await loadCatalogs(options.catalogs, {
      locales: options.locales,
    });
    missing = missingKeys(extracted, catalogs, options.locales);
  }
  const output = serializeKeys(extracted, missing);
  if (options.out === undefined) process.stdout.write(output);
  else await writeFile(options.out, output);
  const count = missing
    ? Object.values(missing).reduce((sum, keys) => sum + keys.length, 0)
    : 0;
  if (count) {
    console.error(`${count} translation(s) missing`);
    return 1;
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Extraction failed');
    process.exitCode = 2;
  },
);
