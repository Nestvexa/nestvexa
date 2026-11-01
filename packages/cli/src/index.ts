import { resolve } from 'node:path';
import { CliError } from './plan.js';
import * as commands from './commands.js';
import type { CommandContext, CommandResult } from './commands.js';
import { version } from './templates.js';

export { CliError, ChangePlan } from './plan.js';
export type { CommandContext, CommandResult } from './commands.js';

const help: Record<string, string> = {
  '': `nestvexa ${version}

Usage: nestvexa <command> [arguments] [options]

Commands:
  init                         Wire HBS views, Live and Alpine into a Nest app
  doctor                       Check Node, Nest, installation and configuration
  check                        doctor + strict TypeScript compile
  add engine <hbs|ejs|pug|nunjucks>
  add <realtime|redis|cache|inertia>
  remove <feature>             Remove unmodified generated files (e.g. component:counter)
  make:component <Name>        Live component class + view
  make:page <Name> [--renderer hbs]
  make:layout <Name>
  make:policy <Name>           Deny-by-default guard
  make:resource <Name>         Service + Live CRUD table + view
  inspect:routes | inspect:components | inspect:actions
  build                        Run the project build script
  migrate                      Show/apply version migrations

Options:
  --dry-run   Show planned changes without writing
  --yes       Non-interactive (no prompts are used; accepted for scripts)
  --force     Overwrite existing generated files
  --install   Run the package manager after adding dependencies
  --json      Machine-readable output
  --quiet     Only print errors
  --verbose   Print every planned change
  --cwd <dir> Project directory (default: current directory)
  --help      Show help for a command
  --version   Print the version`,
  init: 'nestvexa init [--dry-run] [--force] [--install]\nAdds nestvexa + express-session, views/, src/nestvexa/* and patches app.module.ts and main.ts. Idempotent.',
  doctor:
    'nestvexa doctor [--json]\nExit code 1 when a check fails. Secret values are never printed.',
  check: 'nestvexa check [--json]',
  add: 'nestvexa add engine <hbs|ejs|pug|nunjucks> | nestvexa add <realtime|redis|cache|inertia> [--install]',
  remove:
    'nestvexa remove <feature> [--dry-run]\nOnly deletes generated files whose content is unchanged.',
  'make:component': 'nestvexa make:component <Name> [--force] [--dry-run]',
  'make:page': 'nestvexa make:page <Name> [--renderer hbs]',
  'make:layout': 'nestvexa make:layout <Name>',
  'make:policy': 'nestvexa make:policy <Name>',
  'make:resource': 'nestvexa make:resource <Name>',
  'inspect:routes':
    'nestvexa inspect:routes [--json] (static source inspection)',
  'inspect:components': 'nestvexa inspect:components [--json]',
  'inspect:actions': 'nestvexa inspect:actions [--json]',
  build: 'nestvexa build [--dry-run]',
  migrate: 'nestvexa migrate [--dry-run] [--json]',
};

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
      else if (['cwd', 'renderer'].includes(name))
        options[name] = argv[++index] ?? '';
      else options[name] = true;
    } else positional.push(argument);
  }
  const known = new Set([
    'dry-run',
    'yes',
    'force',
    'install',
    'json',
    'quiet',
    'verbose',
    'cwd',
    'help',
    'version',
    'renderer',
  ]);
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
  const context: CommandContext = {
    cwd: resolve(
      cwd,
      typeof options['cwd'] === 'string' ? options['cwd'] : '.',
    ),
    dryRun: options['dry-run'] === true,
    force: options['force'] === true,
    install: options['install'] === true,
    options,
    log: (line) => stdout.push(line),
  };
  let result: CommandResult;
  try {
    switch (command) {
      case 'init':
        result = commands.init(context);
        break;
      case 'doctor':
        result = commands.doctor(context);
        break;
      case 'check':
        result = commands.check(context);
        break;
      case 'add':
        result = commands.add(context, rest[0], rest[1]);
        break;
      case 'remove':
        result = commands.remove(context, rest[0]);
        break;
      case 'make:component':
        result = commands.makeComponent(context, rest[0]);
        break;
      case 'make:page':
        result = commands.makePage(context, rest[0]);
        break;
      case 'make:layout':
        result = commands.makeLayout(context, rest[0]);
        break;
      case 'make:policy':
        result = commands.makePolicy(context, rest[0]);
        break;
      case 'make:resource':
        result = commands.makeResource(context, rest[0]);
        break;
      case 'inspect:routes':
      case 'inspect:components':
      case 'inspect:actions':
        result = commands.inspect(context, command.slice('inspect:'.length));
        break;
      case 'build':
        result = commands.build(context);
        break;
      case 'migrate':
        result = commands.migrate(context);
        break;
      default:
        stderr.push(
          help[command] === undefined
            ? `Unknown command "${command}". See nestvexa --help.`
            : `${command} is not available in this CLI version.`,
        );
        return { exitCode: 2, stdout, stderr };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options['json'])
      stdout.push(JSON.stringify({ ok: false, error: message }));
    else stderr.push(`Error: ${message}`);
    return {
      exitCode: error instanceof CliError ? error.exitCode : 1,
      stdout,
      stderr,
    };
  }
  if (options['json']) stdout.push(JSON.stringify(result));
  else if (!options['quiet']) {
    if (
      result.changes?.length &&
      (options['verbose'] || context.dryRun || result.changes.length <= 20)
    )
      stdout.push(...result.changes);
    stdout.push(...result.messages);
  }
  return { exitCode: result.ok ? 0 : 1, stdout, stderr };
}
