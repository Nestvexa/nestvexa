import { Inject, Injectable, RequestMethod } from '@nestjs/common';
import {
  METHOD_METADATA,
  PATH_METADATA,
  VERSION_METADATA,
} from '@nestjs/common/constants';
import { DiscoveryService } from '@nestjs/core';
import { INTERNAL_SYNC_PATH } from './metadata.js';
import { LIVE_OPTIONS } from './runtime.js';
import type { RuntimeOptions } from './runtime.js';

/** Marks generated Live controllers so host-route scanning skips them. */
export const LIVE_GENERATED_CONTROLLER = Symbol('nv:generated-controller');

interface Route {
  readonly method: RequestMethod;
  readonly path: string;
  readonly owner: string;
}

function paths(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === 'string');
  return [''];
}
function join(...parts: string[]): string {
  const joined = parts
    .join('/')
    .split('/')
    .filter((segment) => segment.length > 0)
    .join('/');
  return `/${joined}`;
}
/** Host `:param` segments match any segment; a segment containing `*` matches the rest. */
function overlaps(host: string, live: string): boolean {
  const left = host.split('/').filter(Boolean);
  const right = live.split('/').filter(Boolean);
  for (let index = 0; index < right.length; index++) {
    const segment = left[index];
    if (segment === undefined) return false;
    if (segment.includes('*') || segment.includes('(')) return true;
    const expected = right[index] ?? '';
    if (
      segment !== expected &&
      !segment.startsWith(':') &&
      !expected.startsWith(':')
    )
      return false;
  }
  return left.length === right.length;
}

function hostRoutes(discovery: DiscoveryService): Route[] {
  const routes: Route[] = [];
  for (const wrapper of discovery.getControllers()) {
    const type = wrapper.metatype;
    if (typeof type !== 'function') continue;
    if (Reflect.getMetadata(LIVE_GENERATED_CONTROLLER, type) === true) continue;
    const classVersion: unknown = Reflect.getMetadata(VERSION_METADATA, type);
    const prefixes = paths(Reflect.getMetadata(PATH_METADATA, type));
    const seen = new Set<string>();
    let prototype: object | null = type.prototype as object | null;
    while (prototype && prototype !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(prototype)) {
        if (name === 'constructor' || seen.has(name)) continue;
        seen.add(name);
        const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
        const handler: unknown = descriptor?.value;
        if (typeof handler !== 'function') continue;
        const method: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
        if (typeof method !== 'number') continue;
        // URI/header/media-type versioned routes live in another namespace.
        if (
          classVersion !== undefined ||
          Reflect.getMetadata(VERSION_METADATA, handler) !== undefined
        )
          continue;
        for (const prefix of prefixes)
          for (const path of paths(Reflect.getMetadata(PATH_METADATA, handler)))
            routes.push({
              method: method as RequestMethod,
              path: join(prefix, path),
              owner: `${type.name}.${name}`,
            });
      }
      prototype = Object.getPrototypeOf(prototype) as object | null;
    }
  }
  return routes;
}

/**
 * Startup check: no host controller route may shadow or be shadowed by a
 * generated Live route. It runs while Nest instantiates providers (module
 * compilation), after scanning and before any HTTP route is registered, so
 * neither platform router sees an ambiguous route. Versioned host routes are
 * skipped. Cross-registration Live collisions are checked by the registry.
 */
@Injectable()
export class LiveRouteConflictCheck {
  constructor(
    @Inject(DiscoveryService) discovery: DiscoveryService,
    @Inject(LIVE_OPTIONS) options: RuntimeOptions,
  ) {
    const endpoint = options.endpoint ?? '/_nestvexa/live';
    const live: Route[] = options.definitions.flatMap((component) => [
      ...[...component.actions.keys(), INTERNAL_SYNC_PATH].map((action) => ({
        method: RequestMethod.POST,
        path: join(endpoint, component.name, action),
        owner: component.name,
      })),
      {
        method: RequestMethod.GET,
        path: join(endpoint, component.name, '_download', ':token'),
        owner: component.name,
      },
    ]);
    for (const host of hostRoutes(discovery))
      for (const route of live)
        if (
          (host.method === route.method || host.method === RequestMethod.ALL) &&
          overlaps(host.path, route.path)
        )
          throw new Error(
            `Host route ${RequestMethod[host.method]} ${host.path} (${host.owner}) collides with the Live route ${RequestMethod[route.method]} ${route.path} of component "${route.owner}". Move the host route or register LiveModule with a different endpoint.`,
          );
  }
}
