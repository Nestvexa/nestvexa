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
  /** Your rule for an authenticated user; denies until implemented. */
  protected allows(user: unknown): boolean {
    void user;
    return false;
  }
}
