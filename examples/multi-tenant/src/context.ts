import { UnauthorizedException } from '@nestjs/common';
import type { LiveIdentity } from 'nestvexa';
import type { Directory, Access, Role } from './tenancy.js';

/*
 * One request context for every transport. MVC pages, Live components,
 * Inertia pages, server actions, uploads, realtime and island props all derive
 * the signed-in user and the active tenant from this module, which reads only
 * the server-side session and re-checks the membership against the directory
 * on every call. Nothing here accepts a user id or a tenant id from the
 * browser: the tenant is chosen by a guarded route (`/t/:tenant/...`) and then
 * remembered server-side.
 */

export interface RequestContext {
  readonly sessionId: string;
  readonly csrfToken: string;
  /** The verified access to the active tenant, or undefined (guest, no tenant, revoked). */
  readonly access: Access | undefined;
  /**
   * Binds state to the account, tenant, role and session:
   * `user:<id>:tenant:<slug>:role:<role>:session:<sid>` or `guest:session:<sid>`.
   */
  readonly binding: string;
}

/** The context, or undefined before the session has a CSRF token. */
export function requestContext(
  directory: Directory,
  request: object,
): RequestContext | undefined {
  const session: unknown = Reflect.get(request, 'session');
  const sessionId: unknown = Reflect.get(request, 'sessionID');
  const csrfToken: unknown =
    session && typeof session === 'object'
      ? Reflect.get(session, 'csrf')
      : undefined;
  if (typeof sessionId !== 'string' || typeof csrfToken !== 'string')
    return undefined;
  const access = directory.activeAccess(request);
  const subject = access
    ? `user:${access.userId}:tenant:${access.tenant.slug}:role:${access.role}`
    : 'guest';
  return {
    sessionId,
    csrfToken,
    access,
    binding: `${subject}:session:${sessionId}`,
  };
}

const bindingPattern =
  /^user:(u-[a-z]+):tenant:([a-z]+):role:(member|admin):session:[^:]+$/;
/** Parses a binding made by `requestContext`; guests return undefined. */
export function parseBinding(
  binding: string,
): { userId: string; tenant: string; role: Role } | undefined {
  const match = bindingPattern.exec(binding);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return { userId: match[1], tenant: match[2], role: match[3] as Role };
}

/**
 * Re-checks a binding against the current directory: the account must still
 * hold that role in that tenant. Used by policies that only see the binding
 * (realtime channels), so a revoked membership loses access immediately.
 */
export function currentMember(
  directory: Directory,
  binding: string,
): { userId: string; tenant: string; role: Role } | undefined {
  const parsed = parseBinding(binding);
  const account = parsed ? directory.account(parsed.userId) : undefined;
  if (!parsed || !account) return undefined;
  return directory.role(account, parsed.tenant) === parsed.role
    ? parsed
    : undefined;
}

function required(directory: Directory, request: object): RequestContext {
  const context = requestContext(directory, request);
  if (!context) throw new UnauthorizedException();
  return context;
}

/** Live: snapshots are bound to the full binding. */
export function liveIdentity(
  directory: Directory,
  request: object,
): LiveIdentity {
  const context = required(directory, request);
  return { binding: context.binding, csrfToken: context.csrfToken };
}

/** Server actions: subject is the account, tenant is the verified active tenant. */
export function actionIdentity(directory: Directory, request: object) {
  const context = requestContext(directory, request);
  if (!context) return null;
  return {
    subject: context.access
      ? `user:${context.access.userId}`
      : `guest:${context.sessionId}`,
    csrfToken: context.csrfToken,
    ...(context.access ? { tenant: context.access.tenant.slug } : {}),
  };
}

/** Uploads: tokens are bound to the binding; the tenant is the quota bucket. */
export function uploadIdentity(directory: Directory, request: object) {
  const context = required(directory, request);
  return {
    binding: context.binding,
    csrfToken: context.csrfToken,
    ...(context.access ? { tenant: context.access.tenant.slug } : {}),
  };
}

/** Realtime: connection tokens are bound to the binding. */
export function realtimeIdentity(directory: Directory, request: object) {
  return { binding: requestContext(directory, request)?.binding ?? 'guest' };
}

/** The one realtime channel of a tenant's project board (server-chosen). */
export const projectsChannel = (tenant: string) => `tenant:${tenant}:projects`;

/** Members read their tenant's channel only, re-checked against the directory. */
export function authorizeChannel(
  directory: Directory,
  identity: { binding: string },
  channel: string,
): boolean {
  const member = currentMember(directory, identity.binding);
  return member !== undefined && channel === projectsChannel(member.tenant);
}

/** Inertia shared props: display data of the same context, never ids or secrets. */
export function sharedProps(directory: Directory, request: object) {
  const access = requestContext(directory, request)?.access;
  return {
    userName: access?.userName ?? '',
    tenantName: access?.tenant.name ?? '',
    role: access?.role ?? '',
  };
}
