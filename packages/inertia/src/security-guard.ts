import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { InertiaService } from './service.js';

/**
 * Origin and CSRF admission for Inertia routes, decided by the `security`
 * policies (through the kernel registry when `policies` is configured).
 * Unsafe methods need an allowed `Origin` and a matching `X-XSRF-TOKEN`;
 * rejections are `403 ORIGIN_REJECTED` / `403 CSRF_REJECTED`. Apply it to
 * Inertia controllers (`@UseGuards(InertiaSecurityGuard)`) or globally
 * (`{ provide: APP_GUARD, useExisting: InertiaSecurityGuard }`) when no
 * other transport (Live, server actions, uploads) shares the routes: those
 * carry their own CSRF header. Without `security` it admits everything.
 */
@Injectable()
export class InertiaSecurityGuard implements CanActivate {
  constructor(
    @Inject(InertiaService) private readonly inertia: InertiaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    await this.inertia.admit(context.switchToHttp().getRequest<object>());
    return true;
  }
}
