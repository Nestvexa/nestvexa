import { Module } from '@nestjs/common';
import type {
  DynamicModule,
  InjectionToken,
  ModuleMetadata,
  OptionalFactoryDependency,
} from '@nestjs/common';
import { AiAssistant } from './assistant.js';
import type { AiAssistantOptions } from './types.js';

/** Injection token holding the validated assistant options. */
export const AI_OPTIONS: unique symbol = Symbol('nestvexa:ai-options');

export interface AiModuleAsyncOptions<Dependencies extends unknown[]> {
  readonly imports?: ModuleMetadata['imports'];
  readonly inject?: (InjectionToken | OptionalFactoryDependency)[];
  readonly useFactory: (
    ...dependencies: Dependencies
  ) => AiAssistantOptions | Promise<AiAssistantOptions>;
}

/**
 * Optional Nest integration: provides and exports one `AiAssistant`. The host
 * still owns its stream route, Live component and identity policy.
 */
@Module({})
export class AiModule {
  static forRoot(options: AiAssistantOptions): DynamicModule {
    return {
      module: AiModule,
      providers: [
        { provide: AI_OPTIONS, useValue: options },
        {
          provide: AiAssistant,
          inject: [AI_OPTIONS],
          useFactory: (value: AiAssistantOptions) => new AiAssistant(value),
        },
      ],
      exports: [AiAssistant],
    };
  }
  static forRootAsync<Dependencies extends unknown[]>(
    options: AiModuleAsyncOptions<Dependencies>,
  ): DynamicModule {
    if (typeof options?.useFactory !== 'function')
      throw new Error('AiModule.forRootAsync requires useFactory');
    return {
      module: AiModule,
      imports: [...(options.imports ?? [])],
      providers: [
        {
          provide: AI_OPTIONS,
          inject: [...(options.inject ?? [])],
          useFactory: (...dependencies: unknown[]) =>
            Reflect.apply(options.useFactory, undefined, dependencies),
        },
        {
          provide: AiAssistant,
          inject: [AI_OPTIONS],
          useFactory: (value: AiAssistantOptions) => new AiAssistant(value),
        },
      ],
      exports: [AiAssistant],
    };
  }
}
