import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, posix } from 'node:path';
import { formatPlan } from './format.js';
import { ChangePlan, CliError, projectPath } from './plan.js';
import {
  addArrayElement,
  addModuleArrayEntry,
  addObjectProperty,
  ensureImport,
} from './project.js';
import type { ProjectInfo } from './project.js';
import { version } from './templates.js';

export interface CommandContext {
  readonly cwd: string;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly install: boolean;
  readonly options: Readonly<Record<string, string | boolean>>;
  log(line: string): void;
}
export interface CommandResult {
  readonly ok: boolean;
  readonly changes?: readonly string[];
  readonly messages: readonly string[];
  readonly data?: unknown;
}
export function newPlan(project: ProjectInfo, feature: string): ChangePlan {
  return new ChangePlan(project.root, feature, version);
}
export function finish(
  plan: ChangePlan,
  context: CommandContext,
  messages: readonly string[],
  data?: unknown,
): CommandResult {
  // The project's ESLint/Prettier (best effort), then conflicts are settled
  // against the formatted output.
  const formatting =
    context.options['no-format'] === true ? [] : formatPlan(plan);
  plan.resolveConflicts();
  const changes = plan.describe();
  if (!context.dryRun) plan.apply();
  const notes = changes.length ? formatting : [];
  return {
    ok: true,
    changes,
    messages: context.dryRun
      ? ['Dry run: no files were changed.', ...messages, ...notes]
      : [...messages, ...notes],
    ...(data === undefined ? {} : { data }),
  };
}
export function installDependencies(
  project: ProjectInfo,
  context: CommandContext,
  plan?: ChangePlan,
): string {
  if (plan && !plan.changes.some((change) => change.path === 'package.json'))
    return 'No new dependencies.';
  if (!context.install || context.dryRun)
    return `Run \`${project.packageManager} install\` to install the added dependencies.`;
  return 'Dependencies are installed after the files are written.';
}
/** Runs the package manager after a successful apply when `--install` was given. */
export function runInstall(
  project: ProjectInfo,
  context: CommandContext,
  result: CommandResult,
): CommandResult {
  if (
    !context.install ||
    context.dryRun ||
    !result.changes?.some((line) => line.endsWith(' package.json'))
  )
    return result;
  // One fixed command string: package managers are .cmd shims on Windows.
  const status = spawnSync(`${project.packageManager} install`, {
    cwd: project.root,
    stdio: context.options['json'] ? ['ignore', 2, 2] : 'inherit',
    shell: true,
  });
  if (status.status !== 0)
    throw new CliError(
      `${project.packageManager} install failed; files were written, rerun the install`,
    );
  return {
    ...result,
    messages: [...result.messages, 'Dependencies installed.'],
  };
}
/** Module specifier from one project file to another (`./x.js` for ESM, `./x` for CommonJS). */
export function relativeImport(from: string, to: string, esm: boolean): string {
  let path = posix.relative(posix.dirname(from), to.replace(/\.tsx?$/, ''));
  if (!path.startsWith('.')) path = `./${path}`;
  return esm ? `${path}.js` : path;
}
export function liveConfigPath(project: ProjectInfo): string {
  return `${project.sourceRoot}/nestvexa/nestvexa.config.ts`;
}
/**
 * Register a Live component in the generated `nestvexa.config.ts` (component
 * list and action allowlist). Returns false when the project has no generated
 * config (the caller prints manual registration steps).
 */
export function registerLiveComponent(
  plan: ChangePlan,
  project: ProjectInfo,
  className: string,
  file: string,
  name: string,
  actions: readonly string[],
): boolean {
  const configPath = liveConfigPath(project);
  const config = plan.read(configPath);
  if (
    config === undefined ||
    !config.includes('// nestvexa:components') ||
    !config.includes('// nestvexa:actions')
  )
    return false;
  let next = ensureImport(
    config,
    relativeImport(configPath, file, project.esm),
    [className],
  );
  next = addArrayElement(
    next,
    'liveComponents',
    className,
    className,
    'components',
  );
  next = addObjectProperty(
    next,
    'liveActions',
    name,
    `[${actions.map((action) => `'${action}'`).join(', ')}]`,
    'actions',
  );
  plan.update(configPath, next);
  return true;
}
/** Import a class into the app module and list it in `@Module({ <property> })`. */
export function registerInModule(
  plan: ChangePlan,
  project: ProjectInfo,
  property: 'imports' | 'controllers' | 'providers',
  file: string,
  names: readonly string[],
  element: string,
  marker: string,
): boolean {
  const moduleText = plan.read(project.appModule);
  if (moduleText === undefined) return false;
  let patched = ensureImport(
    moduleText,
    relativeImport(project.appModule, file, project.esm),
    names,
  );
  patched = addModuleArrayEntry(patched, property, element, marker);
  plan.update(project.appModule, patched);
  return true;
}

/** Placeholders of an ejected template (`nestvexa templates:eject`). */
export const sentinel = Object.freeze({
  pascal: 'NvPascalName',
  kebab: 'nv-kebab-name',
  camel: 'nvCamelName',
});
export interface Names {
  readonly pascal: string;
  readonly kebab: string;
  readonly camel: string;
}
export const templatesDirectory = '.nestvexa/templates';
/**
 * Template text for a generator: the project's override in
 * `.nestvexa/templates/<id>` when present (placeholders replaced), else the
 * built-in template. The id and version are recorded in the manifest.
 */
export function template(
  project: ProjectInfo,
  id: string,
  templateVersion: number,
  names: Names,
  render: (names: Names) => string,
): { content: string; template: { id: string; version: number } } {
  const override = projectPath(project.root, `${templatesDirectory}/${id}`);
  if (existsSync(override)) {
    const content = readFileSync(override, 'utf8')
      .replaceAll(sentinel.pascal, names.pascal)
      .replaceAll(sentinel.kebab, names.kebab)
      .replaceAll(sentinel.camel, names.camel);
    return {
      content,
      template: { id: `custom:${id}`, version: templateVersion },
    };
  }
  return { content: render(names), template: { id, version: templateVersion } };
}
export function directoryOf(path: string): string {
  return dirname(path).replaceAll('\\', '/');
}
