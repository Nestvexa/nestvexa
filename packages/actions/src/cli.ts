#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { formatDiagnostic, generateActionClient } from './codegen/index.js';

const usage = `Usage: nestvexa-actions-codegen --out <dir> [--project tsconfig.json] [--name actions-client] [--client-module @nestvexa/actions/client] [--check]

Reads @ActionGroup classes with the TypeScript compiler API and writes
<dir>/<name>.js and <dir>/<name>.d.ts. --check fails instead of writing when the
generated files are out of date.`;

function parse(argv: readonly string[]): Map<string, string | true> {
  const values = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] ?? '';
    if (!argument.startsWith('--'))
      throw new Error(`Unexpected argument ${argument}`);
    const name = argument.slice(2);
    if (name === 'check' || name === 'help') {
      values.set(name, true);
      continue;
    }
    if (!['out', 'project', 'name', 'client-module'].includes(name))
      throw new Error(`Unknown option --${name}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--'))
      throw new Error(`Missing value for --${name}`);
    values.set(name, value);
    index++;
  }
  return values;
}

async function main(): Promise<number> {
  let values: Map<string, string | true>;
  try {
    values = parse(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage);
    return 2;
  }
  if (values.get('help') === true) {
    console.log(usage);
    return 0;
  }
  const text = (name: string): string | undefined => {
    const value = values.get(name);
    return typeof value === 'string' ? value : undefined;
  };
  const out = text('out');
  if (!out) {
    console.error(usage);
    return 2;
  }
  const project =
    text('project') ??
    (existsSync('tsconfig.json') ? 'tsconfig.json' : undefined);
  if (!project) {
    console.error(
      'No --project given and no tsconfig.json in the current directory',
    );
    return 2;
  }
  const name = text('name');
  const clientModule = text('client-module');
  const check = values.get('check') === true;
  const result = await generateActionClient({
    project,
    outDir: out,
    ...(name === undefined ? {} : { fileName: name }),
    ...(clientModule === undefined ? {} : { clientModule }),
    check,
  });
  for (const diagnostic of result.diagnostics)
    console.error(formatDiagnostic(diagnostic));
  if (!result.ok) return 1;
  const actions = result.groups.reduce(
    (total, group) => total + group.actions.length,
    0,
  );
  const changed = result.files.filter((file) => file.changed).length;
  console.log(
    `nestvexa-actions-codegen: ${result.groups.length} group(s), ${actions} action(s); ${check ? 'up to date' : `${changed} file(s) written`}`,
  );
  return 0;
}

process.exitCode = await main();
