import {
  ForbiddenException,
  Inject,
  Injectable,
  Module,
  UnauthorizedException,
} from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Session, SessionData } from 'express-session';
import { DEMO_PASSWORD, accounts, workspaces } from './seed.js';
import type { Account, Role, Workspace } from './seed.js';

/*
 * Host-owned authentication and authorization. Nestvexa never decides who a
 * user is: every package (Live, realtime, uploads, Inertia routes) receives
 * the identity this file resolves from the server-side session.
 */

declare module 'express-session' {
  interface SessionData {
    csrf?: string;
    userId?: string;
    xsrf?: string;
  }
}
export interface SessionRequest {
  session: Session & Partial<SessionData>;
  sessionID: string;
  method?: string;
  path?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
}

/** The verified access of one request: account, workspace and role. */
export interface Access {
  readonly user: Account;
  readonly workspace: Workspace;
  readonly role: Role;
}

// scrypt N=2^14, r=8, p=1, per-account salt, constant-time comparison.
const cost = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, 64, cost, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
}

@Injectable()
export class Directory {
  readonly #hashes = new Map<string, Promise<{ salt: Buffer; key: Buffer }>>();
  readonly #dummy = (async () => {
    const salt = randomBytes(16);
    return { salt, key: await derive(randomBytes(16).toString('hex'), salt) };
  })();
  constructor() {
    for (const account of accounts) {
      const salt = randomBytes(16);
      this.#hashes.set(
        account.id,
        derive(DEMO_PASSWORD, salt).then((key) => ({ salt, key })),
      );
    }
  }
  account(id: string): Account | undefined {
    return accounts.find((account) => account.id === id);
  }
  workspace(slug: string): Workspace | undefined {
    return workspaces.find((workspace) => workspace.slug === slug);
  }
  members(workspace: string): readonly Account[] {
    return accounts.filter((account) => account.workspace === workspace);
  }
  /** Unknown emails still pay for one derivation (no account enumeration by timing). */
  async authenticate(
    email: string,
    password: string,
  ): Promise<Account | undefined> {
    const account = accounts.find(
      (item) => item.email === email.trim().toLowerCase(),
    );
    const stored = await (account
      ? (this.#hashes.get(account.id) ?? this.#dummy)
      : this.#dummy);
    const actual = await derive(password, stored.salt);
    return timingSafeEqual(actual, stored.key) && account ? account : undefined;
  }
  /** The signed-in access, read only from the server-side session. */
  access(request: object): Access | undefined {
    const session: unknown = Reflect.get(request, 'session');
    const id: unknown =
      session && typeof session === 'object'
        ? Reflect.get(session, 'userId')
        : undefined;
    const user = typeof id === 'string' ? this.account(id) : undefined;
    const workspace = user ? this.workspace(user.workspace) : undefined;
    return user && workspace ? { user, workspace, role: user.role } : undefined;
  }
  require(request: object): Access {
    const access = this.access(request);
    if (!access) throw new UnauthorizedException('Sign in required');
    return access;
  }
}

/**
 * The identity binding shared by Live snapshots, realtime tokens and upload
 * tokens. It names the account, workspace, role and session, so state rendered
 * for one of them is unusable by any other (sign-out, another account, a role
 * change all invalidate it).
 */
export function bindingOf(directory: Directory, request: object): string {
  const value = request as Partial<SessionRequest>;
  if (!value.session?.csrf || !value.sessionID)
    throw new UnauthorizedException();
  const access = directory.access(request);
  return access
    ? `user:${access.user.id}:ws:${access.workspace.slug}:role:${access.role}:session:${value.sessionID}`
    : `guest:session:${value.sessionID}`;
}

const bindingPattern =
  /^user:(u-[a-z]+):ws:([a-z]+):role:(member|admin):session:[^:]+$/;
/** Parses a binding produced by `bindingOf`; guests return undefined. */
export function parseBinding(
  binding: string,
): { userId: string; workspace: string; role: Role } | undefined {
  const match = bindingPattern.exec(binding);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return { userId: match[1], workspace: match[2], role: match[3] as Role };
}

/** The identity shape of Live and uploads; the workspace is the upload quota bucket. */
export function liveIdentity(
  directory: Directory,
  request: object,
): { binding: string; csrfToken: string; tenant?: string } {
  const csrf = (request as Partial<SessionRequest>).session?.csrf;
  if (!csrf) throw new UnauthorizedException();
  const workspace = directory.access(request)?.workspace.slug;
  return {
    binding: bindingOf(directory, request),
    csrfToken: csrf,
    ...(workspace ? { tenant: workspace } : {}),
  };
}

/** Opaque, server-chosen realtime channels. */
export const metricsChannel = (workspace: string) => `metrics:${workspace}`;
export const notificationsChannel = (userId: string) => `notify:${userId}`;

/**
 * Channel policy, checked when tokens are signed and again on connect and
 * before delivery: workspace metrics for its members only, a user's
 * notification channel for that user only. Guests get nothing.
 */
export function authorizeChannel(
  identity: { binding: string },
  channel: string,
): boolean {
  const access = parseBinding(identity.binding);
  if (!access) return false;
  return (
    channel === metricsChannel(access.workspace) ||
    channel === notificationsChannel(access.userId)
  );
}

/** Live actions per component; anything not listed is refused (403). */
const memberActions: Readonly<Record<string, readonly string[]>> = {
  'metrics-panel': ['$mount', '$sync', 'logDeployment', 'clearNotifications'],
  'task-board': [
    '$mount',
    '$sync',
    'sortTitle',
    'sortDue',
    'sortPriority',
    'applyFilters',
    'clearFilters',
    'newTask',
    'openEditor',
    'editorClosed',
    'saved',
    'removed',
    'changed',
  ],
  'task-row': ['$mount', 'toggleDone', 'edit'],
  'task-editor': ['$mount', '$sync', 'save', 'cancel'],
  'profile-wizard': [
    '$mount',
    '$sync',
    'next',
    'back',
    'saveDraft',
    'discardDraft',
    'finish',
  ],
};
/** Admin-only actions: the role comes from the binding, never from the browser. */
const adminActions: Readonly<Record<string, readonly string[]>> = {
  'task-row': ['remove'],
};
export function authorizeLive(
  identity: { binding: string },
  component: string,
  action: string,
): boolean {
  const access = parseBinding(identity.binding);
  if (!access) return false;
  if (adminActions[component]?.includes(action)) return access.role === 'admin';
  return memberActions[component]?.includes(action) ?? false;
}

/** `@Roles('admin')` metadata for the native Nest guard below. */
export const Roles = Reflector.createDecorator<Role[]>();

/**
 * Native Nest guard for pages and REST routes: 401 for guests, 403 when the
 * route requires a role the account does not have. Runs before the handler.
 */
@Injectable()
export class SignedInGuard implements CanActivate {
  constructor(
    @Inject(Directory) private readonly directory: Directory,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}
  canActivate(context: ExecutionContext): boolean {
    const access = this.directory.require(
      context.switchToHttp().getRequest<object>(),
    );
    const roles = this.reflector.getAllAndOverride(Roles, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (roles?.length && !roles.includes(access.role))
      throw new ForbiddenException('Your role cannot do this');
    return true;
  }
}

/**
 * One directory per process, shared by Nest providers and the option
 * factories of modules configured before the container exists (uploads,
 * realtime).
 */
export const directory = new Directory();

@Module({
  providers: [{ provide: Directory, useValue: directory }, SignedInGuard],
  exports: [Directory, SignedInGuard],
})
export class IdentityModule {}
