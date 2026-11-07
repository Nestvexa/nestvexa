import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { finish, newPlan, relativeImport } from './context.js';
import type { CommandContext, CommandResult } from './context.js';
import { configureNestvexaCall, patchMain } from './features.js';
import { formatPlan } from './format.js';
import { CliError, toPosix } from './plan.js';
import { detectProject } from './project.js';
import type { ProjectInfo } from './project.js';

/** HTTP methods a typed link can use (Inertia's `method` values, upper case). */
export const routeMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type RouteMethod = (typeof routeMethods)[number];
const decoratorMethods: Readonly<Record<string, RouteMethod>> = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
};

/** A controller route found by static inspection. */
export interface RouteRow {
  /** `ControllerClass.method`, the default name of `routesFromControllers`. */
  readonly name: string;
  readonly method: RouteMethod;
  readonly path: string;
  readonly controller: string;
  readonly handler: string;
  readonly file: string;
}
export interface RouteParameter {
  readonly name: string;
  readonly splat: boolean;
  readonly optional: boolean;
}

export function sourceFiles(directory: string, out: string[] = []): string[] {
  if (!existsSync(directory)) return out;
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.ts$/.test(entry) && !entry.endsWith('.d.ts')) out.push(path);
  }
  return out;
}
export function decoratorName(node: ts.Decorator): string | undefined {
  const expression = ts.isCallExpression(node.expression)
    ? node.expression.expression
    : node.expression;
  return ts.isIdentifier(expression) ? expression.text : undefined;
}
/** First string of a literal or array literal (Nest uses the first path for links too). */
function firstString(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isArrayLiteralExpression(node)) {
    const [head] = node.elements;
    return head && ts.isStringLiteralLike(head) ? head.text : undefined;
  }
  return undefined;
}
/**
 * The path argument of `@Controller(...)`/`@Get(...)`: a string, an array of
 * strings or `{ path }`. `''` when absent, undefined when not static.
 */
export function decoratorPath(node: ts.Decorator): string | undefined {
  if (!ts.isCallExpression(node.expression)) return '';
  const [first] = node.expression.arguments;
  if (!first) return '';
  if (ts.isObjectLiteralExpression(first)) {
    const path = first.properties.find(
      (item): item is ts.PropertyAssignment =>
        ts.isPropertyAssignment(item) &&
        ts.isIdentifier(item.name) &&
        item.name.text === 'path',
    );
    return path ? firstString(path.initializer) : '';
  }
  return firstString(first);
}
function joinPath(...parts: readonly string[]): string {
  return `/${parts
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')}`;
}

/** Controller routes of the project's source root, read with the TypeScript AST (no code runs). */
export function collectRoutes(project: ProjectInfo): RouteRow[] {
  const rows: RouteRow[] = [];
  for (const file of sourceFiles(
    join(project.root, project.sourceRoot),
  ).sort()) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const location = toPosix(relative(project.root, file));
    for (const statement of source.statements) {
      if (!ts.isClassDeclaration(statement) || !statement.name) continue;
      const controller = (ts.getDecorators(statement) ?? []).find(
        (decorator) => decoratorName(decorator) === 'Controller',
      );
      if (!controller) continue;
      const prefix = decoratorPath(controller);
      if (prefix === undefined) continue;
      for (const member of statement.members) {
        if (
          !ts.isMethodDeclaration(member) ||
          !member.name ||
          !ts.isIdentifier(member.name)
        )
          continue;
        for (const decorator of ts.getDecorators(member) ?? []) {
          const method = decoratorMethods[decoratorName(decorator) ?? ''];
          const path = method ? decoratorPath(decorator) : undefined;
          if (!method || path === undefined) continue;
          rows.push({
            name: `${statement.name.text}.${member.name.text}`,
            method,
            path: joinPath(prefix, path),
            controller: statement.name.text,
            handler: member.name.text,
            file: location,
          });
        }
      }
    }
  }
  return rows;
}

const parameterName = /^[A-Za-z_$][\w$]{0,63}/;
/**
 * Parameters of a Nest/Express 5 path (the subset `RouteTable` in
 * `@nestvexa/views` reverses): `:name`, `*name` and optional `{...}` groups.
 * Undefined when the pattern cannot be reversed into a link.
 */
export function routeParameters(path: string): RouteParameter[] | undefined {
  if (path.length > 512 || /[?#()\\\s]/.test(path)) return undefined;
  const out: RouteParameter[] = [];
  let optional = false;
  for (let index = 0; index < path.length; index++) {
    const char = path.charAt(index);
    if (char === '{') {
      if (optional) return undefined;
      optional = true;
    } else if (char === '}') {
      if (!optional) return undefined;
      optional = false;
    } else if (char === ':' || char === '*') {
      const match = parameterName.exec(path.slice(index + 1));
      if (!match) return undefined;
      out.push({ name: match[0], splat: char === '*', optional });
      index += match[0].length;
    }
  }
  return optional ? undefined : out;
}

const quote = (text: string) =>
  `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
/** `src/nestvexa/routes.ts`: the typed route map and dependency-free URL builder. */
export function routesModule(rows: readonly RouteRow[]): string {
  const entries = rows.map(
    (row) =>
      `  ${quote(row.name)}: { method: '${row.method}', path: ${quote(row.path)} },`,
  );
  const params = rows.map((row) => {
    const fields = (routeParameters(row.path) ?? []).map(
      (parameter) =>
        `readonly ${parameter.name}${parameter.optional ? '?' : ''}: ${parameter.splat ? 'RouteValue | readonly RouteValue[]' : 'RouteValue'}`,
    );
    return `  ${quote(row.name)}: ${fields.length ? `{ ${fields.join('; ')} }` : 'Record<never, never>'};`;
  });
  return `/**
 * Typed route map generated by \`nestvexa routes:types\` from the controllers
 * in the source root (static inspection: routes registered at runtime, global
 * prefixes and versions are not included). Do not edit; rerun the command
 * after changing routes. It imports nothing, so server code and every
 * frontend root can use it. Names follow \`routesFromControllers\`.
 */
export const routes = {
${entries.join('\n')}
} as const;

export type RouteName = keyof typeof routes;
export type RouteValue = string | number;
type QueryValue = string | number | boolean | null | undefined;
export type RouteQuery = Readonly<Record<string, QueryValue | readonly QueryValue[]>>;
/** Path parameters of each route. Other keys become the query string. */
export type RouteParams = {
${params.join('\n')}
};
/** \`params\` is optional when the route has no required path parameter. */
export type RouteArgs<Name extends RouteName> =
  Record<never, never> extends RouteParams[Name]
    ? [params?: RouteParams[Name] & RouteQuery]
    : [params: RouteParams[Name] & RouteQuery];

const routeNames: ReadonlySet<string> = new Set(Object.keys(routes));
/** Narrows a string (for example view data) to a known route name. */
export function isRouteName(name: string): name is RouteName {
  return routeNames.has(name);
}

function segment(name: string, key: string, value: unknown): string {
  const text =
    typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : typeof value === 'string'
        ? value
        : undefined;
  // "." and ".." would be normalized by browsers into another route.
  if (text === undefined || text === '' || text === '.' || text === '..')
    throw new TypeError(\`Route \${name} needs a string or number for parameter \${key}\`);
  return encodeURIComponent(text);
}
function expand(name: string, pattern: string, params: Readonly<Record<string, unknown>>, used: Set<string>): string {
  return pattern.replace(/\\{([^}]*)\\}|([:*])([A-Za-z_$][\\w$]*)/g, (match, group: string | undefined, kind: string | undefined, key: string | undefined) => {
    if (group !== undefined) {
      const keys = [...group.matchAll(/[:*]([A-Za-z_$][\\w$]*)/g)].map((found) => found[1] ?? '');
      for (const item of keys) used.add(item);
      const present = keys.every((item) => params[item] !== undefined && params[item] !== null && params[item] !== '');
      return present ? expand(name, group, params, used) : '';
    }
    const id = key ?? '';
    used.add(id);
    const value = Object.hasOwn(params, id) ? params[id] : undefined;
    if (kind !== '*') return segment(name, id, value);
    const items: readonly unknown[] = Array.isArray(value) ? value : typeof value === 'string' ? value.split('/') : [value];
    return items.map((item) => segment(name, id, item)).join('/');
  });
}

/**
 * URL of a named route. Path parameters are percent-encoded per segment;
 * unused parameters become the query string (undefined and null are skipped).
 * Same rules as \`RouteTable#url\` in \`@nestvexa/views\`.
 */
export function route<Name extends RouteName>(name: Name, ...[params]: RouteArgs<Name>): string {
  if (!isRouteName(name)) throw new TypeError(\`Unknown route: \${String(name)}\`);
  const values: Readonly<Record<string, unknown>> = params ?? {};
  const used = new Set<string>();
  const pathname = expand(name, routes[name].path, values, used);
  const query = new URLSearchParams();
  for (const key of Object.keys(values).sort()) {
    const item = values[key];
    if (used.has(key) || key === '__proto__' || item === undefined || item === null) continue;
    for (const entry of Array.isArray(item) ? item : [item]) {
      if (typeof entry !== 'string' && typeof entry !== 'boolean' && !(typeof entry === 'number' && Number.isFinite(entry)))
        throw new TypeError(\`Route \${name} query parameter \${key} must be a string, number or boolean\`);
      query.append(key, String(entry));
    }
  }
  const search = query.toString();
  return search ? \`\${pathname}?\${search}\` : pathname;
}

/**
 * \`{ href, method }\` for Inertia's \`Link\` in every framework:
 * \`<Link {...routeLink('TaskController.list')}>\` (React, Svelte) or
 * \`<Link v-bind="routeLink('TaskController.list')">\` (Vue). Use \`as="button"\`
 * for routes that are not GET.
 */
export function routeLink<Name extends RouteName>(
  name: Name,
  ...args: RouteArgs<Name>
): { readonly href: string; readonly method: Lowercase<(typeof routes)[Name]['method']> } {
  const method = routes[name].method.toLowerCase() as Lowercase<(typeof routes)[Name]['method']>;
  return { href: route(name, ...args), method };
}
`;
}
/** `src/nestvexa/route-helpers.ts`: the `{{route}}` view helper over the same map. */
export function routeHelpersModule(esm: boolean): string {
  return `import type { INestApplication } from '@nestjs/common';
import { HbsEngine, RouteTable, routeHelpers } from 'nestvexa';
import { routes } from './routes${esm ? '.js' : ''}';

/** Server-side links over the generated route map (\`routeTable.url(name, params)\`). */
export const routeTable = new RouteTable(
  Object.fromEntries(Object.entries(routes).map(([name, { path }]) => [name, path])),
);

/** Registers {{route "TaskController.list" page=2}} with Handlebars. Call before configureNestvexa(app). */
export function configureRouteHelpers(app: INestApplication): void {
  app.get(HbsEngine).registerHelpers(routeHelpers(routeTable));
}
`;
}

/**
 * \`nestvexa routes:types [--check]\`: writes the typed route map of every
 * controller route and, once, the \`{{route}}\` view helper wired in main.ts.
 * \`--check\` only reports whether the committed map is current (exit 1 if not).
 */
export function routesTypes(context: CommandContext): CommandResult {
  const project = detectProject(context.cwd);
  const all = collectRoutes(project);
  const seen = new Map<string, string>();
  const rows: RouteRow[] = [];
  const notes: string[] = [];
  for (const row of all) {
    const other = seen.get(row.name);
    if (other !== undefined && other !== row.file)
      throw new CliError(
        `Two controllers are named ${row.controller} (${other} and ${row.file}); route names must be unique.`,
      );
    if (other !== undefined)
      notes.push(
        `Skipped ${row.method} ${row.path}: ${row.name} is already mapped to its first route.`,
      );
    else if (routeParameters(row.path) === undefined)
      notes.push(
        `Skipped ${row.name} (${row.path}): the pattern cannot be reversed into a link.`,
      );
    else rows.push(row);
    seen.set(row.name, row.file);
  }
  const file = `${project.sourceRoot}/nestvexa/routes.ts`;
  const content = routesModule(rows);
  const plan = newPlan(project, 'routes');
  if (context.options['check'] === true) {
    // Compare with the map as `routes:types` would write it (formatted).
    plan.create(file, content, { force: true });
    if (context.options['no-format'] !== true) formatPlan(plan);
    const current = plan.read(file) === plan.original(file);
    return {
      ok: current,
      messages: [
        current
          ? `${file} is up to date (${rows.length} routes).`
          : `FAIL ${file} is out of date; run \`nestvexa routes:types\`.`,
        ...notes,
      ],
      data: rows,
    };
  }
  // Derived output: always rewritten, recorded like other generated files.
  plan.create(file, content, {
    force: true,
    template: { id: 'routes.map', version: 1 },
  });
  const helpers = `${project.sourceRoot}/nestvexa/route-helpers.ts`;
  const messages = [`Wrote ${rows.length} typed routes to ${file}.`, ...notes];
  if (
    plan.ensure(helpers, routeHelpersModule(project.esm), {
      template: { id: 'routes.helpers', version: 1 },
    })
  ) {
    patchMain(
      plan,
      project,
      'configureRouteHelpers(app);',
      'configureRouteHelpers',
      helpers,
      messages,
      configureNestvexaCall,
    );
    messages.push(
      'Registered the {{route "Controller.method" param=value}} view helper in main.ts.',
    );
  }
  messages.push(
    `Build links with route() and routeLink() from ${file}; frontend roots import '${relativeImport('client/react/page.ts', file, false)}' (Inertia: <Link {...routeLink('${rows[0]?.name ?? 'AppController.getHello'}')}>).`,
  );
  return finish(plan, context, messages, rows);
}
