import {
  Controller,
  Header,
  HttpCode,
  Inject,
  Module,
  Post,
  Req,
  Res,
  Scope,
} from '@nestjs/common';
import type {
  DynamicModule,
  InjectionToken,
  ModuleMetadata,
  OnModuleInit,
  OptionalFactoryDependency,
  Provider,
  Type,
} from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  EXCEPTION_FILTERS_METADATA,
  GUARDS_METADATA,
  INTERCEPTORS_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import {
  ACTION_ROUTE,
  ActionsAdmissionGuard,
  ActionsEnvelopeInterceptor,
  ActionsExceptionFilter,
} from './enhancers.js';
import { actionGroupDefinition } from './metadata.js';
import type { ActionDefinition, ActionGroupDefinition } from './metadata.js';
import { HOST_KEYS, normalizeHostOptions } from './options.js';
import type {
  ActionsErrorEnvelopeMode,
  ActionsHostOptions,
  NormalizedActionsOptions,
} from './options.js';
import { ActionsInfrastructureModule } from './registration.js';
import { ACTIONS_OPTIONS, ActionsRuntime } from './runtime.js';
import { DEFAULT_ACTIONS_PREFIX, JOBS_SEGMENT } from './shared/protocol.js';

/** Static route identity: Nest needs it before any async factory resolves. */
export interface ActionsStaticOptions {
  /** Explicit `@ActionGroup` classes. Nothing else is ever exposed. */
  readonly groups: readonly Type<object>[];
  /** Route prefix, default `/_nestvexa/actions`. Global prefixes still apply. */
  readonly prefix?: string;
  /** Modules exporting the services, guards, pipes and interceptors groups depend on. */
  readonly imports?: ModuleMetadata['imports'];
  /**
   * `actions` (default): a lowest-priority class filter returns the typed
   * failure envelope; method/class filters on groups still win.
   * `host`: no envelope filter; errors flow to host global filters / Nest's
   * default handler and the client maps HTTP status codes.
   */
  readonly errorEnvelope?: ActionsErrorEnvelopeMode;
}
export interface ActionsModuleOptions
  extends ActionsStaticOptions, ActionsHostOptions {}
export interface ActionsModuleAsyncOptions<
  Dependencies extends unknown[] = unknown[],
> extends ActionsStaticOptions {
  readonly inject?: (InjectionToken | OptionalFactoryDependency)[];
  readonly useFactory: (
    ...dependencies: Dependencies
  ) => ActionsHostOptions | Promise<ActionsHostOptions>;
}

const STATIC_KEYS = new Set(['groups', 'prefix', 'imports', 'errorEnvelope']);
const ASYNC_KEYS = new Set([...STATIC_KEYS, 'inject', 'useFactory']);

function structure(options: ActionsStaticOptions): {
  prefix: string;
  groups: readonly ActionGroupDefinition[];
  errorEnvelope: ActionsErrorEnvelopeMode;
} {
  const prefix = options.prefix ?? DEFAULT_ACTIONS_PREFIX;
  if (
    typeof prefix !== 'string' ||
    prefix.length > 256 ||
    !/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(prefix)
  )
    throw new Error(
      `Invalid ActionsModule prefix ${JSON.stringify(prefix)}; use a path such as /_nestvexa/actions`,
    );
  const errorEnvelope = options.errorEnvelope ?? 'actions';
  if (errorEnvelope !== 'actions' && errorEnvelope !== 'host')
    throw new Error('ActionsModule errorEnvelope must be "actions" or "host"');
  if (!Array.isArray(options.groups) || options.groups.length === 0)
    throw new Error(
      'ActionsModule requires an explicit non-empty groups array',
    );
  const groups = Object.freeze(
    options.groups.map((type) => actionGroupDefinition(type)),
  );
  const ids = new Map<string, string>();
  for (const group of groups) {
    const existing = ids.get(group.id);
    if (existing)
      throw new Error(
        `Duplicate action group id "${group.id}" declared by ${existing} and ${group.type.name}; group ids must be unique`,
      );
    ids.set(group.id, group.type.name);
  }
  return { prefix, groups, errorEnvelope };
}

const CONSTRUCTOR_METADATA = new Set([
  'design:paramtypes',
  'self:paramtypes',
  'self:properties_metadata',
  'optional:paramtypes',
  'optional:properties_metadata',
  'scope:options',
  'path',
  'host',
  '__controller__',
  '__injectable__',
  '__module:entry__',
]);

function routeHandler(
  controller: Type<object>,
  group: ActionGroupDefinition,
  action: ActionDefinition,
): void {
  const prototype = group.type.prototype as object;
  const original: unknown = Reflect.get(prototype, action.method);
  if (typeof original !== 'function')
    throw new Error(`${group.type.name}.${action.method} is not a method`);
  const argumentMetadata: unknown = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    group.type,
    action.method,
  );
  const paramTypes: unknown = Reflect.getMetadata(
    'design:paramtypes',
    prototype,
    action.method,
  );
  let requestIndex = Array.isArray(paramTypes) ? paramTypes.length : 0;
  if (typeof argumentMetadata === 'object' && argumentMetadata !== null)
    for (const entry of Object.values(argumentMetadata)) {
      const index: unknown =
        typeof entry === 'object' && entry !== null
          ? Reflect.get(entry, 'index')
          : undefined;
      if (typeof index === 'number' && index >= requestIndex)
        requestIndex = index + 1;
    }
  const name = action.method;
  const handler = function (
    this: { readonly group: object; readonly runtime: ActionsRuntime },
    ...args: unknown[]
  ) {
    const request = args[requestIndex];
    if (typeof request !== 'object' || request === null)
      throw new Error('Missing server action request');
    return this.runtime.execute(
      this.group,
      action,
      args.slice(0, requestIndex),
      request,
    );
  };
  Object.defineProperty(handler, 'name', { value: name });
  for (const key of Reflect.getMetadataKeys(original))
    Reflect.defineMetadata(key, Reflect.getMetadata(key, original), handler);
  Object.defineProperty(controller.prototype, name, {
    value: handler,
    writable: true,
    configurable: true,
  });
  const descriptor = Object.getOwnPropertyDescriptor(
    controller.prototype,
    name,
  );
  if (!descriptor) throw new Error('Failed to define server action handler');
  if (argumentMetadata !== undefined)
    Reflect.defineMetadata(
      ROUTE_ARGS_METADATA,
      argumentMetadata,
      controller,
      name,
    );
  Reflect.defineMetadata(
    'design:paramtypes',
    [...(Array.isArray(paramTypes) ? paramTypes : []), Object],
    controller.prototype,
    name,
  );
  Req()(controller.prototype, name, requestIndex);
  Post(action.path)(controller.prototype, name, descriptor);
  // Job actions answer 202 Accepted with a job ticket (also on replay).
  HttpCode(action.job ? 202 : 200)(controller.prototype, name, descriptor);
  Header('Cache-Control', 'no-store')(controller.prototype, name, descriptor);
  Reflect.defineMetadata(
    ACTION_ROUTE,
    Object.freeze({ group, action }),
    handler,
  );
}

/**
 * A real Nest controller per explicitly registered group. Application guards,
 * pipes, interceptors and filters declared on the group are copied onto it
 * and executed by Nest's router exactly as for hand-written controllers.
 */
function generatedController(
  group: ActionGroupDefinition,
  prefix: string,
  errorEnvelope: ActionsErrorEnvelopeMode,
): Type<object> {
  class GeneratedActionsController {
    constructor(
      @Inject(group.type) readonly group: object,
      @Inject(ActionsRuntime) readonly runtime: ActionsRuntime,
    ) {}
  }
  Object.defineProperty(GeneratedActionsController, 'name', {
    value: `${group.type.name}ActionsController`,
  });
  for (const key of Reflect.getMetadataKeys(group.type)) {
    if (typeof key === 'string' && CONSTRUCTOR_METADATA.has(key)) continue;
    const metadata: unknown = Reflect.getMetadata(key, group.type);
    if (metadata !== undefined)
      Reflect.defineMetadata(key, metadata, GeneratedActionsController);
  }
  Controller(`${prefix}/${group.id}`)(GeneratedActionsController);
  const existing = (key: string): unknown[] => {
    const value: unknown = Reflect.getMetadata(key, GeneratedActionsController);
    return Array.isArray(value) ? value : [];
  };
  Reflect.defineMetadata(
    GUARDS_METADATA,
    [ActionsAdmissionGuard, ...existing(GUARDS_METADATA)],
    GeneratedActionsController,
  );
  Reflect.defineMetadata(
    INTERCEPTORS_METADATA,
    [ActionsEnvelopeInterceptor, ...existing(INTERCEPTORS_METADATA)],
    GeneratedActionsController,
  );
  if (errorEnvelope === 'actions')
    // Nest evaluates class filters in reverse declaration order, so the first
    // entry is the last resort after application method/class filters.
    Reflect.defineMetadata(
      EXCEPTION_FILTERS_METADATA,
      [ActionsExceptionFilter, ...existing(EXCEPTION_FILTERS_METADATA)],
      GeneratedActionsController,
    );
  for (const action of group.actions)
    routeHandler(GeneratedActionsController, group, action);
  return GeneratedActionsController;
}

/**
 * Job status and cancellation routes, registered only when a group declares
 * a `job: true` action. Admission, authorization (group `_jobs`) and owner
 * binding happen in `ActionsRuntime.job`.
 */
function jobsController(
  prefix: string,
  errorEnvelope: ActionsErrorEnvelopeMode,
): Type<object> {
  @Controller(`${prefix}/${JOBS_SEGMENT}`)
  class ActionJobsController {
    constructor(
      @Inject(ActionsRuntime) private readonly runtime: ActionsRuntime,
    ) {}
    @Post('status')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    status(
      @Req() request: object,
      @Res({ passthrough: true }) response: object,
    ) {
      return this.runtime.job(request, response, 'status');
    }
    @Post('cancel')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    cancel(
      @Req() request: object,
      @Res({ passthrough: true }) response: object,
    ) {
      return this.runtime.job(request, response, 'cancel');
    }
  }
  if (errorEnvelope === 'actions')
    Reflect.defineMetadata(
      EXCEPTION_FILTERS_METADATA,
      [ActionsExceptionFilter],
      ActionJobsController,
    );
  return ActionJobsController;
}

/** Keeps the async host policy singleton even if a factory dependency is scoped. */
@Injectable()
class ActionsAsyncConfigurationGuard implements OnModuleInit {
  constructor(@Inject(ModuleRef) private readonly moduleRef: ModuleRef) {}
  onModuleInit(): void {
    if (this.moduleRef.introspect(ACTIONS_OPTIONS).scope !== Scope.DEFAULT)
      throw new Error('Actions async configuration must have singleton scope');
    try {
      this.moduleRef.get(ACTIONS_OPTIONS, { strict: true });
      this.moduleRef.get(ActionsRuntime, { strict: true });
    } catch (cause) {
      throw new Error('Actions async configuration must have singleton scope', {
        cause,
      });
    }
  }
}

function moduleDefinition(
  structureOptions: ReturnType<typeof structure>,
  imports: ModuleMetadata['imports'],
  optionsProvider: Provider,
  extra: Provider[] = [],
): DynamicModule {
  const { groups, prefix, errorEnvelope } = structureOptions;
  return {
    module: ActionsModule,
    imports: [ActionsInfrastructureModule, ...(imports ?? [])],
    controllers: [
      ...groups.map((group) =>
        generatedController(group, prefix, errorEnvelope),
      ),
      ...(groups.some((group) => group.actions.some((action) => action.job))
        ? [jobsController(prefix, errorEnvelope)]
        : []),
    ],
    providers: [
      optionsProvider,
      ActionsRuntime,
      ActionsAdmissionGuard,
      ActionsEnvelopeInterceptor,
      ActionsExceptionFilter,
      ...groups.map((group) => ({ provide: group.type, useClass: group.type })),
      ...extra,
    ],
    exports: [ActionsRuntime],
  };
}

function snapshot(
  options: object,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Reflect.ownKeys(options)) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (typeof key !== 'string' || !descriptor || !('value' in descriptor))
      throw new Error(`${label} must use own data properties`);
    if (!allowed.has(key)) throw new Error(`Unknown ${label} option ${key}`);
  }
}

/**
 * Explicit, authorization-first server actions. Only `@ServerAction` methods
 * of the listed `@ActionGroup` classes become POST routes.
 */
@Module({})
export class ActionsModule {
  static register(options: ActionsModuleOptions): DynamicModule {
    if (typeof options !== 'object' || options === null)
      throw new Error('ActionsModule.register requires options');
    const hostKeys = HOST_KEYS;
    snapshot(
      options,
      new Set([...STATIC_KEYS, ...hostKeys]),
      'ActionsModule.register',
    );
    const shape = structure(options);
    const hostInput: Record<string, unknown> = {};
    for (const key of hostKeys)
      if (Object.hasOwn(options, key))
        hostInput[key] = Reflect.get(options, key);
    const normalized: NormalizedActionsOptions = Object.freeze({
      ...normalizeHostOptions(hostInput),
      ...shape,
    });
    return moduleDefinition(shape, options.imports, {
      provide: ACTIONS_OPTIONS,
      useValue: normalized,
    });
  }

  /** Static groups/routes plus host policy resolved through Nest DI. */
  static registerAsync<Dependencies extends unknown[]>(
    options: ActionsModuleAsyncOptions<Dependencies>,
  ): DynamicModule {
    if (typeof options !== 'object' || options === null)
      throw new Error('ActionsModule.registerAsync requires options');
    snapshot(options, ASYNC_KEYS, 'ActionsModule.registerAsync');
    const shape = structure(options);
    const useFactory = options.useFactory;
    if (typeof useFactory !== 'function')
      throw new Error('ActionsModule.registerAsync requires useFactory');
    const inject = [...(options.inject ?? [])];
    return moduleDefinition(
      shape,
      options.imports,
      {
        provide: ACTIONS_OPTIONS,
        inject,
        useFactory: async (...dependencies: Dependencies) =>
          Object.freeze({
            ...normalizeHostOptions(await useFactory(...dependencies)),
            ...shape,
          }),
      },
      [ActionsAsyncConfigurationGuard],
    );
  }
}
