import { Inject, Injectable } from '@nestjs/common';
import type {
  CanActivate,
  ExecutionContext,
  NestMiddleware,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PRECOGNITION_METADATA } from './constants.js';
import {
  isPrecognitionRequest,
  markPrecognitionResponse,
  unmarkPrecognitionResponse,
} from './precognition.js';

/**
 * Labels every `Precognition: true` request's response with
 * `Precognition: true` and `Vary: Precognition` before guards run. The
 * official client (`laravel-precognition`) rejects any reply without the
 * header, so a guard rejection (401/403/419/429) on a `@Precognitive` route
 * would otherwise surface as "Did not receive a Precognition response"
 * instead of reaching `onUnauthorized`/`onForbidden`. `PrecognitionGuard`
 * removes the label again for routes that are not precognitive, before their
 * handler runs. Registered by `InertiaModule` for every route.
 */
@Injectable()
export class PrecognitionMiddleware implements NestMiddleware {
  use(request: object, response: object, next: () => void): void {
    if (isPrecognitionRequest(request)) markPrecognitionResponse(response);
    next();
  }
}

/**
 * Global guard registered by `InertiaModule`; it never rejects. For a
 * `Precognition: true` request it keeps (or sets) the Precognition labels on
 * `@Precognitive` routes, so later guard rejections still carry them, and
 * removes them on other routes, whose handler runs and must not look like a
 * validation-only reply (as upstream, where only the Precognition middleware
 * adds the header).
 */
@Injectable()
export class PrecognitionGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const http = context.switchToHttp();
    const request = http.getRequest<object>();
    if (!isPrecognitionRequest(request)) return true;
    const response = http.getResponse<object>();
    if (
      this.reflector.get<unknown>(PRECOGNITION_METADATA, context.getHandler())
    )
      markPrecognitionResponse(response);
    else unmarkPrecognitionResponse(response);
    return true;
  }
}
