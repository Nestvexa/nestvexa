import type { ChangePlan } from './plan.js';
import { relativeImport, template } from './context.js';
import type { Names } from './context.js';
import type { ProjectInfo } from './project.js';
import * as base from './templates.js';
import * as app from './templates-app.js';
import * as resource from './templates-resource.js';
import type { ResourceOptions, ResourceOrm } from './templates-resource.js';
import type { Engine, Framework, TestRunner } from './templates-app.js';

/**
 * User-facing generator templates. Each id can be overridden per project with
 * `nestvexa templates:eject <id>` (written to `.nestvexa/templates/<id>`); the
 * id and version of the template that produced a file are kept in the manifest.
 * Bump a version whenever its output changes.
 */
export interface TemplateDefinition {
  readonly version: number;
  readonly description: string;
  /** Project-relative output path. */
  readonly path: (names: Names, project: ProjectInfo) => string;
  readonly render: (names: Names, project: ProjectInfo) => string;
}

export function testRunner(project: ProjectInfo): TestRunner {
  return project.dependencies['jest'] && !project.dependencies['vitest']
    ? 'jest'
    : 'vitest';
}
const src = (project: ProjectInfo) => project.sourceRoot;
export const paths = {
  component: (n: Names, p: ProjectInfo) =>
    `${src(p)}/nestvexa/components/${n.kebab}.component.ts`,
  page: (n: Names, p: ProjectInfo) =>
    `${src(p)}/pages/${n.kebab}.controller.ts`,
  form: (n: Names, p: ProjectInfo) =>
    `${src(p)}/nestvexa/forms/${n.kebab}.form.ts`,
  action: (n: Names, p: ProjectInfo) =>
    `${src(p)}/actions/${n.kebab}.actions.ts`,
  resourceTable: (n: Names, p: ProjectInfo) =>
    `${src(p)}/${n.kebab}/${n.kebab}-table.component.ts`,
  smoke: (n: Names, p: ProjectInfo) =>
    `test/${n.kebab}.${testRunner(p) === 'jest' ? 'e2e-spec' : 'e2e.spec'}.ts`,
} as const;
const spec = (path: string) => path.replace(/\.ts$/, '.spec.ts');

function enginePage(engine: Engine): TemplateDefinition {
  const extension = app.engines[engine].extension;
  return {
    version: 1,
    description: `MVC controller rendering views/pages/<name>.${extension}`,
    path: paths.page,
    render: (n) =>
      app.enginePageController(
        n.kebab,
        n.pascal,
        `pages/${n.kebab}.${extension}`,
      ),
  };
}
function engineView(engine: Engine): TemplateDefinition {
  const extension = app.engines[engine].extension;
  return {
    version: 1,
    description: `${engine} page view`,
    path: (n) => `views/pages/${n.kebab}.${extension}`,
    render: (n) => app.enginePageView(engine, n.pascal),
  };
}
function inertiaPageController(framework: Framework): TemplateDefinition {
  return {
    version: 1,
    description: `Controller rendering the ${framework} Inertia page <Name>`,
    path: paths.page,
    render: (n) =>
      app.inertiaPageController(n.kebab, n.pascal, n.pascal, framework),
  };
}
function inertiaPage(framework: Framework): TemplateDefinition {
  return {
    version: 1,
    description: `${framework} Inertia page component`,
    path: (n) =>
      `client/${framework}/pages/${n.pascal}.${app.frameworks[framework].page}`,
    render: (n) => app.inertiaPage(framework, n.pascal),
  };
}
function island(framework: Framework): TemplateDefinition {
  return {
    version: 1,
    description: `${framework} island component`,
    path: (n) =>
      `client/islands/${n.kebab}.${app.frameworks[framework].island}`,
    render: (n) => app.islandComponent(framework, n.kebab, n.pascal),
  };
}

/** Options of a `make:resource` template for this project. */
export function resourceOptions(
  project: ProjectInfo,
  orm: ResourceOrm,
  crud: boolean,
): ResourceOptions {
  return {
    esm: project.esm,
    orm,
    crud,
    runner: testRunner(project),
    platform: project.platform,
  };
}
const resourceFile = (suffix: string) => (n: Names, p: ProjectInfo) =>
  `${src(p)}/${n.kebab}/${n.kebab}${suffix}`;
function resourceEntries(): Record<string, TemplateDefinition> {
  const entry = (
    version: number,
    description: string,
    suffix: string,
    render: (n: Names, options: ResourceOptions) => string,
    orm: ResourceOrm = 'memory',
    crud = false,
  ): TemplateDefinition => ({
    version,
    description,
    path: resourceFile(suffix),
    render: (n, p) => render(n, resourceOptions(p, orm, crud)),
  });
  return {
    'resource.dto': entry(
      1,
      'Zod DTOs and adapters (create, update, list query)',
      '.dto.ts',
      resource.resourceDto,
    ),
    'resource.repository': entry(
      1,
      'Repository interface and injection token',
      '.repository.ts',
      resource.resourceRepository,
    ),
    'resource.repository.memory': entry(
      1,
      'In-memory repository (--orm memory, tests)',
      '.memory-repository.ts',
      resource.resourceMemoryRepository,
    ),
    'resource.repository.typeorm': entry(
      1,
      'TypeORM repository (--orm typeorm)',
      '.typeorm-repository.ts',
      resource.resourceTypeOrmRepository,
      'typeorm',
    ),
    'resource.entity.typeorm': entry(
      1,
      'TypeORM entity (--orm typeorm; no migration)',
      '.entity.ts',
      resource.resourceEntity,
      'typeorm',
    ),
    'resource.service': entry(
      2,
      'Resource service over the repository interface',
      '.service.ts',
      resource.resourceService,
    ),
    'resource.module': entry(
      2,
      'Resource module binding the in-memory repository',
      '.module.ts',
      resource.resourceModule,
    ),
    'resource.module.crud': entry(
      2,
      'Resource module with the REST controller (--crud)',
      '.module.ts',
      resource.resourceModule,
      'memory',
      true,
    ),
    'resource.module.typeorm': entry(
      1,
      'Resource module binding the TypeORM repository',
      '.module.ts',
      resource.resourceModule,
      'typeorm',
    ),
    'resource.module.typeorm.crud': entry(
      1,
      'TypeORM resource module with the REST controller',
      '.module.ts',
      resource.resourceModule,
      'typeorm',
      true,
    ),
    'resource.controller': entry(
      2,
      'Validated REST CRUD controller (--crud)',
      '.controller.ts',
      resource.resourceController,
      'memory',
      true,
    ),
    'resource.component': entry(
      2,
      'Live CRUD table: search, pages, validated create',
      '-table.component.ts',
      resource.resourceComponent,
    ),
    'resource.view': {
      version: 2,
      description: 'Live CRUD table view',
      path: (n) => `views/components/${n.kebab}-table.hbs`,
      render: (n) => resource.resourceView(n),
    },
    'resource.test.service': entry(
      1,
      'Service test over the in-memory repository',
      '.service.spec.ts',
      resource.resourceServiceTest,
    ),
    'resource.test.dto': entry(
      1,
      'DTO validation test',
      '.dto.spec.ts',
      resource.resourceDtoTest,
    ),
    'resource.test.controller': entry(
      1,
      'HTTP test of the REST controller (--crud)',
      '.controller.spec.ts',
      resource.resourceControllerTest,
      'memory',
      true,
    ),
  };
}

export const catalog: Readonly<Record<string, TemplateDefinition>> =
  Object.freeze({
    'component.class': {
      version: 1,
      description: 'Live component class',
      path: paths.component,
      render: (n) => base.componentClass(n.kebab, n.pascal, 'nestvexa'),
    },
    'component.view': {
      version: 1,
      description: 'Live component Handlebars view',
      path: (n) => `views/components/${n.kebab}.hbs`,
      render: (n) => base.componentView(n.kebab, n.pascal),
    },
    'page.controller.hbs': {
      version: 1,
      description: 'MVC controller rendering views/pages/<name>.hbs',
      path: paths.page,
      render: (n) => base.pageController(n.kebab, n.pascal),
    },
    'page.view.hbs': {
      version: 1,
      description: 'Handlebars page view',
      path: (n) => `views/pages/${n.kebab}.hbs`,
      render: (n) => base.pageView(n.pascal),
    },
    'page.controller.ejs': enginePage('ejs'),
    'page.controller.pug': enginePage('pug'),
    'page.controller.nunjucks': enginePage('nunjucks'),
    'page.view.ejs': engineView('ejs'),
    'page.view.pug': engineView('pug'),
    'page.view.nunjucks': engineView('nunjucks'),
    'page.controller.react': inertiaPageController('react'),
    'page.controller.vue': inertiaPageController('vue'),
    'page.controller.svelte': inertiaPageController('svelte'),
    'page.component.react': inertiaPage('react'),
    'page.component.vue': inertiaPage('vue'),
    'page.component.svelte': inertiaPage('svelte'),
    'layout.view': {
      version: 1,
      description: 'Handlebars document layout with {{nvScripts}}',
      path: (n) => `views/layouts/${n.kebab}.hbs`,
      render: () => base.layoutView(),
    },
    'policy.guard': {
      version: 2,
      description: 'Deny-by-default guard',
      path: (n, p) => `${src(p)}/policies/${n.kebab}.policy.ts`,
      render: (n) => base.policyGuard(n.pascal),
    },
    ...resourceEntries(),
    'form.component': {
      version: 1,
      description: 'Live form with a Zod schema and @nestvexa/forms validation',
      path: paths.form,
      render: (n) => app.formComponent(n.kebab, n.pascal, n.camel),
    },
    'form.view': {
      version: 2,
      description: 'Accessible form view',
      path: (n) => `views/components/${n.kebab}-form.hbs`,
      render: (n) => app.formView(n.kebab, n.pascal),
    },
    'action.group': {
      version: 1,
      description: '@nestvexa/actions group with one server action',
      path: paths.action,
      render: (n) => app.actionGroup(n.kebab, n.pascal),
    },
    'island.react': island('react'),
    'island.vue': island('vue'),
    'island.svelte': island('svelte'),
    'test.component': {
      version: 1,
      description: 'Unit test of a generated Live component',
      path: (n, p) => spec(paths.component(n, p)),
      render: (n, p) =>
        app.componentTest(
          testRunner(p),
          n.pascal,
          relativeImport(
            spec(paths.component(n, p)),
            paths.component(n, p),
            p.esm,
          ),
        ),
    },
    'test.page': {
      version: 1,
      description: 'Unit test of a generated page controller',
      path: (n, p) => spec(paths.page(n, p)),
      render: (n, p) =>
        app.pageTest(
          testRunner(p),
          n.pascal,
          relativeImport(spec(paths.page(n, p)), paths.page(n, p), p.esm),
        ),
    },
    'test.form': {
      version: 1,
      description: 'Schema test of a generated form',
      path: (n, p) => spec(paths.form(n, p)),
      render: (n, p) =>
        app.formTest(
          testRunner(p),
          n.camel,
          n.pascal,
          relativeImport(spec(paths.form(n, p)), paths.form(n, p), p.esm),
        ),
    },
    'test.action': {
      version: 1,
      description: 'Unit test of a generated action group',
      path: (n, p) => spec(paths.action(n, p)),
      render: (n, p) =>
        app.actionTest(
          testRunner(p),
          n.kebab,
          n.pascal,
          relativeImport(spec(paths.action(n, p)), paths.action(n, p), p.esm),
        ),
    },
    'test.smoke': {
      version: 2,
      description: 'HTTP smoke test booting AppModule',
      path: paths.smoke,
      render: (n, p) =>
        app.smokeTest(
          testRunner(p),
          n.pascal,
          `/${n.kebab}`,
          relativeImport(paths.smoke(n, p), p.appModule, p.esm),
        ),
    },
  });

/** Write a catalog template (or the project's override) into the plan. */
export function emit(
  plan: ChangePlan,
  project: ProjectInfo,
  id: string,
  names: Names,
  force: boolean,
): string {
  const definition = catalog[id];
  if (!definition) throw new Error(`Unknown template ${id}`);
  const path = definition.path(names, project);
  const rendered = template(project, id, definition.version, names, (n) =>
    definition.render(n, project),
  );
  plan.create(path, rendered.content, { force, template: rendered.template });
  return path;
}
