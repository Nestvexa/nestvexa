import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { finish, newPlan, relativeImport } from './context.js';
import type { CommandContext, CommandResult } from './context.js';
import { satisfies } from './doctor.js';
import { CliError } from './plan.js';
import type { ChangePlan } from './plan.js';
import { addArrayElement, detectProject, ensureImport } from './project.js';
import type { ProjectInfo } from './project.js';

/**
 * Capabilities a plugin manifest may declare. Must equal
 * `PLUGIN_CAPABILITIES` of `@nestvexa/core` (tests/cli-plugins.test.ts
 * compares them); the CLI validates manifests statically and never imports
 * the plugin or the framework.
 */
export const pluginCapabilities = [
  'view-engine',
  'state-synthesizer',
  'action-policy',
  'storage',
  'cache',
  'realtime-transport',
  'island-renderer',
  'cli-generator',
  'instrumentation',
  'ui-kit',
] as const;

export interface PluginManifest {
  readonly name: string;
  readonly version: string;
  readonly nestvexa: string;
  readonly capabilities: readonly string[];
  readonly description?: string;
}
const packageName =
  /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,127}$/;
const semver =
  /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const identifier = /^[A-Za-z_$][\w$]{0,63}$/;

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
/** package.json of an installed package, found like Node resolves it (no code runs). */
function installed(
  root: string,
  name: string,
): Record<string, unknown> | undefined {
  let directory = root;
  for (let depth = 0; depth < 32; depth++) {
    const file = join(directory, 'node_modules', name, 'package.json');
    if (existsSync(file)) return readJson(file);
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

/**
 * Validate the `nestvexa` field of a plugin's package.json with the rules of
 * `parsePluginManifest` in `@nestvexa/core`, plus: it must name the installed
 * package and version, and its range must include the installed framework.
 */
export function validatePluginManifest(
  pkg: Record<string, unknown>,
  frameworkVersion: string | undefined,
): PluginManifest {
  const label = typeof pkg['name'] === 'string' ? pkg['name'] : 'the package';
  const fail = (reason: string): never => {
    throw new CliError(
      `${label} has an invalid Nestvexa plugin manifest: ${reason}`,
    );
  };
  const input = pkg['nestvexa'];
  if (input === undefined)
    throw new CliError(
      `${label} is not a Nestvexa plugin: its package.json has no "nestvexa" manifest.`,
    );
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    return fail('expected an object');
  const manifest = input as Record<string, unknown>;
  const allowed = [
    'name',
    'version',
    'nestvexa',
    'capabilities',
    'description',
  ];
  for (const key of Object.keys(manifest))
    if (!allowed.includes(key)) fail(`unknown key "${key}"`);
  const { name, version, nestvexa, capabilities, description } = manifest;
  if (typeof name !== 'string' || !packageName.test(name)) return fail('name');
  if (name !== pkg['name']) fail(`name ${name} is not the package name`);
  if (typeof version !== 'string' || !semver.test(version))
    return fail('version');
  if (version !== pkg['version'])
    fail(`version ${version} is not the installed version`);
  if (typeof nestvexa !== 'string' || !nestvexa.trim() || nestvexa.length > 256)
    return fail('nestvexa range');
  if (
    !Array.isArray(capabilities) ||
    !capabilities.length ||
    new Set(capabilities).size !== capabilities.length ||
    capabilities.some(
      (entry: unknown) =>
        !pluginCapabilities.some((capability) => capability === entry),
    )
  )
    return fail(`capabilities (known: ${pluginCapabilities.join(', ')})`);
  if (
    description !== undefined &&
    (typeof description !== 'string' || description.length > 512)
  )
    fail('description');
  if (frameworkVersion === undefined)
    throw new CliError(
      'nestvexa is not installed; run `nestvexa init` and install first.',
    );
  if (!satisfies(frameworkVersion, nestvexa))
    throw new CliError(
      `${name} supports Nestvexa ${nestvexa}, not the installed ${frameworkVersion}.`,
    );
  return {
    name,
    version,
    nestvexa,
    capabilities: capabilities as string[],
    ...(typeof description === 'string' ? { description } : {}),
  };
}

const extensionsSource = `import type { CoreModuleRegistration, NestvexaExtension } from 'nestvexa';

/**
 * Plugins installed explicitly with \`nestvexa add plugin <package>\`: reviewed
 * packages imported statically. Nestvexa never loads plugins by name, path or
 * URL at runtime. Each must export a \`NestvexaExtension\` (\`defineExtension\`).
 */
export const nestvexaExtensions: NestvexaExtension[] = [
  // nestvexa:extensions
];

/** Kernel registration: the third argument of NestvexaModule.forRoot. */
export const nestvexaKernel: CoreModuleRegistration = {
  extensions: nestvexaExtensions,
};
`;
function camel(name: string): string {
  const words = name
    .replace(/^@/, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const joined = words
    .map((word, index) =>
      index ? word.charAt(0).toUpperCase() + word.slice(1) : word,
    )
    .join('');
  return /^[A-Za-z_$]/.test(joined) ? joined : `plugin${joined}`;
}

/**
 * Pass `nestvexaKernel` as the third argument of `NestvexaModule.forRoot(...)`.
 * Returns undefined when the call is missing or already has another third
 * argument (the caller prints the manual step).
 */
function addKernelArgument(text: string): string | undefined {
  const source = ts.createSourceFile(
    'app.module.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  let call: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      !call &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(source) === 'NestvexaModule' &&
      node.expression.name.text === 'forRoot'
    )
      call = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!call) return undefined;
  const args = call.arguments;
  if (args[2])
    return args[2].getText(source) === 'nestvexaKernel' ? text : undefined;
  const last = args.at(-1);
  const position = last ? last.getEnd() : call.arguments.pos;
  const prefix =
    args.length === 0
      ? 'undefined, undefined, '
      : args.length === 1
        ? ', undefined, '
        : ', ';
  return `${text.slice(0, position)}${prefix}nestvexaKernel${text.slice(position)}`;
}

function hasNamedImport(text: string, module: string, local: string): boolean {
  const source = ts.createSourceFile(
    'extensions.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  return source.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === module &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (element) => element.name.text === local,
      ),
  );
}
function wireKernel(
  plan: ChangePlan,
  project: ProjectInfo,
  file: string,
  notes: string[],
): void {
  const module = plan.read(project.appModule);
  const patched = module === undefined ? undefined : addKernelArgument(module);
  if (module === undefined || patched === undefined) {
    notes.push(
      `Pass nestvexaKernel from ${file} as the third argument of NestvexaModule.forRoot(options, live, kernel) (or merge its extensions into your kernel registration).`,
    );
    return;
  }
  plan.update(
    project.appModule,
    ensureImport(
      patched,
      relativeImport(project.appModule, file, project.esm),
      ['nestvexaKernel'],
    ),
  );
}

/**
 * `nestvexa add plugin <package> [--export <name>]`: wire an extension the
 * developer already installed. Only a package declared in package.json and
 * present in node_modules is accepted; its manifest is read as JSON and the
 * plugin code is never executed, downloaded or resolved from a path or URL.
 */
export function addPlugin(
  context: CommandContext,
  name: string | undefined,
): CommandResult {
  if (!name || !packageName.test(name))
    throw new CliError(
      'Usage: nestvexa add plugin <package> [--export <name>]. Use an npm package name; paths, URLs and git specifiers are refused.',
      2,
    );
  const exported = context.options['export'];
  const binding = typeof exported === 'string' ? exported : 'extension';
  if (!identifier.test(binding))
    throw new CliError(
      '--export takes the JavaScript name the plugin exports',
      2,
    );
  const project = detectProject(context.cwd);
  if (!project.dependencies[name])
    throw new CliError(
      `${name} is not a dependency. Review and install it yourself first (for example \`${project.packageManager} add ${name}\`); the CLI never downloads plugins.`,
    );
  const pkg = installed(project.root, name);
  if (!pkg)
    throw new CliError(
      `${name} is declared but not installed; run \`${project.packageManager} install\`.`,
    );
  const manifest = validatePluginManifest(
    pkg,
    (() => {
      const umbrella = installed(project.root, 'nestvexa')?.['version'];
      return typeof umbrella === 'string' ? umbrella : undefined;
    })(),
  );
  const plan = newPlan(project, `plugin:${name}`);
  const file = `${project.sourceRoot}/nestvexa/extensions.ts`;
  plan.ensure(file, extensionsSource, {
    template: { id: 'plugins.extensions', version: 1 },
  });
  const local = `${camel(name)}${binding === 'extension' ? 'Extension' : binding.charAt(0).toUpperCase() + binding.slice(1)}`;
  const text = plan.read(file) ?? extensionsSource;
  let next = hasNamedImport(text, name, local)
    ? text
    : ensureImport(text, name, [`${binding} as ${local}`]);
  // A deprecated NestvexaPlugin export is adapted with the core helper.
  const legacy = context.options['legacy-plugin'] === true;
  if (legacy) next = ensureImport(next, 'nestvexa', ['pluginExtension']);
  next = addArrayElement(
    next,
    'nestvexaExtensions',
    legacy ? `pluginExtension(${local})` : local,
    local,
    'extensions',
  );
  plan.update(file, next);
  const notes: string[] = [];
  wireKernel(plan, project, file, notes);
  return finish(plan, context, [
    plan.changes.length
      ? `Installed ${manifest.name}@${manifest.version} (${manifest.capabilities.join(', ')}; supports Nestvexa ${manifest.nestvexa}) as ${local} in ${file}.`
      : `${name} is already installed.`,
    ...notes,
    'The extension runs at application startup (NestvexaExtension hooks); review its code like any dependency.',
  ]);
}
