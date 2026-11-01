import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import {
  ChangePlan,
  CliError,
  projectPath,
  toPosix,
  untouchedGenerated,
} from './plan.js';
import {
  addDependencies,
  addModuleArrayEntry,
  detectProject,
  ensureImport,
  insertBeforeListen,
  names,
  readPackage,
} from './project.js';
import type { ProjectInfo } from './project.js';
import * as templates from './templates.js';

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
function finish(
  plan: ChangePlan,
  context: CommandContext,
  messages: string[],
): CommandResult {
  const changes = plan.describe();
  if (!context.dryRun) plan.apply();
  return {
    ok: true,
    changes,
    messages: context.dryRun
      ? ['Dry run: no files were changed.', ...messages]
      : messages,
  };
}
function installDependencies(
  project: ProjectInfo,
  context: CommandContext,
): string {
  if (!context.install || context.dryRun)
    return `Run \`${project.packageManager} install\` to install the added dependencies.`;
  const result = spawnSync(project.packageManager, ['install'], {
    cwd: project.root,
    stdio: 'inherit',
    // Package managers are .cmd shims on Windows; arguments are fixed constants.
    shell: process.platform === 'win32',
  });
  if (result.status !== 0)
    throw new CliError(
      `${project.packageManager} install failed; files were written, rerun the install`,
    );
  return 'Dependencies installed.';
}
function importPrefix(): string {
  return 'nestvexa';
}

/** `nestvexa init`: wire HBS + Live + Alpine into an existing Nest (Express) app. */
export function init(context: CommandContext): CommandResult {
  const project = detectProject(context.cwd);
  if (project.platform !== 'express')
    throw new CliError(
      'init wires express-session for Live identity/CSRF. For Fastify, follow docs/guides/default-live-setup.md and configure @fastify/session.',
    );
  const plan = new ChangePlan(project.root, 'init');
  const ext = project.esm ? '.js' : '';
  const base = project.sourceRoot;
  addDependencies(
    plan,
    { nestvexa: `^${templates.version}`, 'express-session': '^1.19.0' },
    { '@types/express-session': '^1.19.0' },
  );
  plan.create('views/layout.hbs', templates.layoutView(), {
    force: context.force,
  });
  plan.create('views/welcome.hbs', templates.welcomeView(), {
    force: context.force,
  });
  plan.create(
    'views/components/counter.hbs',
    templates.componentView('counter', 'Counter'),
    {
      force: context.force,
    },
  );
  plan.create(
    `${base}/nestvexa/components/counter.component.ts`,
    templates.componentClass('counter', 'Counter', importPrefix()),
    { force: context.force },
  );
  plan.create(
    `${base}/nestvexa/nestvexa.config.ts`,
    templates.liveConfig(project.esm),
    {
      force: context.force,
    },
  );
  plan.create(
    `${base}/nestvexa/welcome.controller.ts`,
    templates.welcomeController(project.esm),
    {
      force: context.force,
    },
  );
  const moduleText = plan.read(project.appModule);
  if (moduleText === undefined)
    throw new CliError(`${project.appModule} not found`);
  let patched = ensureImport(moduleText, 'nestvexa', ['NestvexaModule']);
  patched = ensureImport(patched, `./nestvexa/nestvexa.config${ext}`, [
    'nestvexaLive',
    'nestvexaOptions',
  ]);
  patched = ensureImport(patched, `./nestvexa/welcome.controller${ext}`, [
    'NestvexaWelcomeController',
  ]);
  patched = addModuleArrayEntry(
    patched,
    'imports',
    'NestvexaModule.forRoot(nestvexaOptions, nestvexaLive)',
    'NestvexaModule',
  );
  patched = addModuleArrayEntry(
    patched,
    'controllers',
    'NestvexaWelcomeController',
    'NestvexaWelcomeController',
  );
  plan.update(project.appModule, patched);
  const mainText = plan.read(project.mainFile);
  if (mainText === undefined)
    throw new CliError(`${project.mainFile} not found`);
  let main = insertBeforeListen(
    mainText,
    templates.mainSetup,
    'configureNestvexa(',
  );
  if (main !== mainText) {
    main = ensureImport(main, 'nestvexa', ['configureNestvexa']);
    main = ensureImport(main, 'node:crypto', ['randomBytes']);
    if (!/import\s+session\s+from\s+['"]express-session['"]/.test(main))
      main = `import session from 'express-session';\n${main}`;
  }
  plan.update(project.mainFile, main);
  const messages = [
    'Nestvexa is configured: HBS views, Live counter and Alpine startup.',
    installDependencies(project, context),
    'Start your app and open /nestvexa. Set NESTVEXA_ORIGIN and SESSION_SECRET for deployments.',
  ];
  return finish(plan, context, messages);
}

export function makeComponent(
  context: CommandContext,
  raw: string | undefined,
): CommandResult {
  if (!raw) throw new CliError('Usage: nestvexa make:component <Name>');
  const project = detectProject(context.cwd);
  const { kebab, pascal } = names(raw);
  const ext = project.esm ? '.js' : '';
  const plan = new ChangePlan(project.root, `component:${kebab}`);
  const file = `${project.sourceRoot}/nestvexa/components/${kebab}.component.ts`;
  plan.create(file, templates.componentClass(kebab, pascal, importPrefix()), {
    force: context.force,
  });
  plan.create(
    `views/components/${kebab}.hbs`,
    templates.componentView(kebab, pascal),
    {
      force: context.force,
    },
  );
  const configPath = `${project.sourceRoot}/nestvexa/nestvexa.config.ts`;
  const config = plan.read(configPath);
  const messages = [`Created ${pascal}Component (Live name "${kebab}").`];
  if (
    config?.includes('// nestvexa:components') &&
    !config.includes(`${pascal}Component,`)
  ) {
    let next = ensureImport(config, `./components/${kebab}.component${ext}`, [
      `${pascal}Component`,
    ]);
    next = next.replace(
      '  // nestvexa:components',
      `  ${pascal}Component,\n  // nestvexa:components`,
    );
    next = next.replace(
      '  // nestvexa:actions',
      `  '${kebab}': ['$mount', 'increment'],\n  // nestvexa:actions`,
    );
    plan.update(configPath, next);
    messages.push(
      'Registered it and authorized its actions in nestvexa.config.ts.',
    );
  } else
    messages.push(
      'Register it in your LiveModule components and authorize "$mount"/"increment" in your policy.',
    );
  return finish(plan, context, messages);
}

export function makePage(
  context: CommandContext,
  raw: string | undefined,
): CommandResult {
  if (!raw)
    throw new CliError('Usage: nestvexa make:page <Name> [--renderer hbs]');
  const renderer = String(context.options['renderer'] ?? 'hbs');
  if (renderer !== 'hbs')
    throw new CliError(
      `make:page --renderer ${renderer} requires the corresponding adapter package; only "hbs" is generated by this CLI version.`,
      2,
    );
  const project = detectProject(context.cwd);
  const { kebab, pascal } = names(raw);
  const ext = project.esm ? '.js' : '';
  const plan = new ChangePlan(project.root, `page:${kebab}`);
  const file = `${project.sourceRoot}/pages/${kebab}.controller.ts`;
  plan.create(file, templates.pageController(kebab, pascal), {
    force: context.force,
  });
  plan.create(`views/pages/${kebab}.hbs`, templates.pageView(pascal), {
    force: context.force,
  });
  const moduleText = plan.read(project.appModule);
  if (moduleText !== undefined) {
    let patched = ensureImport(
      moduleText,
      `./pages/${kebab}.controller${ext}`,
      [`${pascal}Controller`],
    );
    patched = addModuleArrayEntry(
      patched,
      'controllers',
      `${pascal}Controller`,
      `${pascal}Controller`,
    );
    plan.update(project.appModule, patched);
  }
  return finish(plan, context, [`Created page /${kebab}.`]);
}

export function makeLayout(
  context: CommandContext,
  raw: string | undefined,
): CommandResult {
  if (!raw) throw new CliError('Usage: nestvexa make:layout <Name>');
  const project = detectProject(context.cwd);
  const { kebab } = names(raw);
  const plan = new ChangePlan(project.root, `layout:${kebab}`);
  plan.create(`views/layouts/${kebab}.hbs`, templates.layoutView(), {
    force: context.force,
  });
  return finish(plan, context, [
    `Created views/layouts/${kebab}.hbs. Render with { layout: 'layouts/${kebab}' }.`,
  ]);
}

export function makePolicy(
  context: CommandContext,
  raw: string | undefined,
): CommandResult {
  if (!raw) throw new CliError('Usage: nestvexa make:policy <Name>');
  const project = detectProject(context.cwd);
  const { kebab, pascal } = names(raw);
  const plan = new ChangePlan(project.root, `policy:${kebab}`);
  plan.create(
    `${project.sourceRoot}/policies/${kebab}.policy.ts`,
    templates.policyGuard(pascal),
    {
      force: context.force,
    },
  );
  return finish(plan, context, [
    `Created ${pascal}Policy. It denies all requests until you implement allows().`,
  ]);
}

export function makeResource(
  context: CommandContext,
  raw: string | undefined,
): CommandResult {
  if (!raw) throw new CliError('Usage: nestvexa make:resource <Name>');
  const project = detectProject(context.cwd);
  const { kebab, pascal, camel } = names(raw);
  const files = templates.resourceFiles(kebab, pascal, camel, project.esm);
  const plan = new ChangePlan(project.root, `resource:${kebab}`);
  const directory = `${project.sourceRoot}/${kebab}`;
  plan.create(`${directory}/${kebab}.service.ts`, files.service, {
    force: context.force,
  });
  plan.create(`${directory}/${kebab}-table.component.ts`, files.component, {
    force: context.force,
  });
  plan.create(`views/components/${kebab}-table.hbs`, files.view, {
    force: context.force,
  });
  return finish(plan, context, [
    `Created ${pascal}Service and the ${kebab}-table Live component.`,
    `Provide ${pascal}Service through a module imported by your Live registration, register ${pascal}TableComponent and authorize "$mount" and "create".`,
  ]);
}

export function add(
  context: CommandContext,
  feature: string | undefined,
  detail: string | undefined,
): CommandResult {
  const project = detectProject(context.cwd);
  const plan = new ChangePlan(project.root, `add:${feature ?? ''}`);
  const range = `^${templates.version}`;
  const engines: Record<string, Record<string, string>> = {
    ejs: { '@nestvexa/engine-ejs': range },
    pug: { '@nestvexa/engine-pug': range },
    nunjucks: { '@nestvexa/engine-nunjucks': range },
    hbs: {},
  };
  const features: Record<
    string,
    { deps: Record<string, string>; message: string }
  > = {
    realtime: {
      deps: { '@nestvexa/realtime': range },
      message:
        'Import RealtimeModule.forRoot({...}) and pass RealtimeService as the Live `realtime` policy (docs/guides/realtime.md).',
    },
    redis: {
      deps: { '@nestvexa/realtime': range },
      message:
        'Use new RespRealtimeBroker({ host, port, password }) as the realtime broker for multiple replicas.',
    },
    cache: {
      deps: { '@nestvexa/cache': range },
      message: 'See packages/cache README for usage.',
    },
    inertia: {
      deps: { '@nestvexa/inertia': range },
      message: 'Import InertiaModule.forRoot({...}) (docs/guides/inertia.md).',
    },
  };
  if (feature === 'engine') {
    if (!detail || !engines[detail])
      throw new CliError('Usage: nestvexa add engine <hbs|ejs|pug|nunjucks>');
    const added = addDependencies(plan, engines[detail] ?? {});
    return finish(plan, context, [
      added.length
        ? `Added ${added.join(', ')}.`
        : `Engine ${detail} needs no new dependency.`,
      'Pass the engine adapter as the views renderer (docs/guides/template-engines.md).',
      installDependencies(project, context),
    ]);
  }
  const entry = feature ? features[feature] : undefined;
  if (!entry)
    throw new CliError(
      `Unknown or unsupported feature "${feature ?? ''}". Supported: engine, realtime, redis, cache, inertia. React, Vue, Svelte and i18n require their adapter packages and are not generated by this CLI version.`,
      2,
    );
  const added = addDependencies(plan, entry.deps);
  return finish(plan, context, [
    added.length
      ? `Added ${added.join(', ')}.`
      : 'Dependencies already present.',
    entry.message,
    installDependencies(project, context),
  ]);
}

/** Remove generated files of a feature that are still unmodified. */
export function remove(
  context: CommandContext,
  feature: string | undefined,
): CommandResult {
  if (!feature)
    throw new CliError(
      'Usage: nestvexa remove <feature> (for example component:counter)',
    );
  const project = detectProject(context.cwd);
  const { unchanged, modified } = untouchedGenerated(project.root, feature);
  if (!unchanged.length && !modified.length)
    throw new CliError(`No generated files recorded for "${feature}".`);
  const plan = new ChangePlan(project.root, feature);
  for (const path of unchanged) plan.delete(path);
  const messages = [
    `Removing ${unchanged.length} unmodified generated file(s).`,
  ];
  if (modified.length)
    messages.push(
      `Kept ${modified.length} file(s) you modified: ${modified.join(', ')}`,
    );
  messages.push(
    'Registrations you added by hand (modules, policies) were not changed.',
  );
  return finish(plan, context, messages);
}

interface Check {
  readonly name: string;
  readonly status: 'pass' | 'warn' | 'fail';
  readonly detail: string;
}
/** `nestvexa doctor`: environment and configuration checks; never prints secrets. */
export function doctor(context: CommandContext): CommandResult {
  const checks: Check[] = [];
  const add = (name: string, status: Check['status'], detail: string) =>
    checks.push({ name, status, detail });
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  add(
    'node',
    (major === 22 && minor >= 13) || major === 24 ? 'pass' : 'fail',
    `Node ${process.versions.node} (supported: ^22.13 or ^24)`,
  );
  let project: ProjectInfo | undefined;
  try {
    project = detectProject(context.cwd);
    add(
      'nest',
      'pass',
      `@nestjs/core ${project.dependencies['@nestjs/core'] ?? ''}, ${project.platform}`,
    );
  } catch (error) {
    add('nest', 'fail', error instanceof Error ? error.message : String(error));
  }
  if (project) {
    const installed = (name: string): string | undefined => {
      const path = join(project.root, 'node_modules', name, 'package.json');
      if (!existsSync(path)) return undefined;
      const version: unknown = Reflect.get(
        JSON.parse(readFileSync(path, 'utf8')) as object,
        'version',
      );
      return typeof version === 'string' ? version : undefined;
    };
    const umbrella = installed('nestvexa');
    add(
      'nestvexa',
      umbrella ? 'pass' : 'fail',
      umbrella
        ? `nestvexa ${umbrella}`
        : 'nestvexa is not installed (run nestvexa init)',
    );
    const clients = new Set<string>();
    for (const path of [
      'node_modules/@nestvexa/client',
      'node_modules/nestvexa/node_modules/@nestvexa/client',
    ]) {
      const file = join(project.root, path, 'package.json');
      if (existsSync(file)) {
        const version: unknown = Reflect.get(
          JSON.parse(readFileSync(file, 'utf8')) as object,
          'version',
        );
        if (typeof version === 'string') clients.add(version);
      }
    }
    add(
      'client-duplicates',
      clients.size > 1 ? 'fail' : 'pass',
      clients.size > 1
        ? `Multiple @nestvexa/client versions: ${[...clients].join(', ')}`
        : 'One browser runtime',
    );
    const layout = join(project.root, 'views', 'layout.hbs');
    add(
      'layout',
      existsSync(layout) &&
        readFileSync(layout, 'utf8').includes('{{nvScripts}}')
        ? 'pass'
        : 'warn',
      existsSync(layout)
        ? 'views/layout.hbs should include {{nvScripts}} once'
        : 'views/layout.hbs not found',
    );
    const main = join(project.root, project.mainFile);
    const mainText = existsSync(main) ? readFileSync(main, 'utf8') : '';
    add(
      'configure',
      mainText.includes('configureNestvexa(') ? 'pass' : 'fail',
      'main.ts must call configureNestvexa(app) before listen()',
    );
    add(
      'session',
      /session\(/.test(mainText) ? 'pass' : 'warn',
      'Live needs host sessions/identity for CSRF tokens',
    );
    add(
      'secrets',
      /secret:\s*['"`][^'"`]+['"`]/.test(mainText) ? 'warn' : 'pass',
      /secret:\s*['"`][^'"`]+['"`]/.test(mainText)
        ? 'A literal session secret appears in main.ts; load it from the environment'
        : 'No literal session secret found (value not displayed)',
    );
  }
  const failed = checks.filter((check) => check.status === 'fail').length;
  return {
    ok: failed === 0,
    messages: checks.map(
      (check) =>
        `${check.status.toUpperCase().padEnd(4)} ${check.name}: ${check.detail}`,
    ),
    data: checks,
  };
}

function sourceFiles(
  directory: string,
  root: string,
  out: string[] = [],
): string[] {
  if (!existsSync(directory)) return out;
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, root, out);
    else if (/\.ts$/.test(entry) && !entry.endsWith('.d.ts')) out.push(path);
  }
  return out;
}
function stringArgument(
  node: ts.Decorator,
  property?: string,
): string | undefined {
  if (!ts.isCallExpression(node.expression)) return undefined;
  const [first] = node.expression.arguments;
  if (!first) return property ? undefined : '';
  if (ts.isStringLiteralLike(first)) return property ? undefined : first.text;
  if (property && ts.isObjectLiteralExpression(first))
    for (const item of first.properties)
      if (
        ts.isPropertyAssignment(item) &&
        ts.isIdentifier(item.name) &&
        item.name.text === property &&
        ts.isStringLiteralLike(item.initializer)
      )
        return item.initializer.text;
  return undefined;
}
function decoratorName(node: ts.Decorator): string | undefined {
  const expression = ts.isCallExpression(node.expression)
    ? node.expression.expression
    : node.expression;
  return ts.isIdentifier(expression) ? expression.text : undefined;
}
/** Static source inspection (no application code is executed). */
export function inspect(context: CommandContext, what: string): CommandResult {
  const project = detectProject(context.cwd);
  const rows: Record<string, string>[] = [];
  for (const file of sourceFiles(
    join(project.root, project.sourceRoot),
    project.root,
  )) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const location = toPosix(relative(project.root, file));
    for (const statement of source.statements) {
      if (!ts.isClassDeclaration(statement) || !statement.name) continue;
      for (const decorator of ts.getDecorators(statement) ?? []) {
        const name = decoratorName(decorator);
        if (what === 'components' && name === 'LiveComponent')
          rows.push({
            name: stringArgument(decorator, 'name') ?? '?',
            class: statement.name.text,
            view: stringArgument(decorator, 'view') ?? '?',
            file: location,
          });
        if (
          (what === 'routes' || what === 'actions') &&
          (name === 'Controller' || name === 'LiveComponent')
        ) {
          const prefix =
            name === 'Controller'
              ? (stringArgument(decorator) ?? '')
              : `_nestvexa/live/${stringArgument(decorator, 'name') ?? '?'}`;
          for (const member of statement.members) {
            if (
              !ts.isMethodDeclaration(member) ||
              !member.name ||
              !ts.isIdentifier(member.name)
            )
              continue;
            for (const method of ts.getDecorators(member) ?? []) {
              const verb = decoratorName(method);
              if (
                what === 'routes' &&
                verb &&
                ['Get', 'Post', 'Put', 'Patch', 'Delete'].includes(verb) &&
                name === 'Controller'
              )
                rows.push({
                  method: verb.toUpperCase(),
                  path: `/${[prefix, stringArgument(method) ?? ''].filter(Boolean).join('/')}`.replace(
                    /\/+/g,
                    '/',
                  ),
                  handler: `${statement.name.text}.${member.name.text}`,
                  file: location,
                });
              if (
                what === 'actions' &&
                verb === 'Action' &&
                name === 'LiveComponent'
              )
                rows.push({
                  component: prefix.split('/').at(-1) ?? '?',
                  action: stringArgument(method, 'id') ?? member.name.text,
                  route: `POST /${prefix}/${stringArgument(method, 'id') ?? member.name.text}`,
                  file: location,
                });
            }
          }
        }
      }
    }
  }
  return {
    ok: true,
    messages: rows.length
      ? rows.map((row) => Object.values(row).join('  '))
      : [`No ${what} found in ${project.sourceRoot}/ (static inspection).`],
    data: rows,
  };
}

/** `nestvexa check`: doctor plus a strict TypeScript compile of the project. */
export function check(context: CommandContext): CommandResult {
  const report = doctor(context);
  const project = detectProject(context.cwd);
  const config = ts.findConfigFile(
    project.root,
    ts.sys.fileExists,
    'tsconfig.json',
  );
  if (!config)
    return {
      ok: false,
      messages: [...report.messages, 'FAIL tsconfig.json not found'],
    };
  const parsed = ts.getParsedCommandLineOfConfigFile(
    config,
    { noEmit: true },
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
  );
  if (!parsed)
    return {
      ok: false,
      messages: [...report.messages, 'FAIL tsconfig.json is invalid'],
    };
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, noEmit: true },
  });
  const diagnostics = ts.getPreEmitDiagnostics(program).slice(0, 20);
  const messages = diagnostics.map((diagnostic) => {
    const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    if (!diagnostic.file || diagnostic.start === undefined)
      return `FAIL ts: ${text}`;
    const { line } = diagnostic.file.getLineAndCharacterOfPosition(
      diagnostic.start,
    );
    return `FAIL ${toPosix(relative(project.root, diagnostic.file.fileName))}:${line + 1} ${text}`;
  });
  return {
    ok: report.ok && !diagnostics.length,
    messages: [
      ...report.messages,
      diagnostics.length
        ? `${diagnostics.length} TypeScript error(s)`
        : 'PASS typescript: no errors',
      ...messages,
    ],
  };
}

export function build(context: CommandContext): CommandResult {
  const project = detectProject(context.cwd);
  const script = readPackage(project.root).scripts?.['build'];
  if (!script) throw new CliError('No "build" script in package.json');
  if (context.dryRun)
    return {
      ok: true,
      messages: [`Would run: ${project.packageManager} run build`],
    };
  const result = spawnSync(project.packageManager, ['run', 'build'], {
    cwd: project.root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return {
    ok: result.status === 0,
    messages: [result.status === 0 ? 'Build succeeded.' : 'Build failed.'],
  };
}

/** Version-aware codemods. None are required within the current 0.1 alpha line. */
export function migrate(context: CommandContext): CommandResult {
  const project = detectProject(context.cwd);
  const current = project.dependencies['nestvexa'] ?? 'not installed';
  return {
    ok: true,
    messages: [
      `nestvexa ${current}: no migrations are required for ${templates.version}.`,
    ],
    data: { from: current, to: templates.version, migrations: [] },
  };
}
export { projectPath };
