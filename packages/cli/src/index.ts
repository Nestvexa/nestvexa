import { resolve } from 'node:path';
import { CliError } from './plan.js';
import * as commands from './commands.js';
import type { CommandContext, CommandResult } from './context.js';
import { runInstall } from './context.js';
import { doctor } from './doctor.js';
import { add } from './features.js';
import * as generators from './generators.js';
import { migrate } from './migrate.js';
import { detectProject } from './project.js';
import { routesTypes } from './routes.js';
import { version } from './templates.js';

export { CliError, ChangePlan } from './plan.js';
export type { CommandContext, CommandResult } from './context.js';
export { satisfies, supportedNode } from './doctor.js';
export { detectPackageManager } from './project.js';
export type { PackageManager } from './project.js';
export { migrations } from './migrate.js';
export type { MigrationStep } from './migrate.js';
export { pinned } from './versions.js';
export { pluginCapabilities, validatePluginManifest } from './plugins.js';
export type { PluginManifest } from './plugins.js';

const help: Record<string, string> = {
  '': `nestvexa ${version}

Usage: nestvexa <command> [arguments] [options]

Commands:
  init                         Wire HBS views, Live and Alpine into a Nest app
  doctor [--production]        Check Node, Nest, peers, engines, CSRF, secrets and assets
  check                        doctor + strict TypeScript compile
  add engine <hbs|ejs|pug|nunjucks>
  add <react|vue|svelte|inertia>        Inertia root with its own Vite build
  add <islands|forms|actions|realtime|redis|uploads|i18n|devtools|cache>
  add plugin <package> [--export <name>] [--legacy-plugin]  Wire an installed NestvexaExtension
  remove <feature>             Remove unmodified generated files (e.g. component:counter)
  make:component <Name> [--view hbs] [--module <dir>]
  make:page <Name> [--renderer hbs|ejs|pug|nunjucks|react|vue|svelte]
  make:layout <Name>
  make:form <Name>             Live form with a Zod schema (@nestvexa/forms)
  make:action <Name>           @nestvexa/actions group
  make:policy <Name>           Deny-by-default guard
  make:resource <Name> [--crud] [--orm memory]
  make:island <Name> --renderer <react|vue|svelte>
  make:test <Name> [--kind component|page|form|action|smoke]
  templates | templates:eject <id>      List or customize generator templates
  inspect:routes | inspect:components | inspect:actions
  routes:types [--check]       Typed route map, route()/routeLink() and {{route}}
  build                        Run the project build script
  migrate [--revert <id>]      Apply (or revert) versioned project migrations

Options:
  --dry-run   Show planned changes without writing
  --yes       Non-interactive (no prompts are used; accepted for scripts)
  --force     Overwrite existing generated files
  --install   Run the package manager after adding dependencies
  --json      Machine-readable output
  --quiet     Only print errors
  --verbose   Print every planned change
  --no-format Do not run the project's Prettier/ESLint on written files
  --cwd <dir> Project directory (default: current directory)
  --help      Show help for a command
  --version   Print the version`,
  init: 'nestvexa init [--dry-run] [--force] [--install]\nAdds nestvexa + express-session, views/, src/nestvexa/* and patches app.module.ts and main.ts. Idempotent.',
  doctor:
    'nestvexa doctor [--json] [--production]\nChecks Node, NestJS, peer versions, template engines, CSRF/session settings, secrets (never printed), Vite manifests and that development tooling is disabled in production. Exit code 1 when a check fails; --production (or NODE_ENV=production) turns deployment warnings into failures.',
  check:
    'nestvexa check [--json]\ndoctor plus a strict TypeScript compile of the project.',
  add: 'nestvexa add engine <hbs|ejs|pug|nunjucks>\nnestvexa add <react|vue|svelte|inertia|islands [react|vue|svelte]|forms|actions|realtime|redis|uploads|i18n|devtools|cache> [--dry-run] [--install]\nAdds pinned dependencies, generated configuration and AST patches of app.module.ts/main.ts. Idempotent.\nnestvexa add plugin <package> [--export <name>]\nWires a NestvexaExtension exported by a package you installed (its package.json "nestvexa" manifest is validated; plugin code is never executed by the CLI).',
  remove:
    'nestvexa remove <feature> [--dry-run]\nOnly deletes generated files whose content is unchanged.',
  'make:component':
    'nestvexa make:component <Name> [--view hbs] [--module <dir>] [--force] [--dry-run]',
  'make:page':
    'nestvexa make:page <Name> [--renderer hbs|ejs|pug|nunjucks|react|vue|svelte]\nEngines and Inertia roots are set up on first use.',
  'make:layout': 'nestvexa make:layout <Name>',
  'make:form':
    'nestvexa make:form <Name>\nLive component + view validated by @nestvexa/forms with a Zod schema; registered and authorized in nestvexa.config.ts.',
  'make:action':
    'nestvexa make:action <Name>\n@nestvexa/actions group registered in actions.config.ts and ActionsModule.',
  'make:policy': 'nestvexa make:policy <Name>',
  'make:resource': 'nestvexa make:resource <Name> [--crud] [--orm memory]',
  'make:island':
    'nestvexa make:island <Name> --renderer <react|vue|svelte>\nComponent + server registry entry + client allowlist entry.',
  'make:test':
    'nestvexa make:test <Name> [--kind component|page|form|action|smoke]\nDetects the generated artifact; vitest unless the project uses jest.',
  templates: 'nestvexa templates [--json]',
  'templates:eject': 'nestvexa templates:eject <id> [--force]',
  'inspect:routes':
    'nestvexa inspect:routes [--json] (static source inspection)',
  'inspect:components': 'nestvexa inspect:components [--json]',
  'inspect:actions': 'nestvexa inspect:actions [--json]',
  'routes:types':
    'nestvexa routes:types [--check] [--dry-run]\nWrites src/nestvexa/routes.ts (typed route map of every controller route, route() and routeLink()) and, once, the {{route}} Handlebars helper in main.ts. --check exits 1 when the map is out of date.',
  build: 'nestvexa build [--dry-run]',
  migrate:
    'nestvexa migrate [--dry-run] [--json] [--revert <id>] [--force]\nApplies pending versioned migrations atomically and records them in .nestvexa/manifest.json; --revert restores the latest one from its backup.',
};
const valueOptions = new Set([
  'cwd',
  'renderer',
  'view',
  'module',
  'orm',
  'kind',
  'revert',
  'export',
]);
const known = new Set([
  ...valueOptions,
  'dry-run',
  'yes',
  'force',
  'install',
  'json',
  'quiet',
  'verbose',
  'help',
  'version',
  'crud',
  'production',
  'check',
  'no-format',
  'legacy-plugin',
]);

export interface RunOutput {
  readonly exitCode: number;
  readonly stdout: string[];
  readonly stderr: string[];
}
/** Parse arguments and run a command; never calls process.exit (testable). */
export function run(argv: readonly string[], cwd = process.cwd()): RunOutput {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const positional: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] ?? '';
    if (argument.startsWith('--')) {
      const [name = '', inline] = argument.slice(2).split('=', 2);
      if (!/^[a-z][a-z-]*$/.test(name)) {
        stderr.push(`Unknown option ${argument}`);
        return { exitCode: 2, stdout, stderr };
      }
      if (inline !== undefined) options[name] = inline;
      else if (valueOptions.has(name)) {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) {
          stderr.push(`Option --${name} needs a value.`);
          return { exitCode: 2, stdout, stderr };
        }
        options[name] = value;
        index++;
      } else options[name] = true;
    } else positional.push(argument);
  }
  const unknown = Object.keys(options).find((name) => !known.has(name));
  if (unknown) {
    stderr.push(`Unknown option --${unknown}. See nestvexa --help.`);
    return { exitCode: 2, stdout, stderr };
  }
  if (options['version']) {
    stdout.push(version);
    return { exitCode: 0, stdout, stderr };
  }
  const [command = '', ...rest] = positional;
  if (!command || options['help']) {
    const text = help[command];
    if (text === undefined) {
      stderr.push(`Unknown command "${command}". See nestvexa --help.`);
      return { exitCode: 2, stdout, stderr };
    }
    stdout.push(text);
    return { exitCode: 0, stdout, stderr };
  }
  const verbose = options['verbose'] === true;
  const context: CommandContext = {
    cwd: resolve(
      cwd,
      typeof options['cwd'] === 'string' ? options['cwd'] : '.',
    ),
    dryRun: options['dry-run'] === true,
    force: options['force'] === true,
    install: options['install'] === true,
    options,
    log: (line) => {
      if (verbose) stdout.push(line);
    },
  };
  let result: CommandResult;
  try {
    switch (command) {
      case 'init':
        result = commands.init(context);
        break;
      case 'doctor':
        result = doctor(context);
        break;
      case 'check':
        result = commands.check(context);
        break;
      case 'add':
        result = add(context, rest[0], rest[1]);
        break;
      case 'remove':
        result = commands.remove(context, rest[0]);
        break;
      case 'make:component':
        result = generators.makeComponent(context, rest[0]);
        break;
      case 'make:page':
        result = generators.makePage(context, rest[0]);
        break;
      case 'make:layout':
        result = generators.makeLayout(context, rest[0]);
        break;
      case 'make:form':
        result = generators.makeForm(context, rest[0]);
        break;
      case 'make:action':
        result = generators.makeAction(context, rest[0]);
        break;
      case 'make:policy':
        result = generators.makePolicy(context, rest[0]);
        break;
      case 'make:resource':
        result = generators.makeResource(context, rest[0]);
        break;
      case 'make:island':
        result = generators.makeIsland(context, rest[0]);
        break;
      case 'make:test':
        result = generators.makeTest(context, rest[0]);
        break;
      case 'templates':
        result = generators.listTemplates(context);
        break;
      case 'templates:eject':
        result = generators.ejectTemplate(context, rest[0]);
        break;
      case 'inspect:routes':
      case 'inspect:components':
      case 'inspect:actions':
        result = commands.inspect(context, command.slice('inspect:'.length));
        break;
      case 'routes:types':
        result = routesTypes(context);
        break;
      case 'build':
        result = commands.build(context);
        break;
      case 'migrate':
        result = migrate(context);
        break;
      default:
        stderr.push(`Unknown command "${command}". See nestvexa --help.`);
        return { exitCode: 2, stdout, stderr };
    }
    if (context.install && result.changes?.length)
      result = runInstall(detectProject(context.cwd), context, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const exitCode = error instanceof CliError ? error.exitCode : 1;
    if (options['json'])
      stdout.push(JSON.stringify({ ok: false, error: message, exitCode }));
    else stderr.push(`Error: ${message}`);
    return { exitCode, stdout, stderr };
  }
  if (options['json']) stdout.push(JSON.stringify(result));
  else if (!options['quiet']) {
    const changes = result.changes ?? [];
    if (changes.length) {
      if (verbose || context.dryRun || changes.length <= 20)
        stdout.push(...changes);
      else
        stdout.push(
          ...changes.slice(0, 20),
          `… and ${changes.length - 20} more (use --verbose to list all)`,
        );
    }
    stdout.push(...result.messages);
  } else if (!result.ok)
    stderr.push(...result.messages.filter((line) => /^FAIL/.test(line)));
  return { exitCode: result.ok ? 0 : 1, stdout, stderr };
}
