import type { Type } from '@nestjs/common';
import type { ActionsModuleOptions } from '@nestvexa/actions';
import { GreeterActions } from '../actions/greeter.actions.js';

/** Explicit action groups. `nestvexa make:action` appends here. */
export const actionGroups: Type<object>[] = [
  GreeterActions,
  // nestvexa:action-groups
];
/** Deny by default: group id → allowed action ids. */
export const allowedActions: Record<string, readonly string[]> = {
  greeter: ['greet'],
  // nestvexa:action-policy
};

/**
 * Host-owned policy. This starter uses the express-session guest session and
 * CSRF token created by `nestvexa init`; replace it with your authentication.
 */
export const actionsOptions: ActionsModuleOptions = {
  groups: actionGroups,
  origin: process.env['NESTVEXA_ORIGIN'] ?? 'http://localhost:3000',
  resolveIdentity: (request) => {
    const session: unknown = Reflect.get(request, 'session');
    const id: unknown = Reflect.get(request, 'sessionID');
    const csrf: unknown =
      session && typeof session === 'object' ? Reflect.get(session, 'csrf') : undefined;
    if (typeof id !== 'string' || typeof csrf !== 'string') return null;
    return { subject: `session:${id}`, csrfToken: csrf };
  },
  authorize: (_identity, action) => allowedActions[action.group]?.includes(action.action) ?? false,
};
