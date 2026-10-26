import {
  Controller,
  Header,
  Inject,
  Injectable,
  Module,
  Post,
  Req,
  Scope,
} from '@nestjs/common';
import type {
  CanActivate,
  DynamicModule,
  ExecutionContext,
  ModuleMetadata,
  Type,
} from '@nestjs/common';
import { GUARDS_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import {
  definition,
  INTERNAL_SYNC_ACTION,
  INTERNAL_SYNC_PATH,
} from './metadata.js';
import type { ComponentDefinition } from './metadata.js';
import { LIVE_OPTIONS, LiveRuntime } from './runtime.js';
import { LiveInfrastructureModule } from './registration.js';
import type { LiveHostOptions } from './runtime.js';

const ROUTE = Symbol('nv:route');
@Injectable()
class LiveAdmissionGuard implements CanActivate {
  constructor(@Inject(LiveRuntime) private readonly runtime: LiveRuntime) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const route:
      { component: ComponentDefinition; action: string } | undefined =
      Reflect.getMetadata(ROUTE, context.getHandler());
    if (!route) throw new Error('Missing live route contract');
    await this.runtime.admit(
      context.switchToHttp().getRequest<object>(),
      route.component,
      route.action,
    );
    return true;
  }
}
export interface LiveModuleOptions extends LiveHostOptions {
  readonly components: readonly Type<object>[];
  readonly imports?: ModuleMetadata['imports'];
}
function generatedController(
  component: ComponentDefinition,
  endpoint: string,
): Type<object> {
  class LiveController {
    constructor(@Inject(LiveRuntime) readonly runtime: LiveRuntime) {}
  }
  const constructorMetadata = new Set([
    'design:paramtypes',
    'self:paramtypes',
    'self:properties_metadata',
    'scope:options',
    'path',
    'host',
    '__controller__',
    '__injectable__',
  ]);
  for (const key of Reflect.getMetadataKeys(component.type)) {
    if (constructorMetadata.has(key)) continue;
    const metadata: unknown = Reflect.getMetadata(key, component.type);
    if (metadata !== undefined)
      Reflect.defineMetadata(key, metadata, LiveController);
  }
  Controller({ path: `${endpoint}/${component.name}`, scope: Scope.REQUEST })(
    LiveController,
  );
  const existingGuards: unknown[] =
    Reflect.getMetadata(GUARDS_METADATA, LiveController) ?? [];
  Reflect.defineMetadata(
    GUARDS_METADATA,
    [LiveAdmissionGuard, ...existingGuards],
    LiveController,
  );
  for (const [action, entry] of component.actions) {
    const original: unknown = Reflect.get(
      component.type.prototype,
      entry.method,
    );
    if (typeof original !== 'function')
      throw new Error('Invalid action method');
    const handler = function (this: LiveController, ...args: unknown[]) {
      const request = args[entry.input ? 1 : 0];
      if (typeof request !== 'object' || request === null)
        throw new Error('Missing request');
      return this.runtime.execute(request, entry.input ? args[0] : undefined);
    };
    Object.defineProperty(handler, 'name', { value: entry.method });
    for (const key of Reflect.getMetadataKeys(original))
      Reflect.defineMetadata(key, Reflect.getMetadata(key, original), handler);
    Object.defineProperty(LiveController.prototype, entry.method, {
      value: handler,
      writable: true,
      configurable: true,
    });
    const descriptor = Object.getOwnPropertyDescriptor(
      LiveController.prototype,
      entry.method,
    );
    if (!descriptor) throw new Error('Failed to define live handler');
    const argumentMetadata: unknown = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      component.type,
      entry.method,
    );
    if (argumentMetadata !== undefined)
      Reflect.defineMetadata(
        ROUTE_ARGS_METADATA,
        argumentMetadata,
        LiveController,
        entry.method,
      );
    const paramTypes: unknown = Reflect.getMetadata(
      'design:paramtypes',
      component.type.prototype,
      entry.method,
    );
    if (paramTypes !== undefined)
      Reflect.defineMetadata(
        'design:paramtypes',
        paramTypes,
        LiveController.prototype,
        entry.method,
      );
    Req()(LiveController.prototype, entry.method, entry.input ? 1 : 0);
    Post(action)(LiveController.prototype, entry.method, descriptor);
    Header('Cache-Control', 'no-store')(
      LiveController.prototype,
      entry.method,
      descriptor,
    );
    Reflect.defineMetadata(ROUTE, { component, action }, handler);
  }
  const syncMethod = '__nestvexaSync';
  const sync = function (this: LiveController, request: object) {
    return this.runtime.execute(request, undefined);
  };
  Object.defineProperty(LiveController.prototype, syncMethod, { value: sync });
  const syncDescriptor = Object.getOwnPropertyDescriptor(
    LiveController.prototype,
    syncMethod,
  );
  if (!syncDescriptor)
    throw new Error('Failed to define live synchronization handler');
  Req()(LiveController.prototype, syncMethod, 0);
  Post(INTERNAL_SYNC_PATH)(
    LiveController.prototype,
    syncMethod,
    syncDescriptor,
  );
  Header('Cache-Control', 'no-store')(
    LiveController.prototype,
    syncMethod,
    syncDescriptor,
  );
  Reflect.defineMetadata(
    ROUTE,
    { component, action: INTERNAL_SYNC_ACTION },
    sync,
  );
  return LiveController;
}

/** Creates only explicitly registered routes; guards/pipes/interceptors/filters execute through Nest. */
@Module({})
export class LiveModule {
  static register(options: LiveModuleOptions): DynamicModule {
    const origin = new URL(options.origin);
    if (
      !['http:', 'https:'].includes(origin.protocol) ||
      origin.origin !== options.origin
    )
      throw new Error('Live origin must be an exact HTTP(S) origin');
    const endpoint = options.endpoint ?? '/_nestvexa/live';
    const basePath = options.basePath ?? '';
    const pathPattern = /^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/;
    if (!pathPattern.test(endpoint) || endpoint.length > 256)
      throw new Error('Invalid live endpoint prefix');
    if (
      basePath !== '' &&
      (!pathPattern.test(basePath) || basePath.length > 256)
    )
      throw new Error('Invalid live public base path');
    if (
      typeof options.authorize !== 'function' ||
      typeof options.resolveIdentity !== 'function'
    )
      throw new Error('Live identity and authorization policies are required');
    if (
      options.maxRequestsPerMinute !== undefined &&
      (!Number.isSafeInteger(options.maxRequestsPerMinute) ||
        options.maxRequestsPerMinute < 1)
    )
      throw new Error('Invalid live rate limit');
    const definitions = options.components.map(definition);
    if (
      new Set(definitions.map((entry) => entry.name)).size !==
      definitions.length
    )
      throw new Error('Duplicate live component name');
    return {
      module: LiveModule,
      imports: [LiveInfrastructureModule, ...(options.imports ?? [])],
      controllers: definitions.map((component) =>
        generatedController(component, endpoint),
      ),
      providers: [
        {
          provide: LIVE_OPTIONS,
          useValue: Object.freeze({
            ...options,
            endpoint,
            basePath,
            definitions,
          }),
        },
        LiveRuntime,
        LiveAdmissionGuard,
        ...definitions.map((component) => ({
          provide: component.type,
          useClass: component.type,
          scope: Scope.REQUEST,
        })),
      ],
      exports: [LiveRuntime],
    };
  }
}
