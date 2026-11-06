import { emit } from './catalog.js';
import {
  finish,
  installDependencies,
  liveConfigPath,
  newPlan,
  registerInModule,
  relativeImport,
} from './context.js';
import type { CommandContext, CommandResult } from './context.js';
import { CliError } from './plan.js';
import type { ChangePlan } from './plan.js';
import {
  addArrayElement,
  addDependencies,
  addFactoryInjection,
  addFactoryResultProperty,
  addObjectProperty,
  addScripts,
  detectProject,
  ensureDefaultImport,
  ensureImport,
  excludeFromServerBuild,
  extendScript,
  hasStatement,
  insertBeforeListen,
  insertBeforeStatement,
} from './project.js';
import type { ProjectInfo } from './project.js';
import * as app from './templates-app.js';
import type { Engine, Framework } from './templates-app.js';
import { version } from './templates.js';
import { pins } from './versions.js';

const range = `^${version}`;
/** Collects what a setup did, for the command output. */
type Notes = string[];

function first(project: ProjectInfo, path: string): string {
  return `${project.sourceRoot}/${path}`;
}
/** Patch main.ts with `call` before `await app.listen()`, importing `name` from `file`. */
function patchMain(
  plan: ChangePlan,
  project: ProjectInfo,
  statement: string,
  name: string,
  file: string,
  notes: Notes,
  before?: { pattern: RegExp; description: string },
): void {
  const main = plan.read(project.mainFile);
  if (main === undefined) {
    notes.push(`Call ${statement} in your bootstrap before app.listen().`);
    return;
  }
  const marker = `${name}(`;
  let next =
    before && hasStatement(main, before.pattern)
      ? insertBeforeStatement(
          main,
          statement,
          marker,
          before.pattern,
          before.description,
        )
      : insertBeforeListen(main, statement, marker);
  if (next !== main)
    next = ensureImport(
      next,
      relativeImport(project.mainFile, file, project.esm),
      [name],
    );
  plan.update(project.mainFile, next);
}
const configureNestvexaCall = {
  pattern: /^awaitconfigureNestvexa\(/,
  description: '`await configureNestvexa(app)` in main.ts',
};

// ---------------------------------------------------------------- engines

export function ensureEngine(
  plan: ChangePlan,
  project: ProjectInfo,
  engine: Engine,
  notes: Notes,
): void {
  const { package: name, extension } = app.engines[engine];
  // registerViewEngine comes from the umbrella package (`nestvexa init`).
  addDependencies(plan, { [name]: range, nestvexa: range });
  const file = first(project, `nestvexa/engines/${engine}.engine.ts`);
  if (plan.ensure(file, app.engineConfig(engine)))
    notes.push(`Created ${file} (views/*.${extension} render with ${engine}).`);
  plan.ensure(`views/layouts/main.${extension}`, app.engineLayout(engine));
  patchMain(
    plan,
    project,
    `await ${app.engineFunction(engine)}(app);`,
    app.engineFunction(engine),
    file,
    notes,
  );
}

// ---------------------------------------------------------------- inertia

function inertiaConfigPath(project: ProjectInfo): string {
  return first(project, 'nestvexa/inertia.config.ts');
}
export function ensureInertia(
  plan: ChangePlan,
  project: ProjectInfo,
  notes: Notes,
): void {
  addDependencies(
    plan,
    { '@nestvexa/inertia': range, '@nestvexa/vite': range },
    pins('vite'),
  );
  const file = inertiaConfigPath(project);
  if (
    plan.ensure(
      file,
      app.inertiaConfig(
        project.dependencies['express-session'] !== undefined ||
          project.dependencies['@fastify/session'] !== undefined,
      ),
    )
  )
    notes.push(`Created ${file}.`);
  if (
    !registerInModule(
      plan,
      project,
      'imports',
      file,
      ['inertiaOptions'],
      'InertiaModule.forRoot(inertiaOptions())',
      'InertiaModule',
    )
  )
    notes.push(
      'Import InertiaModule.forRoot(inertiaOptions()) in your root module.',
    );
  else {
    const module = plan.read(project.appModule) ?? '';
    plan.update(
      project.appModule,
      ensureImport(module, '@nestvexa/inertia', ['InertiaModule']),
    );
  }
  patchMain(
    plan,
    project,
    'configureInertia(app);',
    'configureInertia',
    file,
    notes,
  );
}

const frameworkDependencies: Readonly<
  Record<
    Framework,
    { deps: Record<string, string>; dev: Record<string, string> }
  >
> = {
  react: {
    deps: {
      '@nestvexa/react': range,
      ...pins('@inertiajs/react', 'react', 'react-dom'),
    },
    dev: pins(
      '@inertiajs/core',
      '@types/react',
      '@types/react-dom',
      '@vitejs/plugin-react',
      'vite',
    ),
  },
  vue: {
    deps: { '@nestvexa/vue': range, ...pins('@inertiajs/vue3', 'vue') },
    dev: pins('@inertiajs/core', '@vitejs/plugin-vue', 'vite', 'vue-tsc'),
  },
  svelte: {
    deps: { '@nestvexa/svelte': range, ...pins('@inertiajs/svelte', 'svelte') },
    dev: pins(
      '@inertiajs/core',
      '@sveltejs/vite-plugin-svelte',
      'svelte-check',
      'vite',
    ),
  },
};
function run(project: ProjectInfo, script: string): string {
  return project.packageManager === 'npm'
    ? `npm run ${script}`
    : `${project.packageManager} run ${script}`;
}
function typecheckCommand(framework: Framework): string {
  if (framework === 'react') return 'tsc -p client/react/tsconfig.json';
  if (framework === 'vue') return 'vue-tsc -p client/vue/tsconfig.json';
  return 'svelte-check --tsconfig client/svelte/tsconfig.json --fail-on-warnings';
}
/** An independent Inertia root for one framework: Vite entry, config, scripts and a welcome page. */
export function ensureFramework(
  plan: ChangePlan,
  project: ProjectInfo,
  framework: Framework,
  notes: Notes,
): void {
  ensureInertia(plan, project, notes);
  const { deps, dev } = frameworkDependencies[framework];
  addDependencies(plan, deps, dev);
  const meta = app.frameworks[framework];
  const directory = `client/${framework}`;
  const created = plan.ensure(
    `${directory}/${meta.entry}`,
    app.inertiaApp(framework),
  );
  plan.ensure(`${directory}/setup.ts`, app.inertiaSetup(framework));
  plan.ensure(app.ssrEntry(framework), app.inertiaSsr(framework));
  plan.ensure(
    `${directory}/tsconfig.json`,
    app.inertiaClientTsconfig(framework),
  );
  plan.ensure(`vite.${framework}.config.ts`, app.inertiaViteConfig(framework));
  const configFile = inertiaConfigPath(project);
  const config = plan.read(configFile);
  if (config !== undefined)
    plan.update(
      configFile,
      addObjectProperty(
        config,
        'inertiaFrameworks',
        framework,
        `{ entry: '${directory}/${meta.entry}', ssr: '${app.ssrEntry(framework)}', devPort: ${meta.devPort} }`,
        'inertia-apps',
      ),
    );
  addScripts(plan, {
    [`dev:${framework}`]: `vite -c vite.${framework}.config.ts`,
    [`build:${framework}`]: `vite build -c vite.${framework}.config.ts && vite build -c vite.${framework}.config.ts --ssr ${app.ssrEntry(framework)}`,
    [`typecheck:${framework}`]: typecheckCommand(framework),
  });
  extendScript(plan, 'build:client', run(project, `build:${framework}`));
  for (const tsconfig of ['tsconfig.json', 'tsconfig.build.json']) {
    const hint = excludeFromServerBuild(plan, tsconfig, [
      'client',
      'vite.*.config.ts',
    ]);
    if (hint) notes.push(hint);
  }
  if (created) {
    const names = { pascal: 'Welcome', kebab: framework, camel: 'welcome' };
    emit(plan, project, `page.component.${framework}`, names, false);
    const controller = `${project.sourceRoot}/pages/${framework}-welcome.controller.ts`;
    plan.ensure(
      controller,
      app.inertiaPageController(
        framework,
        `${meta.label}Welcome`,
        'Welcome',
        framework,
      ),
    );
    registerInModule(
      plan,
      project,
      'controllers',
      controller,
      [`${meta.label}WelcomeController`],
      `${meta.label}WelcomeController`,
      `${meta.label}WelcomeController`,
    );
    notes.push(
      `${meta.label} root ready: ${run(project, `dev:${framework}`)} (Vite on port ${meta.devPort}) next to your Nest server, then open /${framework}. Production: ${run(project, 'build:client')} and NODE_ENV=production.`,
    );
  }
}

// ---------------------------------------------------------------- islands

function islandsRegistryPath(project: ProjectInfo): string {
  return first(project, 'nestvexa/islands.ts');
}
export function ensureIslands(
  plan: ChangePlan,
  project: ProjectInfo,
  notes: Notes,
): void {
  addDependencies(
    plan,
    { '@nestvexa/islands': range, '@nestvexa/vite': range },
    pins('vite'),
  );
  if (plan.ensure(islandsRegistryPath(project), app.islandsRegistry()))
    notes.push(`Created ${islandsRegistryPath(project)} (server allowlist).`);
  plan.ensure('client/islands/index.ts', app.islandsClient());
  plan.ensure('client/islands/shims.d.ts', app.islandsShims());
  plan.ensure('client/islands/tsconfig.json', app.islandsTsconfig());
  plan.ensure('vite.islands.config.ts', app.islandsViteConfig());
  const serve = first(project, 'nestvexa/islands.serve.ts');
  plan.ensure(serve, app.islandsServe());
  patchMain(
    plan,
    project,
    'configureIslands(app);',
    'configureIslands',
    serve,
    notes,
  );
  addScripts(plan, {
    'build:islands': 'vite build -c vite.islands.config.ts',
    'typecheck:islands': 'tsc -p client/islands/tsconfig.json',
  });
  extendScript(plan, 'build:client', run(project, 'build:islands'));
  for (const tsconfig of ['tsconfig.json', 'tsconfig.build.json']) {
    const hint = excludeFromServerBuild(plan, tsconfig, [
      'client',
      'vite.*.config.ts',
    ]);
    if (hint) notes.push(hint);
  }
  const layout = plan.read('views/layout.hbs');
  const tag = '<script type="module" src="/islands/islands.js"></script>';
  if (layout !== undefined && !layout.includes('/islands/islands.js')) {
    if (layout.includes('</body>'))
      plan.update(
        'views/layout.hbs',
        layout.replace('</body>', `    ${tag}\n  </body>`),
      );
    else notes.push(`Add ${tag} to your layout.`);
  } else if (layout === undefined)
    notes.push(`Add ${tag} to your document layout.`);
}
const islandPlugins: Readonly<
  Record<
    Framework,
    { module: string; name: string; call: string; default: boolean }
  >
> = {
  react: {
    module: '@vitejs/plugin-react',
    name: 'react',
    call: 'react()',
    default: true,
  },
  vue: {
    module: '@vitejs/plugin-vue',
    name: 'vue',
    call: 'vue()',
    default: true,
  },
  svelte: {
    module: '@sveltejs/vite-plugin-svelte',
    name: 'svelte',
    call: 'svelte()',
    default: false,
  },
};
const islandDependencies: Readonly<
  Record<
    Framework,
    { deps: Record<string, string>; dev: Record<string, string> }
  >
> = {
  react: {
    deps: pins('react', 'react-dom'),
    dev: pins('@types/react', '@types/react-dom', '@vitejs/plugin-react'),
  },
  vue: { deps: pins('vue'), dev: pins('@vitejs/plugin-vue') },
  svelte: { deps: pins('svelte'), dev: pins('@sveltejs/vite-plugin-svelte') },
};
/** Framework runtime and Vite plugin of the islands bundle. */
export function ensureIslandFramework(
  plan: ChangePlan,
  project: ProjectInfo,
  framework: Framework,
  notes: Notes,
): void {
  ensureIslands(plan, project, notes);
  addDependencies(
    plan,
    islandDependencies[framework].deps,
    islandDependencies[framework].dev,
  );
  const plugin = islandPlugins[framework];
  const config = plan.read('vite.islands.config.ts');
  if (config === undefined) return;
  let next = addArrayElement(
    config,
    'plugins',
    plugin.call,
    plugin.call,
    'island-plugins',
  );
  if (next !== config)
    next = plugin.default
      ? ensureDefaultImport(next, plugin.module, plugin.name)
      : ensureImport(next, plugin.module, [plugin.name]);
  plan.update('vite.islands.config.ts', next);
}

// ---------------------------------------------------------------- actions

export function actionsConfigPath(project: ProjectInfo): string {
  return first(project, 'nestvexa/actions.config.ts');
}
export function ensureActions(
  plan: ChangePlan,
  project: ProjectInfo,
  notes: Notes,
): void {
  addDependencies(plan, { '@nestvexa/actions': range });
  if (
    plan.ensure(actionsConfigPath(project), app.actionsConfig(project.platform))
  )
    notes.push(
      `Created ${actionsConfigPath(project)}. ActionsModule is registered with your first \`nestvexa make:action\` (it requires a non-empty group list).`,
    );
}

// ---------------------------------------------------------------- live wiring

/** Add `browser.<key>` to the generated Live registration. */
function liveBrowserOption(
  plan: ChangePlan,
  project: ProjectInfo,
  key: string,
  value: string,
  notes: Notes,
): void {
  const file = liveConfigPath(project);
  const text = plan.read(file);
  if (text === undefined || !text.includes('export const nestvexaLive')) {
    notes.push(
      `Pass browser: { ${key}: ${value} } in your NestvexaModule.forRoot Live registration.`,
    );
    return;
  }
  plan.update(
    file,
    addObjectProperty(text, 'nestvexaLive', key, value, undefined, ['browser']),
  );
}

// ---------------------------------------------------------------- add

const features = [
  'engine',
  'react',
  'vue',
  'svelte',
  'inertia',
  'islands',
  'forms',
  'actions',
  'realtime',
  'redis',
  'uploads',
  'i18n',
  'devtools',
  'cache',
] as const;
type Feature = (typeof features)[number];
function isFeature(value: string | undefined): value is Feature {
  return features.some((feature) => feature === value);
}
const engineNames = ['hbs', 'ejs', 'pug', 'nunjucks'] as const;

export function add(
  context: CommandContext,
  feature: string | undefined,
  detail: string | undefined,
): CommandResult {
  if (!isFeature(feature))
    throw new CliError(
      `Unknown feature "${feature ?? ''}". Supported: ${features.join(', ')} (engine takes hbs|ejs|pug|nunjucks).`,
      2,
    );
  const project = detectProject(context.cwd);
  const plan = newPlan(
    project,
    `add:${feature}${feature === 'engine' ? `:${detail ?? ''}` : ''}`,
  );
  const notes: Notes = [];
  switch (feature) {
    case 'engine': {
      if (!engineNames.some((name) => name === detail))
        throw new CliError(
          'Usage: nestvexa add engine <hbs|ejs|pug|nunjucks>',
          2,
        );
      if (detail === 'hbs')
        notes.push('Handlebars is the default engine; nothing to add.');
      else ensureEngine(plan, project, detail as Engine, notes);
      break;
    }
    case 'react':
    case 'vue':
    case 'svelte':
      ensureFramework(plan, project, feature, notes);
      break;
    case 'inertia':
      ensureInertia(plan, project, notes);
      notes.push('Add a frontend root with `nestvexa add react|vue|svelte`.');
      break;
    case 'islands': {
      ensureIslands(plan, project, notes);
      const framework = detail as Framework | undefined;
      if (framework !== undefined) {
        if (!(framework in app.frameworks))
          throw new CliError(
            'Usage: nestvexa add islands [react|vue|svelte]',
            2,
          );
        ensureIslandFramework(plan, project, framework, notes);
      }
      notes.push(
        'Create islands with `nestvexa make:island <Name> --renderer react|vue|svelte`.',
      );
      break;
    }
    case 'forms':
      addDependencies(plan, { '@nestvexa/forms': range, ...pins('zod') });
      notes.push(
        'Generate a validated Live form with `nestvexa make:form <Name>`.',
      );
      break;
    case 'actions':
      ensureActions(plan, project, notes);
      break;
    case 'realtime':
      addRealtime(plan, project, notes);
      break;
    case 'redis':
      addRedis(plan, project, notes);
      break;
    case 'uploads':
      addUploads(plan, project, notes);
      break;
    case 'i18n':
      addI18n(plan, project, notes);
      break;
    case 'devtools':
      addDevtools(plan, project, notes);
      break;
    case 'cache':
      addDependencies(plan, { '@nestvexa/cache': range });
      notes.push('See the @nestvexa/cache README for usage.');
      break;
  }
  return finish(plan, context, [
    ...(plan.changes.length ? [] : [`${feature} is already set up.`]),
    ...notes,
    installDependencies(project, context, plan),
  ]);
}

function addRealtime(
  plan: ChangePlan,
  project: ProjectInfo,
  notes: Notes,
): void {
  addDependencies(plan, { '@nestvexa/realtime': range });
  const file = first(project, 'nestvexa/realtime.config.ts');
  plan.ensure(file, app.realtimeConfig(project.platform));
  if (
    registerInModule(
      plan,
      project,
      'imports',
      file,
      ['realtimeOptions'],
      'RealtimeModule.forRoot(realtimeOptions)',
      'RealtimeModule',
    )
  )
    plan.update(
      project.appModule,
      ensureImport(plan.read(project.appModule) ?? '', '@nestvexa/realtime', [
        'RealtimeModule',
      ]),
    );
  const live = liveConfigPath(project);
  const text = plan.read(live);
  const wired =
    text === undefined
      ? undefined
      : addFactoryInjection(
          text,
          'nestvexaLive',
          'RealtimeService',
          'realtime',
          'realtime',
        );
  if (text !== undefined && wired !== undefined) {
    plan.update(
      live,
      ensureImport(wired, '@nestvexa/realtime', ['RealtimeService']),
    );
    liveBrowserOption(
      plan,
      project,
      'realtime',
      "{ endpoint: '/_nestvexa/realtime' }",
      notes,
    );
    notes.push(
      'Live is wired to RealtimeService. Declare channels with @RealtimeChannels(), list readable prefixes in publicChannels and authorize "$sync".',
    );
  } else
    notes.push(
      'Pass RealtimeService as the Live `realtime` policy (inject: [RealtimeService]) and set browser.realtime (docs/guides/realtime.md).',
    );
  notes.push('Set REALTIME_SECRET (at least 32 bytes) in production.');
}
/** Realtime plus @nestvexa/realtime-redis: shared Live state and pub/sub when REDIS_URL is set. */
function addRedis(plan: ChangePlan, project: ProjectInfo, notes: Notes): void {
  addRealtime(plan, project, notes);
  addDependencies(plan, {
    '@nestvexa/live': range,
    '@nestvexa/realtime-redis': range,
  });
  const file = first(project, 'nestvexa/redis.config.ts');
  plan.ensure(file, app.redisConfig());
  const realtime = first(project, 'nestvexa/realtime.config.ts');
  const realtimeText = plan.read(realtime);
  if (realtimeText !== undefined) {
    let next = addObjectProperty(
      realtimeText,
      'realtimeOptions',
      'broker',
      'realtimeBroker()',
    );
    if (next !== realtimeText)
      next = ensureImport(next, relativeImport(realtime, file, project.esm), [
        'realtimeBroker',
      ]);
    plan.update(realtime, next);
  }
  const live = liveConfigPath(project);
  const liveText = plan.read(live);
  let next =
    liveText === undefined
      ? undefined
      : addFactoryResultProperty(
          liveText,
          'nestvexaLive',
          'store',
          'liveStore()',
        );
  if (liveText !== undefined && next !== undefined) {
    if (next !== liveText)
      next = ensureImport(next, relativeImport(live, file, project.esm), [
        'liveStore',
      ]);
    plan.update(live, next);
  } else
    notes.push(
      `Pass store: liveStore() (from ${file}) in your Live registration's useFactory.`,
    );
  notes.push(
    'Set REDIS_URL=redis://[user:password@]host:port[/db] (and REDIS_PREFIX per environment) on every replica; without it state stays in-process. Replicas must share REALTIME_SECRET, SESSION_SECRET and a session store (docs/guides/production-services.md).',
  );
}
function addUploads(
  plan: ChangePlan,
  project: ProjectInfo,
  notes: Notes,
): void {
  addDependencies(plan, { '@nestvexa/uploads': range });
  const file = first(project, 'nestvexa/uploads.config.ts');
  plan.ensure(file, app.uploadsConfig(project.platform));
  if (
    registerInModule(
      plan,
      project,
      'imports',
      file,
      ['uploadsOptions'],
      'UploadsModule.register(uploadsOptions)',
      'UploadsModule',
    )
  )
    plan.update(
      project.appModule,
      ensureImport(plan.read(project.appModule) ?? '', '@nestvexa/uploads', [
        'UploadsModule',
      ]),
    );
  const main = plan.read(project.mainFile);
  if (main !== undefined) {
    let next = insertBeforeListen(
      main,
      'await configureUploads(app);',
      'configureUploads(',
    );
    if (next !== main)
      next = ensureImport(next, '@nestvexa/uploads', ['configureUploads']);
    plan.update(project.mainFile, next);
  }
  liveBrowserOption(
    plan,
    project,
    'uploads',
    "{ endpoint: '/_nestvexa/uploads' }",
    notes,
  );
  notes.push(
    'Uploads are stored under storage/uploads (set UPLOADS_DIRECTORY in production). Add purposes in uploads.config.ts.',
  );
}
function addI18n(plan: ChangePlan, project: ProjectInfo, notes: Notes): void {
  addDependencies(plan, { '@nestvexa/i18n': range });
  const file = first(project, 'nestvexa/i18n.config.ts');
  plan.ensure(file, app.i18nConfig());
  plan.ensure('locales/en/common.json', app.i18nCatalog());
  if (
    registerInModule(
      plan,
      project,
      'imports',
      file,
      ['i18nOptions'],
      'I18nModule.forRootAsync({ global: true, useFactory: i18nOptions })',
      'I18nModule',
    )
  )
    plan.update(
      project.appModule,
      ensureImport(plan.read(project.appModule) ?? '', '@nestvexa/i18n', [
        'I18nModule',
      ]),
    );
  patchMain(
    plan,
    project,
    'configureI18n(app);',
    'configureI18n',
    file,
    notes,
    configureNestvexaCall,
  );
  notes.push(
    'Translate in views with {{t "welcome"}}; add locales under locales/<code>/ and to `locales` in i18n.config.ts. Use LocaleViewInterceptor on @Render routes for lang/dir.',
  );
}
function addDevtools(
  plan: ChangePlan,
  project: ProjectInfo,
  notes: Notes,
): void {
  addDependencies(plan, { '@nestvexa/observability': range });
  const file = first(project, 'nestvexa/devtools.ts');
  plan.ensure(file, app.devtoolsConfig());
  patchMain(
    plan,
    project,
    'configureDevtools(app);',
    'configureDevtools',
    file,
    notes,
  );
  notes.push(
    'Development errors now render with clickable file:line links (VS Code by default). The filter is skipped when NODE_ENV=production.',
  );
}
