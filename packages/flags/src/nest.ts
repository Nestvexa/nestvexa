import {
  ForbiddenException,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  SetMetadata,
} from '@nestjs/common';
import type {
  CanActivate,
  CustomDecorator,
  DynamicModule,
  ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { assertFlagName, FlagService } from './core.js';
import type { FlagContext, FlagServiceOptions } from './core.js';

export const REQUIRE_FLAG = 'nestvexa:require-flag';
export const FLAGS_OPTIONS: unique symbol = Symbol('nestvexa:flags-options');

export interface FlagsModuleOptions extends FlagServiceOptions {
  /** Derive the context from the authenticated request (never from query/body). */
  readonly context: (request: object) => FlagContext | Promise<FlagContext>;
  /** Status for a disabled route; default 404 so hidden features stay hidden. */
  readonly denyStatus?: 403 | 404;
}

/** Require an enabled flag for a controller or handler guarded by `FlagGuard`. */
export function RequireFlag(flag: string): CustomDecorator<string> {
  assertFlagName(flag);
  return SetMetadata(REQUIRE_FLAG, flag);
}

/** Evaluates all known flags once per request object and memoizes the result. */
@Injectable()
export class FlagRequestContext {
  readonly #cache = new WeakMap<
    object,
    Promise<Readonly<Record<string, boolean>>>
  >();
  constructor(
    @Inject(FLAGS_OPTIONS) private readonly options: FlagsModuleOptions,
    @Inject(FlagService) private readonly service: FlagService,
  ) {}
  forRequest(request: object): Promise<Readonly<Record<string, boolean>>> {
    if (typeof request !== 'object' || request === null)
      return Promise.reject(new Error('A request object is required'));
    let result = this.#cache.get(request);
    if (!result) {
      result = this.#evaluate(request);
      this.#cache.set(request, result);
    }
    return result;
  }
  async #evaluate(request: object): Promise<Readonly<Record<string, boolean>>> {
    let context: FlagContext;
    try {
      context = await this.options.context(request);
    } catch (error) {
      // Without a trusted context every flag is off.
      try {
        this.options.onError?.(error, '*');
      } catch {
        // ignore reporter failures
      }
      const closed = Object.create(null) as Record<string, boolean>;
      for (const flag of this.service.flags) closed[flag] = false;
      return Object.freeze(closed);
    }
    return this.service.evaluate(context);
  }
}

/** Denies routes whose `@RequireFlag` flag is off for the current request. */
@Injectable()
export class FlagGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(FlagRequestContext) private readonly flags: FlagRequestContext,
    @Inject(FLAGS_OPTIONS) private readonly options: FlagsModuleOptions,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const flag = this.reflector.getAllAndOverride<string | undefined>(
      REQUIRE_FLAG,
      [context.getHandler(), context.getClass()],
    );
    if (flag === undefined) return true;
    const request = context.switchToHttp().getRequest<object>();
    const values = await this.flags.forRequest(request);
    if (Object.getOwnPropertyDescriptor(values, flag)?.value === true)
      return true;
    if (this.options.denyStatus === 403)
      throw new ForbiddenException('Feature unavailable');
    throw new NotFoundException();
  }
}

@Module({})
export class FlagsModule {
  static forRoot(options: FlagsModuleOptions): DynamicModule {
    if (typeof options?.context !== 'function')
      throw new Error('FlagsModule requires a context resolver');
    if (
      options.denyStatus !== undefined &&
      options.denyStatus !== 403 &&
      options.denyStatus !== 404
    )
      throw new Error('denyStatus must be 403 or 404');
    const service = new FlagService(options);
    return {
      module: FlagsModule,
      providers: [
        { provide: FLAGS_OPTIONS, useValue: options },
        { provide: FlagService, useValue: service },
        FlagRequestContext,
        FlagGuard,
      ],
      exports: [FlagService, FlagRequestContext, FlagGuard, FLAGS_OPTIONS],
    };
  }
}
