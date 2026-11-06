import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { CoreModule, NestvexaConfigService } from '@nestvexa/core';
import type { NestvexaAsyncOptions, NestvexaOptions } from '@nestvexa/core';
import { HbsEngine } from '@nestvexa/engine-hbs';
import { LiveModule } from '@nestvexa/live';
import type {
  LiveModuleAsyncOptions,
  LiveRuntimeFactoryOptions,
} from '@nestvexa/live';
import { NestvexaRendererModule } from './mvc.module.js';
import { NestvexaBrowserModule } from './browser.module.js';
import type { NestvexaBrowserOptions } from './browser.module.js';

export * from '@nestvexa/core';
export * from '@nestvexa/views';
export * from '@nestvexa/live';
export { HbsEngine } from '@nestvexa/engine-hbs';
export { configureNestvexa, registerViewEngine } from './mvc.module.js';
export type { ViewEngineBridge } from './mvc.module.js';
export { NestvexaBrowserService } from './browser.module.js';
export type { NestvexaBrowserOptions } from './browser.module.js';

/** Host policies are required; the umbrella owns the shared HBS renderer. */
export type NestvexaLivePolicies = Omit<LiveRuntimeFactoryOptions, 'renderer'>;
/** Route structure is available synchronously, even when host policy configuration is async. */
export interface NestvexaLiveOptions<
  Dependencies extends unknown[] = unknown[],
> extends Omit<LiveModuleAsyncOptions<Dependencies>, 'useFactory'> {
  readonly browser?: NestvexaBrowserOptions;
  readonly useFactory: (
    ...dependencies: Dependencies
  ) => NestvexaLivePolicies | Promise<NestvexaLivePolicies>;
}

function dataObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`Invalid ${label}`);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error(`Invalid ${label}`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      !keys.includes(key) ||
      !descriptor ||
      !('value' in descriptor)
    )
      throw new Error(`Invalid ${label}`);
  }
}
function integrated<Dependencies extends unknown[]>(
  core: DynamicModule,
  live?: NestvexaLiveOptions<Dependencies>,
): DynamicModule {
  if (live === undefined) {
    return {
      module: NestvexaModule,
      imports: [NestvexaRendererModule.configure(core)],
      exports: [NestvexaRendererModule],
    };
  }
  dataObject(
    live,
    [
      'components',
      'endpoint',
      'basePath',
      'imports',
      'inject',
      'useFactory',
      'browser',
    ],
    'umbrella Live registration',
  );
  const factory = live.useFactory;
  if (typeof factory !== 'function')
    throw new Error('Live policy useFactory is required');
  const browser = NestvexaBrowserModule.register(live.browser, live.basePath);
  // Both values are validated enums; the core option documents the canonical sample.
  const browserMode: string = live.browser?.mode ?? 'alpine';
  // The same exported module object is imported by MVC and Live: no global DI escape.
  const renderer = NestvexaRendererModule.configure(core, browser);
  const registration = LiveModule.registerAsync<
    [HbsEngine, NestvexaConfigService, ...Dependencies]
  >({
    components: live.components,
    ...(live.endpoint === undefined ? {} : { endpoint: live.endpoint }),
    ...(live.basePath === undefined ? {} : { basePath: live.basePath }),
    imports: [renderer, ...(live.imports ?? [])],
    inject: [HbsEngine, NestvexaConfigService, ...(live.inject ?? [])],
    useFactory: async (engine, config, ...dependencies) => {
      if (!config.value.live.enabled)
        throw new Error(
          'Explicit Live registration requires live.enabled: true',
        );
      if (
        !config.value.security.csrf ||
        !config.value.security.requireAuthorizedActions
      )
        throw new Error('Integrated Live requires CSRF and authorized actions');
      if (
        config.value.live.client !== undefined &&
        config.value.live.client !== browserMode
      )
        throw new Error(
          `live.client "${config.value.live.client}" must match the Live browser mode "${browserMode}"`,
        );
      const policies = await factory(...dependencies);
      dataObject(
        policies,
        [
          'origin',
          'resolveIdentity',
          'authorize',
          'store',
          'maxRequestsPerMinute',
          'realtime',
          'instrumentation',
        ],
        'umbrella Live policies',
      );
      return { ...policies, renderer: engine };
    },
  });
  return {
    module: NestvexaModule,
    imports: [renderer, registration],
    exports: [NestvexaRendererModule, LiveModule],
  };
}

/** MVC by default; enable Live explicitly with registered types and host identity/authorization policies. */
@Module({})
export class NestvexaModule {
  static forRoot<Dependencies extends unknown[]>(
    options: NestvexaOptions = {},
    live?: NestvexaLiveOptions<Dependencies>,
  ): DynamicModule {
    return integrated(CoreModule.forRoot(options), live);
  }
  static forRootAsync<
    Dependencies extends unknown[],
    LiveDependencies extends unknown[],
  >(
    options: NestvexaAsyncOptions<Dependencies>,
    live?: NestvexaLiveOptions<LiveDependencies>,
  ): DynamicModule {
    return integrated(CoreModule.forRootAsync(options), live);
  }
}
