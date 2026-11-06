import {
  Controller,
  Get,
  Header,
  HttpException,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
  Req,
  Scope,
} from '@nestjs/common';
import type {
  CanActivate,
  DynamicModule,
  ExecutionContext,
  InjectionToken,
  ModuleMetadata,
  OnModuleInit,
  OptionalFactoryDependency,
  Provider,
  Type,
} from '@nestjs/common';
import { DiscoveryModule, HttpAdapterHost, ModuleRef } from '@nestjs/core';
import { LiveEvents } from './domain-events.js';
import { GUARDS_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import {
  definition,
  INTERNAL_SYNC_ACTION,
  INTERNAL_SYNC_PATH,
} from './metadata.js';
import type { ComponentDefinition } from './metadata.js';
import { LIVE_OPTIONS, LiveRuntime } from './runtime.js';
import { LiveInfrastructureModule } from './registration.js';
import {
  LIVE_GENERATED_CONTROLLER,
  LiveRouteConflictCheck,
} from './route-conflicts.js';
import type { LiveHostOptions } from './runtime.js';
import { isLiveStateStore } from './store.js';
import { LIVE_CAPABILITIES, LIVE_PROTOCOL } from './protocol.js';

/**
 * Successful action and $sync responses advertise the protocol major and the
 * capability tokens this server honours, so clients can detect a version skew
 * (for example a long-lived tab after a deploy) instead of misreading a reply.
 */
const protocolHeaders = [
  ['Cache-Control', 'no-store'],
  ['x-nestvexa-protocol', LIVE_PROTOCOL],
  ['x-nestvexa-capabilities', LIVE_CAPABILITIES.join(',')],
] as const;

const ROUTE = Symbol('nv:route');
const DOWNLOAD_ACTION = '$download';
@Injectable()
class LiveAdmissionGuard implements CanActivate {
  constructor(
    @Inject(LiveRuntime) private readonly runtime: LiveRuntime,
    @Inject(HttpAdapterHost) private readonly adapter: HttpAdapterHost,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const route:
      { component: ComponentDefinition; action: string } | undefined =
      Reflect.getMetadata(ROUTE, context.getHandler());
    if (!route) throw new Error('Missing live route contract');
    // Component class guards still run; the token check happens in the handler.
    if (route.action === DOWNLOAD_ACTION) return true;
    try {
      await this.runtime.admit(
        context.switchToHttp().getRequest<object>(),
        route.component,
        route.action,
      );
    } catch (error) {
      // The browser reads this header (bodies are never parsed on errors).
      if (
        error instanceof HttpException &&
        Reflect.get(Object(error.getResponse()), 'code') ===
          'ASSET_VERSION_MISMATCH'
      )
        this.adapter.httpAdapter.setHeader(
          context.switchToHttp().getResponse<object>(),
          'x-nestvexa-reload',
          'asset-version',
        );
      throw error;
    }
    return true;
  }
}
export interface LiveModuleOptions extends LiveHostOptions {
  readonly components: readonly Type<object>[];
  readonly imports?: ModuleMetadata['imports'];
}
/** Host policy and services resolved after the static Nest route graph is built. */
export type LiveRuntimeFactoryOptions = Omit<
  LiveHostOptions,
  'endpoint' | 'basePath'
>;
export interface LiveModuleAsyncOptions<
  Dependencies extends unknown[] = unknown[],
> {
  readonly components: readonly Type<object>[];
  readonly endpoint?: string;
  readonly basePath?: string;
  readonly imports?: ModuleMetadata['imports'];
  readonly inject?: (InjectionToken | OptionalFactoryDependency)[];
  readonly useFactory: (
    ...dependencies: Dependencies
  ) => LiveRuntimeFactoryOptions | Promise<LiveRuntimeFactoryOptions>;
}

function structure(options: {
  readonly components: readonly Type<object>[];
  readonly endpoint?: string;
  readonly basePath?: string;
}) {
  const endpoint =
    options.endpoint === undefined ? '/_nestvexa/live' : options.endpoint;
  const basePath = options.basePath === undefined ? '' : options.basePath;
  const pathPattern = /^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/;
  if (
    typeof endpoint !== 'string' ||
    /[\r\n]/.test(endpoint) ||
    !pathPattern.test(endpoint) ||
    endpoint.length > 256
  )
    throw new Error('Invalid live endpoint prefix');
  if (
    typeof basePath !== 'string' ||
    /[\r\n]/.test(basePath) ||
    (basePath !== '' && (!pathPattern.test(basePath) || basePath.length > 256))
  )
    throw new Error('Invalid live public base path');
  if (!Array.isArray(options.components))
    throw new Error('Live components must be an explicit array');
  const components = Object.freeze([...options.components]);
  const definitions = Object.freeze(components.map(definition));
  if (
    new Set(definitions.map((entry) => entry.name)).size !== definitions.length
  )
    throw new Error('Duplicate live component name');
  for (const entry of definitions)
    for (const [alias, type] of entry.children)
      if (!components.includes(type))
        throw new Error(
          `Child ${entry.name}.${alias} must be registered in the same LiveModule components array`,
        );
  return { endpoint, basePath, definitions };
}

function validateHost(options: LiveRuntimeFactoryOptions): void {
  const origin = new URL(options.origin);
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.origin !== options.origin
  )
    throw new Error('Live origin must be an exact HTTP(S) origin');
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
  if (
    options.realtime !== undefined &&
    (typeof options.realtime !== 'object' ||
      options.realtime === null ||
      typeof options.realtime.sign !== 'function')
  )
    throw new Error(
      'Live realtime option requires a sign(identity, channels) method',
    );
  if (
    options.events !== undefined &&
    (typeof options.events !== 'object' ||
      options.events === null ||
      typeof options.events.publish !== 'function')
  )
    throw new Error(
      'Live events option requires a publish(channel, data) method',
    );
  if (
    options.assetVersion !== undefined &&
    (typeof options.assetVersion !== 'string' ||
      !/^[A-Za-z0-9._:+-]{1,128}$/.test(options.assetVersion))
  )
    throw new Error(
      'Live assetVersion must be 1–128 letters, digits, ".", "_", ":", "+" or "-"',
    );
}

function factoryOptions(
  options: LiveRuntimeFactoryOptions,
): LiveRuntimeFactoryOptions {
  if (typeof options !== 'object' || options === null || Array.isArray(options))
    throw new Error('Invalid Live runtime factory options');
  const prototype: unknown = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error('Invalid Live runtime factory options');
  const allowed = new Set([
    'origin',
    'resolveIdentity',
    'authorize',
    'renderer',
    'store',
    'maxRequestsPerMinute',
    'realtime',
    'instrumentation',
    'events',
    'assetVersion',
    'inspector',
  ]);
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || !allowed.has(key))
      throw new Error(
        'Live runtime factory cannot override static registration or unknown options',
      );
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor || !('value' in descriptor))
      throw new Error('Live runtime factory options must use data properties');
  }
  // Copy only validated own data fields; inherited Object.prototype values
  // must not supply policies or execute getters for omitted options.
  const snapshot = { ...options };
  Object.setPrototypeOf(snapshot, null);
  validateHost(snapshot);
  const renderer = snapshot.renderer;
  if (
    !renderer ||
    typeof renderer !== 'object' ||
    typeof renderer.name !== 'string' ||
    !renderer.name ||
    !Array.isArray(renderer.extensions) ||
    !renderer.extensions.every(
      (extension: unknown) => typeof extension === 'string',
    ) ||
    !renderer.capabilities ||
    typeof renderer.capabilities !== 'object' ||
    typeof renderer.initialize !== 'function' ||
    typeof renderer.render !== 'function' ||
    typeof renderer.dispose !== 'function'
  )
    throw new Error('Live runtime factory requires a view engine adapter');
  if (snapshot.store !== undefined && !isLiveStateStore(snapshot.store))
    throw new Error(
      'Live runtime factory store must implement LiveStateStore (create, peek, transaction, revoke, delete, close)',
    );
  return Object.freeze({
    origin: snapshot.origin,
    resolveIdentity: snapshot.resolveIdentity,
    authorize: snapshot.authorize,
    renderer,
    ...(snapshot.store === undefined ? {} : { store: snapshot.store }),
    ...(snapshot.maxRequestsPerMinute === undefined
      ? {}
      : { maxRequestsPerMinute: snapshot.maxRequestsPerMinute }),
    ...(snapshot.realtime === undefined ? {} : { realtime: snapshot.realtime }),
    ...(snapshot.instrumentation === undefined
      ? {}
      : { instrumentation: snapshot.instrumentation }),
    ...(snapshot.events === undefined ? {} : { events: snapshot.events }),
    ...(snapshot.assetVersion === undefined
      ? {}
      : { assetVersion: snapshot.assetVersion }),
    ...(snapshot.inspector === undefined
      ? {}
      : { inspector: snapshot.inspector }),
  });
}

/** Stays singleton even when the configuration factory accidentally becomes request-scoped. */
@Injectable()
class LiveAsyncConfigurationGuard implements OnModuleInit {
  constructor(@Inject(ModuleRef) private readonly moduleRef: ModuleRef) {}
  onModuleInit(): void {
    if (this.moduleRef.introspect(LIVE_OPTIONS).scope !== Scope.DEFAULT)
      throw new Error('Live async configuration must have singleton scope');
    try {
      // Strict lookup also checks this module's provider if another registration
      // happens to be the public introspection API's selected token instance.
      this.moduleRef.get(LIVE_OPTIONS, { strict: true });
      this.moduleRef.get(LiveRuntime, { strict: true });
    } catch (cause) {
      throw new Error('Live async configuration must have singleton scope', {
        cause,
      });
    }
  }
}

function providers(
  definitions: readonly ComponentDefinition[],
  options: Provider,
): Provider[] {
  return [
    options,
    LiveRuntime,
    LiveEvents,
    LiveAdmissionGuard,
    LiveRouteConflictCheck,
    ...definitions.map((component) => ({
      provide: component.type,
      useClass: component.type,
      scope: Scope.REQUEST,
    })),
  ];
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
  Reflect.defineMetadata(LIVE_GENERATED_CONTROLLER, true, LiveController);
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
    for (const [name, value] of protocolHeaders)
      Header(name, value)(LiveController.prototype, entry.method, descriptor);
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
  for (const [name, value] of protocolHeaders)
    Header(name, value)(LiveController.prototype, syncMethod, syncDescriptor);
  Reflect.defineMetadata(
    ROUTE,
    { component, action: INTERNAL_SYNC_ACTION },
    sync,
  );
  // Single-use attachments: the token is the capability, bound to the identity
  // that ran the action. No admission guard: GET navigations carry no Origin/CSRF.
  const downloadMethod = '__nestvexaDownload';
  const download = function (
    this: LiveController,
    request: object,
    token: unknown,
  ) {
    return this.runtime.download(request, component, token);
  };
  Object.defineProperty(LiveController.prototype, downloadMethod, {
    value: download,
  });
  const downloadDescriptor = Object.getOwnPropertyDescriptor(
    LiveController.prototype,
    downloadMethod,
  );
  if (!downloadDescriptor)
    throw new Error('Failed to define live download handler');
  Req()(LiveController.prototype, downloadMethod, 0);
  Param('token')(LiveController.prototype, downloadMethod, 1);
  Get('_download/:token')(
    LiveController.prototype,
    downloadMethod,
    downloadDescriptor,
  );
  for (const [name, value] of [
    ['Cache-Control', 'no-store'],
    ['X-Content-Type-Options', 'nosniff'],
    ['Content-Security-Policy', "sandbox; default-src 'none'"],
  ] as const)
    Header(name, value)(
      LiveController.prototype,
      downloadMethod,
      downloadDescriptor,
    );
  Reflect.defineMetadata(
    ROUTE,
    { component, action: DOWNLOAD_ACTION },
    download,
  );
  return LiveController;
}

/** Creates only explicitly registered routes; guards/pipes/interceptors/filters execute through Nest. */
@Module({})
export class LiveModule {
  static register(options: LiveModuleOptions): DynamicModule {
    validateHost(options);
    const { endpoint, basePath, definitions } = structure(options);
    return {
      module: LiveModule,
      imports: [
        LiveInfrastructureModule,
        DiscoveryModule,
        ...(options.imports ?? []),
      ],
      controllers: definitions.map((component) =>
        generatedController(component, endpoint),
      ),
      providers: providers(definitions, {
        provide: LIVE_OPTIONS,
        useValue: Object.freeze({
          ...options,
          endpoint,
          basePath,
          definitions,
        }),
      }),
      exports: [LiveRuntime, LiveEvents],
    };
  }

  /** Static route identities plus asynchronously injected singleton host policies. */
  static registerAsync<Dependencies extends unknown[]>(
    options: LiveModuleAsyncOptions<Dependencies>,
  ): DynamicModule {
    const { endpoint, basePath, definitions } = structure(options);
    const imports = [...(options.imports ?? [])];
    const inject = (options.inject ?? []).map((entry) =>
      typeof entry === 'object' && entry !== null
        ? Object.freeze({ token: entry.token, optional: entry.optional })
        : entry,
    );
    const useFactory = options.useFactory;
    if (typeof useFactory !== 'function')
      throw new Error('Live async configuration requires useFactory');
    return {
      module: LiveModule,
      imports: [LiveInfrastructureModule, DiscoveryModule, ...imports],
      controllers: definitions.map((component) =>
        generatedController(component, endpoint),
      ),
      providers: [
        ...providers(definitions, {
          provide: LIVE_OPTIONS,
          inject,
          useFactory: async (...dependencies: Dependencies) =>
            Object.freeze({
              ...factoryOptions(await useFactory(...dependencies)),
              endpoint,
              basePath,
              definitions,
            }),
        }),
        LiveAsyncConfigurationGuard,
      ],
      exports: [LiveRuntime, LiveEvents],
    };
  }
}
