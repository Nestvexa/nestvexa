import { Inject, Injectable, Module } from '@nestjs/common';
import type {
  CallHandler,
  DynamicModule,
  ExecutionContext,
  InjectionToken,
  OptionalFactoryDependency,
  NestInterceptor,
  Provider,
} from '@nestjs/common';
import { RENDER_METADATA } from '@nestjs/common/constants.js';
import { map } from 'rxjs';
import type { Observable } from 'rxjs';
import { I18nError, isPlainObject } from './errors.js';
import { I18n } from './i18n.js';
import type { I18nOptions } from './i18n.js';

export interface I18nModuleOptions {
  /** Register the I18n provider globally; default false (explicit imports). */
  readonly global?: boolean;
}
export interface I18nModuleAsyncOptions<
  Dependencies extends unknown[],
> extends I18nModuleOptions {
  readonly imports?: DynamicModule['imports'];
  readonly inject?: readonly (InjectionToken | OptionalFactoryDependency)[];
  readonly useFactory: (
    ...dependencies: Dependencies
  ) => I18nOptions | Promise<I18nOptions>;
}

interface HeaderTarget {
  setHeader?: (name: string, value: string) => unknown;
  getHeader?: (name: string) => unknown;
  header?: (name: string, value: string) => unknown;
}

function setHeader(response: unknown, name: string, value: string): void {
  if (!response || typeof response !== 'object') return;
  const target = response as HeaderTarget;
  if (typeof target.setHeader === 'function') target.setHeader(name, value);
  else if (typeof target.header === 'function') target.header(name, value);
}

function appendVary(response: unknown, values: readonly string[]): void {
  if (!response || typeof response !== 'object') return;
  const target = response as HeaderTarget;
  const current: unknown =
    typeof target.getHeader === 'function'
      ? target.getHeader('Vary')
      : undefined;
  const tokens = (typeof current === 'string' ? current.split(',') : [])
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.includes('*')) return;
  for (const value of values)
    if (!tokens.some((token) => token.toLowerCase() === value.toLowerCase()))
      tokens.push(value);
  setHeader(response, 'Vary', tokens.join(', '));
}

/**
 * Opt-in (`@UseInterceptors(LocaleViewInterceptor)`). For `@Render` handlers only:
 * merges `{ i18n: I18nView }` into plain-object results, sets `Content-Language`
 * and appends `Vary: Accept-Language, Cookie` so shared caches key on locale.
 */
@Injectable()
export class LocaleViewInterceptor implements NestInterceptor {
  constructor(@Inject(I18n) private readonly i18n: I18n) {}
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const template: unknown = Reflect.getMetadata(
      RENDER_METADATA,
      context.getHandler(),
    );
    if (template === undefined) return next.handle();
    const http = context.switchToHttp();
    const request: unknown = http.getRequest();
    if (!request || typeof request !== 'object') return next.handle();
    const locale = this.i18n.forRequest(request);
    const response: unknown = http.getResponse();
    setHeader(response, 'Content-Language', locale.locale);
    appendVary(response, ['Accept-Language', 'Cookie']);
    return next.handle().pipe(
      map((result: unknown) => {
        if (!isPlainObject(result)) return result;
        if (Object.prototype.hasOwnProperty.call(result, 'i18n'))
          throw new I18nError(
            'CONFIG',
            'Render result already defines i18n; rename the property',
          );
        const merged: Record<string, unknown> = Object.defineProperties(
          {},
          Object.getOwnPropertyDescriptors(result),
        );
        Object.defineProperty(merged, 'i18n', {
          value: locale.view,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        return merged;
      }),
    );
  }
}

function dynamicModule(
  providers: Provider[],
  options: I18nModuleOptions,
  imports: NonNullable<DynamicModule['imports']>,
): DynamicModule {
  return {
    module: I18nModule,
    global: options.global === true,
    imports,
    providers: [...providers, LocaleViewInterceptor],
    exports: [I18n, LocaleViewInterceptor],
  };
}
/** Nest integration: exports the `I18n` instance and `LocaleViewInterceptor`. */
@Module({})
export class I18nModule {
  static forRoot(
    options: I18nOptions,
    module: I18nModuleOptions = {},
  ): DynamicModule {
    const i18n = new I18n(options);
    return dynamicModule([{ provide: I18n, useValue: i18n }], module, []);
  }
  static forRootAsync<Dependencies extends unknown[]>(
    options: I18nModuleAsyncOptions<Dependencies>,
  ): DynamicModule {
    if (typeof options.useFactory !== 'function')
      throw new I18nError('CONFIG', 'useFactory is required');
    const factory = options.useFactory;
    return dynamicModule(
      [
        {
          provide: I18n,
          inject: [...(options.inject ?? [])],
          useFactory: async (...dependencies: unknown[]) =>
            new I18n(await factory(...(dependencies as Dependencies))),
        },
      ],
      options,
      options.imports ?? [],
    );
  }
}
