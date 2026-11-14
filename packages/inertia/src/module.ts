import { Module, RequestMethod } from '@nestjs/common';
import type {
  DynamicModule,
  InjectionToken,
  MiddlewareConsumer,
  ModuleMetadata,
  NestModule,
  OptionalFactoryDependency,
  Provider,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { INERTIA_OPTIONS } from './constants.js';
import { InertiaErrorPageFilter } from './error-page.js';
import { InertiaInterceptor } from './interceptor.js';
import { InertiaSecurityGuard } from './security-guard.js';
import { resolveOptions } from './options.js';
import {
  PrecognitionGuard,
  PrecognitionMiddleware,
} from './precognition-http.js';
import type { InertiaModuleOptions } from './options.js';
import { InertiaService } from './service.js';
import { InertiaValidationFilter } from './validation.js';

/** Structural registration choices (static so async options can use them too). */
export interface InertiaModuleBehaviour {
  /** Register the module globally so `@InertiaPage` works in every module. Default true. */
  readonly isGlobal?: boolean;
  /**
   * `global` (default) registers `InertiaInterceptor` as `APP_INTERCEPTOR`, so
   * version checks and `redirect()`/`location()` results work on every route.
   * `decorated` applies it only through `@InertiaPage`/`@UseInertia`.
   */
  readonly interceptor?: 'global' | 'decorated';
  /** Register `InertiaValidationFilter` as `APP_FILTER`. Default true. */
  readonly validationFilter?: boolean;
  /**
   * Register `InertiaErrorPageFilter` as `APP_FILTER`. Default: `forRoot`
   * registers it when the `errorPage` option is set; `forRootAsync` (whose
   * options are not known yet) only when this is `true`.
   */
  readonly errorPageFilter?: boolean;
}

export interface InertiaModuleAsyncOptions extends InertiaModuleBehaviour {
  readonly imports?: ModuleMetadata['imports'];
  readonly inject?: (InjectionToken | OptionalFactoryDependency)[];
  readonly useFactory: (
    ...args: never[]
  ) => InertiaModuleOptions | Promise<InertiaModuleOptions>;
}

const RAW_OPTIONS = Symbol.for('nestvexa.inertia.rawOptions');

function providers(
  behaviour: InertiaModuleBehaviour,
  raw: Provider,
): Provider[] {
  return [
    raw,
    {
      provide: INERTIA_OPTIONS,
      inject: [RAW_OPTIONS],
      useFactory: (options: InertiaModuleOptions) => resolveOptions(options),
    },
    InertiaService,
    InertiaInterceptor,
    InertiaValidationFilter,
    InertiaErrorPageFilter,
    PrecognitionGuard,
    InertiaSecurityGuard,
    // Keeps Precognition labels on guard rejections of @Precognitive routes.
    { provide: APP_GUARD, useExisting: PrecognitionGuard },
    ...(behaviour.interceptor === 'decorated'
      ? []
      : [{ provide: APP_INTERCEPTOR, useExisting: InertiaInterceptor }]),
    ...(behaviour.validationFilter === false
      ? []
      : [{ provide: APP_FILTER, useExisting: InertiaValidationFilter }]),
    ...(behaviour.errorPageFilter === true
      ? [{ provide: APP_FILTER, useExisting: InertiaErrorPageFilter }]
      : []),
  ];
}

const exported = [
  INERTIA_OPTIONS,
  InertiaService,
  InertiaInterceptor,
  InertiaValidationFilter,
  InertiaErrorPageFilter,
  InertiaSecurityGuard,
];

/** Nest dynamic module for the Inertia v3 server adapter. */
@Module({})
export class InertiaModule implements NestModule {
  /** Labels Precognition responses before any guard can reject them. */
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(PrecognitionMiddleware)
      .forRoutes({ path: '{*path}', method: RequestMethod.ALL });
  }

  static forRoot(
    options: InertiaModuleOptions & InertiaModuleBehaviour = {},
  ): DynamicModule {
    const {
      isGlobal,
      interceptor,
      validationFilter,
      errorPageFilter,
      ...config
    } = options;
    // Validate synchronously so configuration errors surface at module definition.
    resolveOptions(config);
    const behaviour = {
      ...(interceptor === undefined ? {} : { interceptor }),
      ...(validationFilter === undefined ? {} : { validationFilter }),
      errorPageFilter: errorPageFilter ?? config.errorPage !== undefined,
    };
    return {
      module: InertiaModule,
      global: isGlobal !== false,
      providers: providers(behaviour, {
        provide: RAW_OPTIONS,
        useValue: config,
      }),
      exports: exported,
    };
  }

  static forRootAsync(options: InertiaModuleAsyncOptions): DynamicModule {
    const behaviour = {
      ...(options.interceptor === undefined
        ? {}
        : { interceptor: options.interceptor }),
      ...(options.validationFilter === undefined
        ? {}
        : { validationFilter: options.validationFilter }),
      ...(options.errorPageFilter === undefined
        ? {}
        : { errorPageFilter: options.errorPageFilter }),
    };
    return {
      module: InertiaModule,
      global: options.isGlobal !== false,
      imports: options.imports ?? [],
      providers: providers(behaviour, {
        provide: RAW_OPTIONS,
        inject: options.inject ?? [],
        useFactory: options.useFactory,
      }),
      exports: exported,
    };
  }
}
