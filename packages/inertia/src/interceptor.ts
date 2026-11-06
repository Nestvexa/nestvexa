import { Inject, Injectable } from '@nestjs/common';
import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  REDIRECT_METADATA,
  RENDER_METADATA,
  ROUTE_ARGS_METADATA,
  SSE_METADATA,
} from '@nestjs/common/constants.js';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum.js';
import { Reflector } from '@nestjs/core';
import { from, mergeMap, of } from 'rxjs';
import type { Observable } from 'rxjs';
import { INERTIA_PAGE_METADATA, PRECOGNITION_METADATA } from './constants.js';
import type { InertiaPageMetadata } from './decorators.js';
import { InertiaConfigurationError } from './errors.js';
import {
  PrecognitionHeader,
  defaultPrecognitionInput,
  runPrecognitionValidator,
} from './precognition.js';
import type { PrecognitionMetadata } from './precognition.js';
import { isPlainObject } from './resolver.js';
import {
  InertiaBackResult,
  InertiaPageResult,
  isInertiaResult,
} from './results.js';
import { InertiaService } from './service.js';
import { InertiaValidationException } from './validation.js';
import type { InertiaErrors } from './validation-types.js';

/**
 * Applies the Inertia protocol around Nest route handlers:
 *
 * 1. validates `X-Inertia-*` headers (400 on malformed input) and answers an
 *    asset-version mismatch on Inertia GET requests with `409` before the
 *    handler runs (guards have already run);
 * 2. answers Precognition requests on `@Precognitive` routes with
 *    validation only (`204`/`422`), so neither pipes nor the handler run;
 * 3. turns `@InertiaPage` return values and Inertia results (`inertia()`,
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
    const precognition = this.reflector.get<PrecognitionMetadata | undefined>(
      PRECOGNITION_METADATA,
      context.getHandler(),
    );
    return from(this.#before(request, response, metadata, precognition)).pipe(
      mergeMap((conflict) =>
        conflict === undefined
          ? next
              .handle()
              .pipe(
                mergeMap((value) =>
                  this.#after(
                    request,
                    response,
                    metadata,
                    value === undefined && this.#autoBack(context, request)
                      ? new InertiaBackResult()
                      : value,
                  ),
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
    precognition: PrecognitionMetadata | undefined,
  ): Promise<string | undefined> {
    this.inertia.requestInfo(request);
    const conflict = await this.inertia.versionConflict(
      request,
      this.inertia.appFor(request, metadata?.options.app),
    );
    if (conflict) {
      this.inertia.applyHead(response, conflict);
      return conflict.body;
    }
    if (!precognition) return undefined;
    if (!this.inertia.precognition(request).precognitive) {
      this.inertia.applyHeaders(response, {
        Vary: PrecognitionHeader.precognition,
      });
      return undefined;
    }
    return this.#precognition(request, response, precognition);
  }

  /** Validation-only answer; the handler never runs for Precognition requests. */
  async #precognition(
    request: object,
    response: object,
    { validator, input }: PrecognitionMetadata,
  ): Promise<string> {
    let errors: InertiaErrors | undefined;
    try {
      errors = await runPrecognitionValidator(
        validator,
        (input ?? defaultPrecognitionInput)(request),
        request,
      );
    } catch (error) {
      if (!(error instanceof InertiaValidationException)) {
        // The official client rejects any reply without this header; keep it
        // on the error response the exception filters produce.
        this.inertia.applyHeaders(response, {
          [PrecognitionHeader.precognition]: 'true',
          Vary: PrecognitionHeader.precognition,
        });
        throw error;
      }
      errors = error.errors;
    }
    const reply = this.inertia.precognitionReply(request, errors);
    this.inertia.applyHead(response, reply);
    return reply.body;
  }

  /**
   * Empty-response handling (as `inertia-laravel`'s `onEmptyResponse`): an
   * Inertia request whose handler returned nothing is redirected back. Never
   * applies to `@InertiaPage` routes, handlers that own the response
   * (`@Res()`/`@Next()`), or handlers that declare `@HttpCode`, `@Redirect`,
   * `@Render` or `@Sse`.
   */
  #autoBack(context: ExecutionContext, request: object): boolean {
    if (this.inertia.emptyResponse !== 'back') return false;
    if (!this.inertia.requestInfo(request).inertia) return false;
    const handler = context.getHandler();
    for (const key of [
      INERTIA_PAGE_METADATA,
      HTTP_CODE_METADATA,
      REDIRECT_METADATA,
      RENDER_METADATA,
      SSE_METADATA,
    ])
      if (this.reflector.get<unknown>(key, handler) !== undefined) return false;
    const args: unknown = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      context.getClass(),
      handler.name,
    );
    if (typeof args === 'object' && args !== null)
      for (const key of Object.keys(args)) {
        const type = Number(key.split(':')[0]);
        if (type === RouteParamtypes.RESPONSE || type === RouteParamtypes.NEXT)
          return false;
      }
    return true;
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
