import { ForbiddenException, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';

/** Generated policy guard. Implement your rule; it denies everything until you do. */
@Injectable()
export class OwnerPolicy implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: unknown }>();
    if (!request.user) throw new ForbiddenException();
    return this.allows(request.user);
  }
  protected allows(_user: unknown): boolean {
    return false;
  }
}
