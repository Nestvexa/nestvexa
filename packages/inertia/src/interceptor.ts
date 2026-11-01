import { Inject, Injectable } from '@nestjs/common';
import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, mergeMap, of } from 'rxjs';
import type { Observable } from 'rxjs';
import { INERTIA_PAGE_METADATA } from './constants.js';
import type { InertiaPageMetadata } from './decorators.js';
import { InertiaConfigurationError } from './errors.js';
import { isPlainObject } from './resolver.js';
import { InertiaPageResult, isInertiaResult } from './results.js';
import { InertiaService } from './service.js';

/**
 * Applies the Inertia protocol around Nest route handlers:
 *
 * 1. validates `X-Inertia-*` headers (400 on malformed input) and answers an
 *    asset-version mismatch on Inertia GET requests with `409` before the
 *    handler runs (guards have already run);
 * 2. turns `@InertiaPage` return values and Inertia results (`inertia()`,
 *    `redirect()`, `back()`, `location()`) into protocol replies.
 *
 * Other handler results pass through untouched. Exactly one interceptor
 * instance owns a request, so global and decorator registration can coexist.
 */
@Injectable()
export class InertiaInterceptor implements NestInterceptor {
  constructor(
    @Inject(InertiaService) private readonly inertia: InertiaService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const request = http.getRequest<object>();
    const response = http.getResponse<object>();
    if (!this.inertia.claim(request)) return next.handle();
    const metadata = this.reflector.get<InertiaPageMetadata | undefined>(
      INERTIA_PAGE_METADATA,
      context.getHandler(),
    );
    return from(this.#before(request, response, metadata)).pipe(
      mergeMap((conflict) =>
        conflict === undefined
          ? next
              .handle()
              .pipe(
                mergeMap((value) =>
                  this.#after(request, response, metadata, value),
                ),
              )
          : of(conflict),
      ),
    );
  }

  async #before(
    request: object,
    response: object,
    metadata: InertiaPageMetadata | undefined,
  ): Promise<string | undefined> {
    this.inertia.requestInfo(request);
    const conflict = await this.inertia.versionConflict(
      request,
      this.inertia.appFor(request, metadata?.options.app),
    );
    if (!conflict) return undefined;
    this.inertia.applyHead(response, conflict);
    return conflict.body;
  }

  async #after(
    request: object,
    response: object,
    metadata: InertiaPageMetadata | undefined,
    value: unknown,
  ): Promise<unknown> {
    let result = value;
    if (metadata && !isInertiaResult(value)) {
      if (value !== undefined && value !== null && !isPlainObject(value))
        throw new InertiaConfigurationError(
          '@InertiaPage handlers must return a plain props object or an Inertia result',
        );
      result = new InertiaPageResult(
        metadata.component,
        (value ?? {}) as Record<string, unknown>,
        metadata.options,
      );
    }
    if (!isInertiaResult(result)) return value;
    const reply = await this.inertia.build(
      request,
      result,
      metadata?.options.app,
    );
    this.inertia.applyHead(response, reply);
    return reply.body;
  }
}
