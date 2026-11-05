import { catalog, emit, paths } from './catalog.js';
import {
  finish,
  installDependencies,
  liveConfigPath,
  newPlan,
  registerInModule,
  registerLiveComponent,
  relativeImport,
} from './context.js';
import type { CommandContext, CommandResult, Names } from './context.js';
import { sentinel, templatesDirectory } from './context.js';
import { readManifest } from './plan.js';
import {
  actionsConfigPath,
  ensureActions,
  ensureEngine,
  ensureFramework,
  ensureIslandFramework,
} from './features.js';
import { CliError } from './plan.js';
import {
  addArrayElement,
  addDependencies,
  addObjectProperty,
  detectProject,
  ensureImport,
  names,
} from './project.js';
import type { ProjectInfo } from './project.js';
import { frameworks, islandWrapper } from './templates-app.js';
import type { Engine, Framework } from './templates-app.js';
import { version } from './templates.js';
import { pins } from './versions.js';

function option(context: CommandContext, name: string): string | undefined {
  const value = context.options[name];
  return typeof value === 'string' && value ? value : undefined;
}
function required(raw: string | undefined, usage: string): Names {
  if (!raw) throw new CliError(`Usage: ${usage}`, 2);
  return names(raw);
}
function isFramework(value: string): value is Framework {
  return value in frameworks;
}
const engineIds: readonly string[] = ['ejs', 'pug', 'nunjucks'];
function isEngine(value: string): value is Engine {
  return engineIds.includes(value);
}

/** `make:component <Name> [--view hbs] [--module <dir>]`. */
export function makeComponent(
  context: CommandContext,
  raw: string | undefined,
): CommandResult {
  const n = required(
    raw,
    'nestvexa make:component <Name> [--view hbs] [--module <dir>]',
  );
  const view = option(context, 'view') ?? 'hbs';
  if (view !== 'hbs')
    throw new CliError(
      `make:component --view ${view}: Live components share the umbrella's Handlebars renderer. Use an engine adapter as the Live renderer manually (docs/guides/template-engines.md).`,
      2,
    );
  const directory = option(context, 'module');
  if (
    directory !== undefined &&
    !/^[a-z][a-z0-9-]{0,62}(?:\/[a-z][a-z0-9-]{0,62}){0,3}$/.test(directory)
  )
    throw new CliError(
      '--module takes a lowercase source directory such as "billing"',
      2,
    );
  const project = detectProject(context.cwd);
  const plan = newPlan(project, `component:${n.kebab}`);
  const file = directory
    ? `${project.sourceRoot}/${directory}/components/${n.kebab}.component.ts`
    : paths.component(n, project);
  const rendered = catalog['component.class'];
  if (!rendered) throw new Error('component template missing');
  if (directory) {
    const definition = { ...rendered, path: () => file };
    plan.create(file, definition.render(n, project), {
      force: context.force,
      template: { id: 'component.class', version: definition.version },
    });
  } else emit(plan, project, 'component.class', n, context.force);
  emit(plan, project, 'component.view', n, context.force);
  const messages = [`Created ${n.pascal}Component (Live name "${n.kebab}").`];
  if (
    registerLiveComponent(
      plan,
      project,
      `${n.pascal}Component`,
      file,
      n.kebab,
      ['$mount', 'increment'],
    )
  )
    messages.push(
      'Registered it and authorized its actions in nestvexa.config.ts.',
    );
  else
    messages.push(
      'Register it in your LiveModule components and authorize "$mount"/"increment" in your policy.',
    );
  return finish(plan, context, messages);
}

/** `make:page <Name> [--renderer hbs|ejs|pug|nunjucks|react|vue|svelte]`. */
export function makePage(
  context: CommandContext,
  raw: string | undefined,
): CommandResult {
  const n = required(
    raw,
    'nestvexa make:page <Name> [--renderer hbs|ejs|pug|nunjucks|react|vue|svelte]',
  );
  const renderer = option(context, 'renderer') ?? 'hbs';
  if (renderer !== 'hbs' && !isEngine(renderer) && !isFramework(renderer))
    throw new CliError(
      `Unknown renderer "${renderer}". Use hbs, ejs, pug, nunjucks, react, vue or svelte.`,
      2,
    );
  const project = detectProject(context.cwd);
  const plan = newPlan(project, `page:${n.kebab}`);
  const notes: string[] = [];
  if (isEngine(renderer)) ensureEngine(plan, project, renderer, notes);
  if (isFramework(renderer)) ensureFramework(plan, project, renderer, notes);
  const controller = emit(
    plan,
    project,
    `page.controller.${renderer}`,
    n,
    context.force,
  );
  if (isFramework(renderer))
    emit(plan, project, `page.component.${renderer}`, n, context.force);
  else emit(plan, project, `page.view.${renderer}`, n, context.force);
  registerInModule(
    plan,
    project,
    'controllers',
    controller,
    [`${n.pascal}Controller`],
    `${n.pascal}Controller`,
    `${n.pascal}Controller`,
  );
  return finish(plan, context, [
    `Created page /${n.kebab} (${renderer}).`,
    ...notes,
    installDependencies(project, context, plan),
  ]);
}

export function makeLayout(
  context: CommandContext,
  raw: string | undefined,
): CommandResult {
  const n = required(raw, 'nestvexa make:layout <Name>');
  const project = detectProject(context.cwd);
  const plan = newPlan(project, `layout:${n.kebab}`);
  emit(plan, project, 'layout.view', n, context.force);
  return finish(plan, context, [
    `Created views/layouts/${n.kebab}.hbs. Render with { layout: 'layouts/${n.kebab}' }.`,
  ]);
}

export function makePolicy(
  context: CommandContext,
  raw: string | undefined,
): CommandResult {
  const n = required(raw, 'nestvexa make:policy <Name>');
  const project = detectProject(context.cwd);
  const plan = newPlan(project, `policy:${n.kebab}`);
  emit(plan, project, 'policy.guard', n, context.force);
  return finish(plan, context, [
    `Created ${n.pascal}Policy. It denies all requests until you implement allows().`,
  ]);
}

/** `make:resource <Name> [--crud] [--orm memory]`. */
export function makeResource(
  context: CommandContext,
  raw: string | undefined,
): CommandResult {
  const n = required(
    raw,
    'nestvexa make:resource <Name> [--crud] [--orm memory]',
  );
  const orm = option(context, 'orm') ?? 'memory';
  if (orm !== 'memory')
    throw new CliError(
      `--orm ${orm} is not generated by this CLI version; the in-memory service ("memory") is the only data layer. Replace ${n.pascal}Service with your ORM repository.`,
      2,
    );
  const project = detectProject(context.cwd);
  const plan = newPlan(project, `resource:${n.kebab}`);
  const crud = context.options['crud'] === true;
  emit(plan, project, 'resource.service', n, context.force);
  const component = emit(plan, project, 'resource.component', n, context.force);
  emit(plan, project, 'resource.view', n, context.force);
  const module = emit(
    plan,
    project,
    crud ? 'resource.module.crud' : 'resource.module',
    n,
    context.force,
  );
  const messages = [
    `Created ${n.pascal}Service, ${n.pascal}Module and the ${n.kebab}-table Live component.`,
  ];
  const configFile = liveConfigPath(project);
  const config = plan.read(configFile);
  // Registering the component is only safe when its service can be provided too.
  if (config?.includes('// nestvexa:imports')) {
    let next = ensureImport(
      config,
      relativeImport(configFile, module, project.esm),
      [`${n.pascal}Module`],
    );
    next = addArrayElement(
      next,
      'liveImports',
      `${n.pascal}Module`,
      `${n.pascal}Module`,
      'imports',
    );
    plan.update(configFile, next);
    registerLiveComponent(
      plan,
      project,
      `${n.pascal}TableComponent`,
      component,
      `${n.kebab}-table`,
      ['$mount', '$sync', 'create'],
    );
    messages.push(
      `Registered ${n.pascal}TableComponent with ${n.pascal}Module in liveImports and authorized "$mount", "$sync" and "create".`,
    );
  } else
    messages.push(
      `Import ${n.pascal}Module in your Live registration, register ${n.pascal}TableComponent and authorize "$mount", "$sync" and "create".`,
    );
  if (crud) {
    emit(plan, project, 'resource.controller', n, context.force);
    registerInModule(
      plan,
      project,
      'imports',
      module,
      [`${n.pascal}Module`],
      `${n.pascal}Module`,
      `${n.pascal}Module`,
    );
    messages.push(
      `Added GET/POST /${n.kebab} and DELETE /${n.kebab}/:id in ${n.pascal}Module. Guard them before production.`,
    );
  }
  return finish(plan, context, messages);
}

/** `make:form <Name>`: Live form with a Zod schema validated by @nestvexa/forms. */
export function makeForm(
  context: CommandContext,
  raw: string | undefined,
): CommandResult {
  const n = required(raw, 'nestvexa make:form <Name>');
  const project = detectProject(context.cwd);
  const plan = newPlan(project, `form:${n.kebab}`);
  addDependencies(plan, { '@nestvexa/forms': `^${version}`, ...pins('zod') });
  const file = emit(plan, project, 'form.component', n, context.force);
  emit(plan, project, 'form.view', n, context.force);
  const messages = [
    `Created ${n.pascal}Form (Live name "${n.kebab}-form") with a Zod schema; mount it with live.mount(${n.pascal}Form, request).`,
  ];
  if (
    registerLiveComponent(
      plan,
      project,
      `${n.pascal}Form`,
      file,
      `${n.kebab}-form`,
      ['$mount', '$sync', 'submit'],
    )
  )
    messages.push(
      'Registered it and authorized "$mount", "$sync" and "submit".',
    );
  else
    messages.push(
      `Register ${n.pascal}Form with Live and authorize "$mount", "$sync" and "submit".`,
    );
  messages.push(installDependencies(project, context, plan));
  return finish(plan, context, messages);
}

/** `make:action <Name>`: an @nestvexa/actions group registered in actions.config.ts. */
export function makeAction(
  context: CommandContext,
  raw: string | undefined,
): CommandResult {
  const n = required(raw, 'nestvexa make:action <Name>');
  const project = detectProject(context.cwd);
  const plan = newPlan(project, `action:${n.kebab}`);
  const notes: string[] = [];
  ensureActions(plan, project, notes);
  const file = emit(plan, project, 'action.group', n, context.force);
  const configFile = actionsConfigPath(project);
  const config = plan.read(configFile);
  const className = `${n.pascal}Actions`;
  if (config !== undefined) {
    let next = ensureImport(
      config,
      relativeImport(configFile, file, project.esm),
      [className],
    );
    next = addArrayElement(
      next,
      'actionGroups',
      className,
      className,
      'action-groups',
    );
    next = addObjectProperty(
      next,
      'allowedActions',
      n.kebab,
      "['greet']",
      'action-policy',
    );
    plan.update(configFile, next);
  }
  if (
    registerInModule(
      plan,
      project,
      'imports',
      configFile,
      ['actionsOptions'],
      'ActionsModule.register(actionsOptions)',
      'ActionsModule',
    )
  )
    plan.update(
      project.appModule,
      ensureImport(plan.read(project.appModule) ?? '', '@nestvexa/actions', [
        'ActionsModule',
      ]),
    );
  return finish(plan, context, [
    `Created ${className}: POST /_nestvexa/actions/${n.kebab}/greet, allowed in actions.config.ts.`,
    ...notes,
    'Generate the typed browser client with `nestvexa-actions-codegen --project tsconfig.json --out client/generated`.',
    installDependencies(project, context, plan),
  ]);
}

/** `make:island <Name> --renderer react|vue|svelte`. */
export function makeIsland(
  context: CommandContext,
  raw: string | undefined,
): CommandResult {
  const n = required(
    raw,
    'nestvexa make:island <Name> --renderer react|vue|svelte',
  );
  const renderer = option(context, 'renderer');
  if (!renderer || !isFramework(renderer))
    throw new CliError('make:island requires --renderer react|vue|svelte', 2);
  const project = detectProject(context.cwd);
  const plan = newPlan(project, `island:${n.kebab}`);
  const notes: string[] = [];
  ensureIslandFramework(plan, project, renderer, notes);
  emit(plan, project, `island.${renderer}`, n, context.force);
  let module = `./${n.kebab}`;
  if (renderer !== 'react') {
    const wrapper = `client/islands/${n.kebab}.island.ts`;
    plan.create(wrapper, islandWrapper(renderer, n.kebab), {
      force: context.force,
      template: { id: `island.${renderer}.wrapper`, version: 1 },
    });
    module = `./${n.kebab}.island`;
  }
  const client = plan.read('client/islands/index.ts');
  if (client !== undefined)
    plan.update(
      'client/islands/index.ts',
      addObjectProperty(
        client,
        'modules',
        n.kebab,
        `() => import('${module}').then((module) => module.default)`,
        'island-modules',
      ),
    );
  const registryFile = `${project.sourceRoot}/nestvexa/islands.ts`;
  const registry = plan.read(registryFile);
  if (registry !== undefined)
    plan.update(
      registryFile,
      addArrayElement(
        registry,
        'islands',
        `{ id: '${n.kebab}', framework: '${renderer}' }`,
        `'${n.kebab}'`,
        'islands',
      ),
    );
  return finish(plan, context, [
    `Created the ${renderer} island "${n.kebab}" and registered it on the server and in the client allowlist.`,
    `Render it with islands.render('${n.kebab}', { label: '${n.pascal}' }, { label: '${n.pascal}' }) and build with the build:islands script.`,
    ...notes,
    installDependencies(project, context, plan),
  ]);
}

type TestKind = 'component' | 'page' | 'form' | 'action' | 'smoke';
const testKinds: readonly TestKind[] = [
  'component',
  'page',
  'form',
  'action',
  'smoke',
];
function detectTestKind(
  project: ProjectInfo,
  n: Names,
  plan: ReturnType<typeof newPlan>,
): TestKind {
  if (plan.exists(paths.component(n, project))) return 'component';
  if (plan.exists(paths.form(n, project))) return 'form';
  if (plan.exists(paths.action(n, project))) return 'action';
  const page = paths.page(n, project);
  // Only plain MVC pages return a static model; Inertia/engine pages get a smoke test.
  if (plan.read(page)?.includes("@Render('pages/")) return 'page';
  return 'smoke';
}
/** `make:test <Name> [--kind component|page|form|action|smoke]`. */
export function makeTest(
  context: CommandContext,
  raw: string | undefined,
): CommandResult {
  const n = required(
    raw,
    'nestvexa make:test <Name> [--kind component|page|form|action|smoke]',
  );
  const project = detectProject(context.cwd);
  const plan = newPlan(project, `test:${n.kebab}`);
  const requested = option(context, 'kind');
  if (requested !== undefined && !testKinds.some((kind) => kind === requested))
    throw new CliError(`--kind must be one of ${testKinds.join(', ')}`, 2);
  const kind =
    (requested as TestKind | undefined) ?? detectTestKind(project, n, plan);
  const runner =
    project.dependencies['jest'] && !project.dependencies['vitest']
      ? 'jest'
      : 'vitest';
  if (runner === 'vitest') addDependencies(plan, {}, pins('vitest'));
  if (kind === 'smoke') addDependencies(plan, {}, pins('@nestjs/testing'));
  const file = emit(plan, project, `test.${kind}`, n, context.force);
  return finish(plan, context, [
    `Created ${file} (${kind} test for ${runner}).`,
    installDependencies(project, context, plan),
  ]);
}

/** `nestvexa templates`: generator templates, their versions and project overrides. */
export function listTemplates(context: CommandContext): CommandResult {
  const project = detectProject(context.cwd);
  const plan = newPlan(project, 'templates');
  const used = new Map<string, number>();
  for (const entry of Object.values(readManifest(project.root).files))
    if (entry.template)
      used.set(
        entry.template,
        Math.max(used.get(entry.template) ?? 0, entry.templateVersion ?? 0),
      );
  const rows = Object.entries(catalog).map(([id, definition]) => {
    const generated = used.get(id) ?? used.get(`custom:${id}`);
    return {
      id,
      version: definition.version,
      description: definition.description,
      overridden: plan.exists(`${templatesDirectory}/${id}`),
      outdated: generated !== undefined && generated < definition.version,
    };
  });
  return {
    ok: true,
    messages: rows.map(
      (row) =>
        `${row.id.padEnd(26)} v${row.version}${row.overridden ? ' (overridden)' : ''}${row.outdated ? ' (files from an older version)' : ''}  ${row.description}`,
    ),
    data: rows,
  };
}

/** `nestvexa templates:eject <id>`: copy a built-in template into .nestvexa/templates. */
export function ejectTemplate(
  context: CommandContext,
  id: string | undefined,
): CommandResult {
  const definition = id ? catalog[id] : undefined;
  if (!id || !definition)
    throw new CliError(
      `Usage: nestvexa templates:eject <id>. Known ids: ${Object.keys(catalog).join(', ')}`,
      2,
    );
  const project = detectProject(context.cwd);
  const plan = newPlan(project, 'templates');
  const path = `${templatesDirectory}/${id}`;
  plan.create(path, definition.render(sentinel, project), {
    force: context.force,
  });
  return finish(plan, context, [
    `Wrote ${path}. Edit it; ${sentinel.pascal}, ${sentinel.kebab} and ${sentinel.camel} are replaced by the generated name. Delete it to restore the built-in template.`,
  ]);
}
