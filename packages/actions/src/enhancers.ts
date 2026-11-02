import { Catch, Inject, Injectable } from '@nestjs/common';
import type {
  ArgumentsHost,
  CallHandler,
  CanActivate,
  ExceptionFilter,
  ExecutionContext,
  NestInterceptor,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { defer, lastValueFrom } from 'rxjs';
import type { Observable } from 'rxjs';
import type { ActionDefinition, ActionGroupDefinition } from './metadata.js';
import { ActionsRuntime } from './runtime.js';
import { requestIdFor } from './state.js';
import { REQUEST_ID_HEADER } from './shared/protocol.js';
import type { ActionSuccessEnvelope } from './shared/protocol.js';

/** Metadata placed on each generated handler; never derived from the request. */
export const ACTION_ROUTE = 'nestvexa:actions:route';
export interface ActionRoute {
  readonly group: ActionGroupDefinition;
  readonly action: ActionDefinition;
}

function route(context: ExecutionContext): ActionRoute {
  const value: unknown = Reflect.getMetadata(
    ACTION_ROUTE,
    context.getHandler(),
  );
  if (typeof value !== 'object' || value === null)
    throw new Error('Missing server action route contract');
  return value as ActionRoute;
}

/** First class-level guard: request admission before application guards. */
@Injectable()
export class ActionsAdmissionGuard implements CanActivate {
  constructor(
    @Inject(ActionsRuntime) private readonly runtime: ActionsRuntime,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { group, action } = route(context);
    const http = context.switchToHttp();
    await this.runtime.admit(
      http.getRequest<object>(),
      http.getResponse<unknown>(),
      group,
      action,
    );
    return true;
  }
}

/** Outermost class-level interceptor: deadline, dispatch policy, replay and envelope. */
@Injectable()
export class ActionsEnvelopeInterceptor implements NestInterceptor {
  constructor(
    @Inject(ActionsRuntime) private readonly runtime: ActionsRuntime,
  ) {}
  intercept(
    context: ExecutionContext,
    next: CallHandler<unknown>,
  ): Observable<ActionSuccessEnvelope> {
    const http = context.switchToHttp();
    return defer(() =>
      this.runtime.run(
        http.getRequest<object>(),
        http.getResponse<unknown>(),
        () => lastValueFrom(next.handle(), { defaultValue: undefined }),
      ),
    );
  }
}

/**
 * Lowest-priority class-level filter (application method/class filters win).
 * Produces the typed failure envelope with a correlation id.
 */
@Catch()
@Injectable()
export class ActionsExceptionFilter implements ExceptionFilter {
  constructor(
    @Inject(ActionsRuntime) private readonly runtime: ActionsRuntime,
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
  ) {}
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<object>();
    const response = http.getResponse<unknown>();
    const described = this.runtime.describe(exception);
    this.runtime.report(request, exception, described);
    const adapter = this.adapterHost.httpAdapter;
    if (adapter.isHeadersSent(response)) {
      adapter.end(response);
      return;
    }
    const requestId = requestIdFor(request);
    adapter.setHeader(response, REQUEST_ID_HEADER, requestId);
    adapter.setHeader(response, 'cache-control', 'no-store');
    adapter.reply(
      response,
      this.runtime.failure(requestId, described.body),
      described.status,
    );
  }
}
