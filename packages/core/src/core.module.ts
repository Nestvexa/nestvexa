import {
  Module,
  type DynamicModule,
  type InjectionToken,
  type ModuleMetadata,
  type OptionalFactoryDependency,
  type Provider,
  type Type,
} from '@nestjs/common';
import {
  NestvexaConfigService,
  NESTVEXA_OPTIONS,
  normalizeOptions,
  type NestvexaOptions,
} from './config.js';
import type { LoggerService } from '@nestjs/common';
import {
  NESTVEXA_REQUEST_CONTEXT_OPTIONS,
  RequestContextFactory,
} from './context.js';
import type { RequestContextOptions } from './context.js';
import {
  DiagnosticsRegistry,
  NESTVEXA_DIAGNOSTICS_OPTIONS,
} from './diagnostics.js';
import type { DiagnosticsOptions } from './diagnostics.js';
import { NestvexaError } from './errors.js';
import {
  NESTVEXA_ERROR_LOGGER,
  NESTVEXA_ERROR_REDACTION,
  NestvexaExceptionFilter,
} from './exceptions.js';
import { NESTVEXA_EXTENSIONS, NestvexaExtensionHost } from './extensions.js';
import type { NestvexaExtension } from './extensions.js';
import type { RedactionOptions } from './redaction.js';
import { FeatureCapabilityRegistry } from './registry.js';
import { SecurityPolicyRegistry } from './security.js';

/** Class-based async configuration, the Nest `useClass`/`useExisting` convention. */
export interface NestvexaOptionsFactory {
  createNestvexaOptions(): NestvexaOptions | Promise<NestvexaOptions>;
}

/** Module visibility and kernel services; providers stay local unless `global` is true. */
export interface CoreModuleRegistration {
  /** Register the kernel services as a global Nest module. */
  readonly global?: boolean;
  /** Tenant/session/principal resolvers and correlation header policy. */
  readonly requestContext?: RequestContextOptions;
  /** Buffer size, strict names and redaction for the diagnostics registry. */
  readonly diagnostics?: DiagnosticsOptions;
  /** Extensions installed in order at module init (see `NestvexaExtension`). */
  readonly extensions?: readonly NestvexaExtension[];
  /** Logger for server errors caught by `NestvexaExceptionFilter` (redacted). */
  readonly errorLogger?: LoggerService;
  /** Extra sensitive key fragments for error logs. */
  readonly redaction?: RedactionOptions;
}

interface AsyncBase extends CoreModuleRegistration {
  readonly imports?: ModuleMetadata['imports'];
}
export type NestvexaAsyncOptions<Dependencies extends unknown[] = unknown[]> =
  | (AsyncBase & {
      readonly inject?: (InjectionToken | OptionalFactoryDependency)[];
      readonly useFactory: (
        ...dependencies: Dependencies
      ) => NestvexaOptions | Promise<NestvexaOptions>;
      readonly useClass?: never;
      readonly useExisting?: never;
    })
  | (AsyncBase & {
      /** Instantiated inside this module; its constructor dependencies come from `imports`. */
      readonly useClass: Type<NestvexaOptionsFactory>;
      readonly useFactory?: never;
      readonly useExisting?: never;
    })
  | (AsyncBase & {
      /** An existing provider token exported by one of `imports`. */
      readonly useExisting: InjectionToken;
      readonly useFactory?: never;
      readonly useClass?: never;
    });

const FACTORY = Symbol('nv:core-options-factory');
const exported = [
  NestvexaConfigService,
  FeatureCapabilityRegistry,
  RequestContextFactory,
  SecurityPolicyRegistry,
  DiagnosticsRegistry,
  NestvexaExceptionFilter,
  NestvexaExtensionHost,
];
/** Kernel services shared by `forRoot` and `forRootAsync`. */
function kernel(registration: CoreModuleRegistration | undefined): Provider[] {
  const value = (key: keyof CoreModuleRegistration): unknown =>
    registration?.[key] ?? null;
  return [
    NestvexaConfigService,
    FeatureCapabilityRegistry,
    {
      provide: NESTVEXA_REQUEST_CONTEXT_OPTIONS,
      useValue: value('requestContext'),
    },
    RequestContextFactory,
    SecurityPolicyRegistry,
    { provide: NESTVEXA_DIAGNOSTICS_OPTIONS, useValue: value('diagnostics') },
    DiagnosticsRegistry,
    { provide: NESTVEXA_ERROR_LOGGER, useValue: value('errorLogger') },
    { provide: NESTVEXA_ERROR_REDACTION, useValue: value('redaction') },
    NestvexaExceptionFilter,
    { provide: NESTVEXA_EXTENSIONS, useValue: value('extensions') },
    NestvexaExtensionHost,
  ];
}

function global(registration: CoreModuleRegistration | undefined): boolean {
  const value = registration?.global;
  if (value !== undefined && typeof value !== 'boolean')
    throw new NestvexaError(
      'INVALID_CONFIGURATION',
      'Invalid Nestvexa module registration at global (expected a boolean)',
    );
  return value === true;
}

async function fromFactory(factory: unknown): Promise<NestvexaOptions> {
  if (
    typeof factory !== 'object' ||
    factory === null ||
    typeof Reflect.get(factory, 'createNestvexaOptions') !== 'function'
  )
    throw new NestvexaError(
      'INVALID_CONFIGURATION',
      'Nestvexa options factory must implement createNestvexaOptions()',
    );
  return (factory as NestvexaOptionsFactory).createNestvexaOptions();
}

/** Local dynamic module: no global routing, renderer imports or import-time initialization. */
@Module({})
export class CoreModule {
  static forRoot(
    options: NestvexaOptions = {},
    registration?: CoreModuleRegistration,
  ): DynamicModule {
    return {
      module: CoreModule,
      global: global(registration),
      providers: [
        { provide: NESTVEXA_OPTIONS, useValue: normalizeOptions(options) },
        ...kernel(registration),
      ],
      exports: exported,
    };
  }

  static forRootAsync<Dependencies extends unknown[]>(
    options: NestvexaAsyncOptions<Dependencies>,
  ): DynamicModule {
    if (typeof options !== 'object' || options === null)
      throw new NestvexaError(
        'INVALID_CONFIGURATION',
        'Nestvexa async configuration must be an object',
      );
    const strategies = [
      options.useFactory,
      options.useClass,
      options.useExisting,
    ].filter((entry) => entry !== undefined);
    if (strategies.length !== 1)
      throw new NestvexaError(
        'INVALID_CONFIGURATION',
        'Nestvexa async configuration needs exactly one of useFactory, useClass or useExisting',
      );
    const providers: Provider[] = [];
    if (options.useFactory !== undefined) {
      const factory = options.useFactory;
      if (typeof factory !== 'function')
        throw new NestvexaError(
          'INVALID_CONFIGURATION',
          'Nestvexa async useFactory must be a function',
        );
      providers.push({
        provide: NESTVEXA_OPTIONS,
        inject: options.inject ?? [],
        useFactory: async (...dependencies: Dependencies) =>
          normalizeOptions(await factory(...dependencies)),
      });
    } else {
      if (options.useClass !== undefined)
        providers.push({ provide: FACTORY, useClass: options.useClass });
      else if (options.useExisting !== undefined)
        providers.push({ provide: FACTORY, useExisting: options.useExisting });
      providers.push({
        provide: NESTVEXA_OPTIONS,
        inject: [FACTORY],
        useFactory: async (factory: unknown) =>
          normalizeOptions(await fromFactory(factory)),
      });
    }
    return {
      module: CoreModule,
      global: global(options),
      imports: options.imports ?? [],
      providers: [...providers, ...kernel(options)],
      exports: exported,
    };
  }
}
