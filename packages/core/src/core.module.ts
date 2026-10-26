import {
  Module,
  type DynamicModule,
  type InjectionToken,
  type ModuleMetadata,
  type OptionalFactoryDependency,
} from '@nestjs/common';
import {
  NestvexaConfigService,
  NESTVEXA_OPTIONS,
  normalizeOptions,
  type NestvexaOptions,
} from './config.js';
import { FeatureCapabilityRegistry } from './registry.js';

export interface NestvexaAsyncOptions<
  Dependencies extends unknown[] = unknown[],
> {
  readonly imports?: ModuleMetadata['imports'];
  readonly inject?: (InjectionToken | OptionalFactoryDependency)[];
  readonly useFactory: (
    ...dependencies: Dependencies
  ) => NestvexaOptions | Promise<NestvexaOptions>;
}

/** Local dynamic module: no global routing, renderer imports or import-time initialization. */
@Module({})
export class CoreModule {
  static forRoot(options: NestvexaOptions = {}): DynamicModule {
    return {
      module: CoreModule,
      providers: [
        { provide: NESTVEXA_OPTIONS, useValue: normalizeOptions(options) },
        NestvexaConfigService,
        FeatureCapabilityRegistry,
      ],
      exports: [NestvexaConfigService, FeatureCapabilityRegistry],
    };
  }

  static forRootAsync<Dependencies extends unknown[]>(
    options: NestvexaAsyncOptions<Dependencies>,
  ): DynamicModule {
    return {
      module: CoreModule,
      imports: options.imports ?? [],
      providers: [
        {
          provide: NESTVEXA_OPTIONS,
          inject: options.inject ?? [],
          useFactory: async (...dependencies: Dependencies) =>
            normalizeOptions(await options.useFactory(...dependencies)),
        },
        NestvexaConfigService,
        FeatureCapabilityRegistry,
      ],
      exports: [NestvexaConfigService, FeatureCapabilityRegistry],
    };
  }
}
