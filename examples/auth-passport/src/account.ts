import { Inject, UnauthorizedException } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Action, Computed, LiveComponent, State } from 'nestvexa';
import { currentUser } from './auth.js';
import { UserStore } from './users.js';
import type { User } from './users.js';

/**
 * Live account panel. The user is never component state: every render and
 * action re-reads the Passport session (`request.user`), so a snapshot cannot
 * name another account, and a revoked session stops working immediately.
 */
@LiveComponent({ name: 'account-panel', view: 'account-panel' })
export class AccountPanel {
  constructor(
    @Inject(UserStore) private readonly users: UserStore,
    @Inject(REQUEST) private readonly request: object,
  ) {}
  @State({
    writable: true,
    validate: (value: unknown) =>
      typeof value === 'string' && value.length <= 120,
  })
  draft = '';
  @State() error = '';
  @State() message = '';

  private user(): User {
    const user = currentUser(this.request);
    if (!user) throw new UnauthorizedException();
    return user;
  }
  @Computed() get profile() {
    const { name, email, role, verifiedAt } = this.user();
    return { name, email, role, verified: verifiedAt !== undefined };
  }
  @Action() rename(): void {
    const user = this.user();
    const name = this.draft.trim();
    if (name.length < 1 || name.length > 60) {
      this.error = 'Enter a name of up to 60 characters.';
      this.message = '';
      return;
    }
    this.users.rename(user.id, name);
    // Passport loaded the user before this request; keep the render current.
    Reflect.set(this.request, 'user', { ...user, name });
    this.draft = '';
    this.error = '';
    this.message = `Your name is now ${name}.`;
  }
}
