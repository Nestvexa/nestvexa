import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { readManifest, projectPath } from './plan.js';
import type { ChangePlan } from './plan.js';

/**
 * Runs in a child Node process (formatters are asynchronous, the CLI is
 * synchronous). Input on stdin, JSON result on stdout. Every failure is
 * reported as a note; the files then keep the generator output.
 */
const worker = `
const input = JSON.parse(await new Promise((done) => {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (text += chunk));
  process.stdin.on('end', () => done(text));
}));
const { pathToFileURL } = await import('node:url');
const load = async (path) => {
  const module = await import(pathToFileURL(path).href);
  return module.default ?? module;
};
const notes = [];
const short = (error) => String(error && error.message ? error.message : error).split('\\n')[0].slice(0, 300);
let prettier;
let eslint;
if (input.prettier)
  try { prettier = await load(input.prettier); } catch (error) { notes.push('Prettier could not be loaded: ' + short(error)); }
if (input.eslint)
  try {
    const api = await load(input.eslint);
    const ESLint = api.loadESLint ? await api.loadESLint({ cwd: input.root }) : api.ESLint;
    eslint = new ESLint({ cwd: input.root, fix: true });
  } catch (error) { notes.push('ESLint could not be loaded: ' + short(error)); }
const files = [];
let linted = 0;
let formatted = 0;
for (const file of input.files) {
  let content = file.content;
  if (eslint && file.lint)
    try {
      if (!(await eslint.isPathIgnored(file.path))) {
        const [result] = await eslint.lintText(content, { filePath: file.path });
        if (result && typeof result.output === 'string' && result.output !== content) { content = result.output; linted++; }
        const left = result ? result.errorCount + result.warningCount : 0;
        if (left) notes.push('ESLint: ' + left + ' problem(s) left in ' + file.name + ' (not fixable automatically).');
      }
    } catch (error) { notes.push('ESLint skipped ' + file.name + ': ' + short(error)); }
  if (prettier)
    try {
      const info = await prettier.getFileInfo(file.path, { ignorePath: input.ignore, resolveConfig: true });
      if (!info.ignored && info.inferredParser) {
        const options = { ...((await prettier.resolveConfig(file.path, { editorconfig: true })) ?? {}), filepath: file.path };
        const go = file.always || (typeof file.original === 'string' && (await prettier.check(file.original, options)));
        if (go) {
          const next = await prettier.format(content, options);
          if (next !== content) { content = next; formatted++; }
        }
      }
    } catch (error) { notes.push('Prettier skipped ' + file.name + ': ' + short(error)); }
  files.push({ name: file.name, content });
}
process.stdout.write(JSON.stringify({ files, notes, linted, formatted }));
`;

interface WorkerFile {
  readonly name: string;
  readonly path: string;
  readonly content: string;
  readonly original?: string;
  /** Format even when the file did not exist or was not formatted before. */
  readonly always: boolean;
  readonly lint: boolean;
}
interface WorkerResult {
  readonly files: readonly {
    readonly name: string;
    readonly content: string;
  }[];
  readonly notes: readonly string[];
  readonly linted: number;
  readonly formatted: number;
}
const lintable = /\.(?:[cm]?[jt]sx?|vue|svelte)$/;

/** The project's own formatter/linter entry point, when declared in package.json and installed. */
function tool(root: string, name: 'prettier' | 'eslint'): string | undefined {
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
  const declared = ['dependencies', 'devDependencies'].some((field) => {
    const value: unknown =
      pkg && typeof pkg === 'object' ? Reflect.get(pkg, field) : undefined;
    return (
      value !== null &&
      typeof value === 'object' &&
      typeof Reflect.get(value, name) === 'string'
    );
  });
  if (!declared) return undefined;
  try {
    return createRequire(join(root, 'package.json')).resolve(name);
  } catch {
    return undefined;
  }
}

/**
 * Best effort: run the project's ESLint (`--fix`) and Prettier on the files a
 * plan writes, before the plan is applied, so the manifest checksums match
 * the formatted output. Created files and files the CLI generated earlier are
 * always formatted; other edited files only when they were formatted before
 * (unrelated lines of an unformatted user file are never reformatted). ESLint
 * fixes only generated files. Never throws: problems become notes.
 */
export function formatPlan(plan: ChangePlan): string[] {
  const prettier = tool(plan.root, 'prettier');
  const eslint = tool(plan.root, 'eslint');
  if (!prettier && !eslint) return [];
  const generated = new Set(Object.keys(readManifest(plan.root).files));
  const files: WorkerFile[] = plan.changes.flatMap((change) => {
    if (change.kind === 'delete' || change.content === undefined) return [];
    const original = plan.original(change.path);
    const owned =
      change.kind === 'create' ||
      change.generated === true ||
      generated.has(change.path);
    return [
      {
        name: change.path,
        path: projectPath(plan.root, change.path),
        content: change.content,
        ...(original === undefined ? {} : { original }),
        always: owned,
        lint: owned && lintable.test(change.path),
      },
    ];
  });
  if (!files.length) return [];
  const ignore = ['.gitignore', '.prettierignore']
    .map((file) => join(plan.root, file))
    .filter((file) => existsSync(file));
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', worker],
    {
      cwd: plan.root,
      input: JSON.stringify({
        root: plan.root,
        prettier,
        eslint,
        ignore,
        files,
      }),
      encoding: 'utf8',
      timeout: 600_000,
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
    },
  );
  let result: WorkerResult;
  try {
    if (child.status !== 0) throw new Error(child.stderr.split('\n')[0] ?? '');
    result = JSON.parse(child.stdout) as WorkerResult;
  } catch (error) {
    const reason =
      child.error?.message ??
      (error instanceof Error ? error.message : String(error));
    return [`Formatting skipped: ${reason || 'the formatter process failed'}`];
  }
  for (const file of result.files) plan.replaceContent(file.name, file.content);
  const tools = [
    ...(eslint ? [`ESLint fixed ${result.linted}`] : []),
    ...(prettier ? [`Prettier formatted ${result.formatted}`] : []),
  ];
  return [
    `${tools.join(', ')} of ${files.length} written file(s) with the project's configuration.`,
    ...result.notes,
  ];
}
