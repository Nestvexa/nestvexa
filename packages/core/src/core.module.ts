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
import { NestvexaError } from './errors.js';
import { FeatureCapabilityRegistry } from './registry.js';

/** Class-based async configuration, the Nest `useClass`/`useExisting` convention. */
export interface NestvexaOptionsFactory {
  createNestvexaOptions(): NestvexaOptions | Promise<NestvexaOptions>;
}

/** Module visibility; providers stay local to the importing module unless `global` is true. */
export interface CoreModuleRegistration {
  /** Register the config service and capability registry as a global Nest module. */
  readonly global?: boolean;
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
const exported = [NestvexaConfigService, FeatureCapabilityRegistry];

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
        NestvexaConfigService,
        FeatureCapabilityRegistry,
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
      providers: [
        ...providers,
        NestvexaConfigService,
        FeatureCapabilityRegistry,
      ],
      exports: exported,
    };
  }
}
