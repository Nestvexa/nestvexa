import { RequestMethod } from '@nestjs/common';
import type { DynamicModule, Type } from '@nestjs/common';
import {
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants.js';
import { NestvexaError } from './errors.js';

/**
 * Typed routes: read Nest controller metadata (`@Controller`, `@Get`, …)
 * without starting the application, then generate a standalone TypeScript
 * module with a typed `route(name, params)` URL builder. Paths come from your
 * trusted source code; parameter values are always percent-encoded.
 */
export interface RouteDefinition {
  /** `<controller>.<method>` (controller class name without `Controller`, camel-cased) or a `@RouteName`. */
  readonly name: string;
  readonly method: string;
  /** Normalized template such as `/admin/users/:id`. */
  readonly path: string;
  readonly params: readonly RouteParam[];
}
export interface RouteParam {
  readonly name: string;
  /** `*name` wildcard: accepts several segments. */
  readonly wildcard: boolean;
  /** Inside an optional `{…}` group. */
  readonly optional: boolean;
}
export interface CollectRoutesOptions {
  /** Same value as `app.setGlobalPrefix()`, for example `api`. */
  readonly globalPrefix?: string;
}

const ROUTE_NAME = Symbol.for('nestvexa:route-name');
const namePattern = /^[a-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/;

/** Override the generated name of one handler (for example `users.show`). */
export function RouteName(name: string): MethodDecorator {
  if (!namePattern.test(name) || name.length > 128)
    throw new NestvexaError('INVALID_CONFIGURATION', 'Invalid route name');
  return (_target, _key, descriptor) => {
    Reflect.defineMetadata(ROUTE_NAME, name, descriptor.value as object);
    return descriptor;
  };
}

function strings(value: unknown): string[] {
  if (value === undefined) return [''];
  const list = Array.isArray(value) ? value : [value];
  return list.filter((entry): entry is string => typeof entry === 'string');
}
function join(...parts: string[]): string {
  const path = parts
    .map((part) => part.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return `/${path}`;
}

/** Parse `:id`, `*rest` and optional `{…}` groups (path-to-regexp v8 syntax). */
export function routeParams(path: string): RouteParam[] {
  const params: RouteParam[] = [];
  let depth = 0;
  for (let index = 0; index < path.length; index++) {
    const char = path[index];
    if (char === '{') depth++;
    else if (char === '}') depth = Math.max(0, depth - 1);
    else if (char === ':' || char === '*') {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(path.slice(index + 1));
      if (!match)
        throw new NestvexaError(
          'INVALID_CONFIGURATION',
          `Unsupported route path ${path}`,
        );
      params.push({
        name: match[0],
        wildcard: char === '*',
        optional: depth > 0,
      });
      index += match[0].length;
    }
  }
  return params;
}

function routeName(controller: Type, method: string): string {
  const base = controller.name.replace(/Controller$/, '') || controller.name;
  return `${base.charAt(0).toLowerCase()}${base.slice(1)}.${method}`;
}

/** Collect routes from controller classes in declaration order. */
export function collectRoutes(
  controllers: readonly Type[],
  options: CollectRoutesOptions = {},
): RouteDefinition[] {
  const routes: RouteDefinition[] = [];
  const seen = new Map<string, string>();
  for (const controller of controllers) {
    const prefixes = strings(Reflect.getMetadata(PATH_METADATA, controller));
    const prototype: unknown = controller.prototype;
    if (prototype === null || typeof prototype !== 'object') continue;
    for (const key of Object.getOwnPropertyNames(prototype)) {
      if (key === 'constructor') continue;
      const handler = Object.getOwnPropertyDescriptor(prototype, key)?.value;
      if (typeof handler !== 'function') continue;
      const verb: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
      if (typeof verb !== 'number') continue;
      const method = RequestMethod[verb] ?? 'GET';
      const custom: unknown = Reflect.getMetadata(ROUTE_NAME, handler);
      const name =
        typeof custom === 'string' ? custom : routeName(controller, key);
      const paths = strings(Reflect.getMetadata(PATH_METADATA, handler));
      // Several paths on one handler: the first is canonical for URL building.
      const prefix = prefixes[0] ?? '';
      const path = join(options.globalPrefix ?? '', prefix, paths[0] ?? '');
      const previous = seen.get(name);
      if (previous !== undefined)
        throw new NestvexaError(
          'DUPLICATE_REGISTRATION',
          `Duplicate route name ${name} (${previous} and ${method} ${path}); use @RouteName`,
        );
      seen.set(name, `${method} ${path}`);
      routes.push(
        Object.freeze({
          name,
          method,
          path,
          params: Object.freeze(routeParams(path)),
        }),
      );
    }
  }
  return routes;
}

function isDynamic(value: unknown): value is DynamicModule {
  return typeof value === 'object' && value !== null && 'module' in value;
}
/**
 * Walk a module graph statically (`@Module` imports, including dynamic
 * modules returned by `forRoot`) and return its controllers once each.
 * Modules registered asynchronously at runtime are not visible here.
 */
export function moduleControllers(root: Type | DynamicModule): Type[] {
  const controllers: Type[] = [];
  const visited = new Set<unknown>();
  const visit = (entry: unknown): void => {
    if (entry === undefined || entry === null || visited.has(entry)) return;
    visited.add(entry);
    const type: unknown = isDynamic(entry) ? entry.module : entry;
    if (typeof type !== 'function') return;
    const own = [
      ...((Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, type) as
        unknown[] | undefined) ?? []),
      ...(isDynamic(entry) ? (entry.controllers ?? []) : []),
    ];
    for (const controller of own)
      if (
        typeof controller === 'function' &&
        !controllers.includes(controller as Type)
      )
        controllers.push(controller as Type);
    const imports = [
      ...((Reflect.getMetadata(MODULE_METADATA.IMPORTS, type) as
        unknown[] | undefined) ?? []),
      ...(isDynamic(entry) ? (entry.imports ?? []) : []),
    ];
    for (const child of imports) visit(child);
  };
  visit(root);
  return controllers;
}

/** Build a URL path from a template; every value is percent-encoded. */
export function buildPath(
  template: string,
  params: Readonly<Record<string, unknown>> = {},
  query?: Readonly<Record<string, string | number | boolean | undefined>>,
): string {
  const declared = routeParams(template);
  for (const key of Object.keys(params))
    if (!declared.some((param) => param.name === key))
      throw new NestvexaError(
        'INVALID_CONFIGURATION',
        `Unknown route parameter ${key}`,
      );
  const value = (name: string, wildcard: boolean): string | undefined => {
    const raw = Object.getOwnPropertyDescriptor(params, name)?.value;
    if (raw === undefined || raw === null || raw === '') return undefined;
    const segments = wildcard && Array.isArray(raw) ? raw : [raw];
    return segments
      .map((segment: unknown) => {
        if (
          typeof segment !== 'string' &&
          !(typeof segment === 'number' && Number.isFinite(segment))
        )
          throw new NestvexaError(
            'INVALID_CONFIGURATION',
            `Invalid route parameter ${name}`,
          );
        return encodeURIComponent(String(segment));
      })
      .join('/');
  };
  const render = (source: string): string | undefined => {
    let output = '';
    for (let index = 0; index < source.length; index++) {
      const char = source[index] ?? '';
      if (char === '{') {
        // Optional group: rendered only when all of its parameters are present.
        let depth = 1;
        let end = index + 1;
        for (; end < source.length && depth > 0; end++) {
          if (source[end] === '{') depth++;
          else if (source[end] === '}') depth--;
        }
        output += render(source.slice(index + 1, end - 1)) ?? '';
        index = end - 1;
      } else if (char === ':' || char === '*') {
        const name =
          /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(index + 1))?.[0] ?? '';
        const filled = value(name, char === '*');
        if (filled === undefined) return undefined;
        output += filled;
        index += name.length;
      } else if (char === '\\') {
        output += source[index + 1] ?? '';
        index++;
      } else output += char;
    }
    return output;
  };
  const path = render(template);
  if (path === undefined)
    throw new NestvexaError(
      'INVALID_CONFIGURATION',
      'Missing required route parameter',
    );
  const search = new URLSearchParams();
  for (const key of Object.keys(query ?? {}).sort()) {
    const entry = query?.[key];
    if (entry !== undefined) search.append(key, String(entry));
  }
  const suffix = search.toString();
  return suffix ? `${path}?${suffix}` : path;
}

function literal(value: string): string {
  return JSON.stringify(value);
}
/**
 * Generate a standalone, dependency-free TypeScript module:
 * `routes` (method and template per name), `RouteName`, `RouteParams<N>` and
 * a typed `route(name, params?, query?)` builder. Safe for browser bundles.
 */
export function generateRouteModule(
  routes: readonly RouteDefinition[],
): string {
  const sorted = [...routes].sort((a, b) => a.name.localeCompare(b.name));
  const table = sorted
    .map(
      (route) =>
        `  ${literal(route.name)}: { method: ${literal(route.method)}, path: ${literal(route.path)} },`,
    )
    .join('\n');
  const params = sorted
    .map((route) => {
      const fields = route.params
        .map(
          (param) =>
            `${literal(param.name)}${param.optional ? '?' : ''}: ${param.wildcard ? 'string | number | readonly (string | number)[]' : 'string | number'}`,
        )
        .join('; ');
      return `  ${literal(route.name)}: { ${fields} };`;
    })
    .join('\n');
  return `// Generated by @nestvexa/core generateRouteModule. Do not edit.
export const routes = {
${table}
} as const;
export type RouteName = keyof typeof routes;
export interface RouteParamMap {
${params}
}
export type RouteParams<N extends RouteName> = RouteParamMap[N];
type Query = Readonly<Record<string, string | number | boolean | undefined>>;
type Args<N extends RouteName> = {} extends RouteParamMap[N]
  ? [params?: RouteParamMap[N], query?: Query]
  : [params: RouteParamMap[N], query?: Query];

function fill(source: string, params: Readonly<Record<string, unknown>>): string | undefined {
  let output = '';
  for (let index = 0; index < source.length; index++) {
    const char = source[index] ?? '';
    if (char === '{') {
      let depth = 1;
      let end = index + 1;
      for (; end < source.length && depth > 0; end++) {
        if (source[end] === '{') depth++;
        else if (source[end] === '}') depth--;
      }
      output += fill(source.slice(index + 1, end - 1), params) ?? '';
      index = end - 1;
    } else if (char === ':' || char === '*') {
      const name = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(index + 1))?.[0] ?? '';
      const raw = Object.prototype.hasOwnProperty.call(params, name) ? params[name] : undefined;
      if (raw === undefined || raw === null || raw === '') return undefined;
      const segments = char === '*' && Array.isArray(raw) ? raw : [raw];
      output += segments.map((segment) => encodeURIComponent(String(segment))).join('/');
      index += name.length;
    } else if (char === '\\\\') {
      output += source[index + 1] ?? '';
      index++;
    } else output += char;
  }
  return output;
}

/** Typed URL for a named route; parameter values are percent-encoded. */
export function route<N extends RouteName>(name: N, ...args: Args<N>): string {
  const [params = {}, query = {}] = args as [Readonly<Record<string, unknown>>?, Query?];
  const path = fill(routes[name].path, params);
  if (path === undefined) throw new Error(\`Missing parameter for route \${String(name)}\`);
  const search = new URLSearchParams();
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    if (value !== undefined) search.append(key, String(value));
  }
  const suffix = search.toString();
  return suffix ? \`\${path}?\${suffix}\` : path;
}
`;
}
