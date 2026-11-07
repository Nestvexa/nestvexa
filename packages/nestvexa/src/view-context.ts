import { Inject, Injectable } from '@nestjs/common';
import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from '@nestjs/common';
import { RENDER_METADATA } from '@nestjs/common/constants.js';
import { RequestContextFactory } from '@nestvexa/core';
import { mergeMap } from 'rxjs';
import type { Observable } from 'rxjs';

/** View model key holding the request's public context. */
export const VIEW_CONTEXT_KEY = 'nvRequest';

function plainModel(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Adds `nvRequest` (the `RequestContextFactory` public context:
 * `correlationId`, `cspNonce`, `tenant`, `authenticated`) to the model of
 * every `@Render()` handler, so templates read the per-request CSP nonce
 * from the kernel: `{{nvScripts nonce=nvRequest.cspNonce}}`. The context is
 * the one `RequestContextFactory.create(request)` returns to controllers, so
 * a `Content-Security-Policy` header built from it carries the same nonce.
 * Models that already define `nvRequest`, non-plain results and non-render
 * routes are left untouched. Session, principal and extension fields never
 * reach templates.
 */
@Injectable()
export class NestvexaViewContextInterceptor implements NestInterceptor {
  constructor(
    @Inject(RequestContextFactory)
    private readonly contexts: RequestContextFactory,
  ) {}
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (
      context.getType() !== 'http' ||
      Reflect.getMetadata(RENDER_METADATA, context.getHandler()) === undefined
    )
      return next.handle();
    const request = context.switchToHttp().getRequest<object>();
    return next.handle().pipe(
      mergeMap(async (model: unknown) => {
        if (!plainModel(model) || Object.hasOwn(model, VIEW_CONTEXT_KEY))
          return model;
        const { public: view } = await this.contexts.create(request);
        return { ...model, [VIEW_CONTEXT_KEY]: view };
      }),
    );
  }
}
