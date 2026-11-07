import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { finish, installDependencies, newPlan } from './context.js';
import type { CommandContext, CommandResult } from './context.js';
import { doctor } from './doctor.js';
import { CliError, toPosix, untouchedGenerated } from './plan.js';
import { collectRoutes, decoratorName, sourceFiles } from './routes.js';
import {
  addDependencies,
  addModuleArrayEntry,
  detectProject,
  ensureImport,
  insertBeforeListen,
  readPackage,
} from './project.js';
import * as templates from './templates.js';
import { pins } from './versions.js';

export type { CommandContext, CommandResult } from './context.js';

/**
 * `nestvexa init`: wire HBS + Live + Alpine into an existing Nest app. Guest
 * sessions use express-session on Express and @fastify/session on Fastify.
 */
export function init(context: CommandContext): CommandResult {
  const project = detectProject(context.cwd);
  const fastify = project.platform === 'fastify';
  const plan = newPlan(project, 'init');
  const ext = project.esm ? '.js' : '';
  const base = project.sourceRoot;
  if (fastify)
    addDependencies(plan, {
      nestvexa: `^${templates.version}`,
      ...pins('@fastify/cookie', '@fastify/session'),
    });
  else
    addDependencies(
      plan,
      { nestvexa: `^${templates.version}`, ...pins('express-session') },
      pins('@types/express-session'),
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
    templates.componentClass('counter', 'Counter', 'nestvexa'),
    { force: context.force },
  );
  plan.create(
    `${base}/nestvexa/nestvexa.config.ts`,
    templates.liveConfig(project.esm, project.platform),
    {
      force: context.force,
    },
  );
  if (fastify)
    plan.create(
      `${base}/nestvexa/session.ts`,
      templates.fastifySession(project.esm),
      { force: context.force },
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
    fastify ? templates.fastifyMainSetup : templates.mainSetup,
    'configureNestvexa(',
  );
  if (main !== mainText && fastify) {
    main = ensureImport(main, 'nestvexa', ['configureNestvexa']);
    main = ensureImport(main, `./nestvexa/session${ext}`, ['configureSession']);
  } else if (main !== mainText) {
    main = ensureImport(main, 'nestvexa', ['configureNestvexa']);
    main = ensureImport(main, `./nestvexa/nestvexa.config${ext}`, [
      'sessionSecret',
    ]);
    if (!/import\s+session\s+from\s+['"]express-session['"]/.test(main))
      main = `import session from 'express-session';\n${main}`;
  }
  plan.update(project.mainFile, main);
  const messages = [
    'Nestvexa is configured: HBS views, Live counter and Alpine startup.',
    installDependencies(project, context, plan),
    'Start your app and open /nestvexa. Set NESTVEXA_ORIGIN and SESSION_SECRET for deployments.',
  ];
  return finish(plan, context, messages);
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
  const plan = newPlan(project, feature);
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
/** Static source inspection (no application code is executed). */
export function inspect(context: CommandContext, what: string): CommandResult {
  const project = detectProject(context.cwd);
  const rows: Record<string, string>[] =
    what === 'routes'
      ? collectRoutes(project).map((row) => ({
          method: row.method,
          path: row.path,
          handler: `${row.controller}.${row.handler}`,
          file: row.file,
        }))
      : [];
  for (const file of what === 'routes'
    ? []
    : sourceFiles(join(project.root, project.sourceRoot))) {
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
        if (what === 'actions' && name === 'LiveComponent') {
          const prefix = `_nestvexa/live/${stringArgument(decorator, 'name') ?? '?'}`;
          for (const member of statement.members) {
            if (
              !ts.isMethodDeclaration(member) ||
              !member.name ||
              !ts.isIdentifier(member.name)
            )
              continue;
            for (const method of ts.getDecorators(member) ?? []) {
              if (decoratorName(method) === 'Action')
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
  // One fixed command string: package managers are .cmd shims on Windows.
  const result = spawnSync(`${project.packageManager} run build`, {
    cwd: project.root,
    // Keep stdout machine-readable with --json.
    stdio: context.options['json'] ? ['ignore', 2, 2] : 'inherit',
    shell: true,
  });
  return {
    ok: result.status === 0,
    messages: [result.status === 0 ? 'Build succeeded.' : 'Build failed.'],
  };
}

/** Version-aware codemods. None are required within the current 0.1 alpha line. */
