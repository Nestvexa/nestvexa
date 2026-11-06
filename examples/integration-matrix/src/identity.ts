import { UnauthorizedException } from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Session, SessionData } from 'express-session';

/*
 * Host-owned demonstration identity shared by Live, actions, uploads and
 * realtime. Every visitor gets an anonymous guest session; the realtime page
 * offers a one-click "operator" sign-in to show channel authorization. This is
 * NOT an authentication system: there are no passwords or accounts.
 */

declare module 'express-session' {
  interface SessionData {
    csrf?: string;
    role?: 'guest' | 'operator';
    xsrf?: string;
  }
}

export interface SessionRequest {
  session: Session & Partial<SessionData>;
  sessionID: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export const port = Number(process.env['PORT'] ?? 3123);
export const origin = `http://127.0.0.1:${port}`;

/** Ensures the per-session CSRF token exists before a page mounts components. */
export function ensureCsrf(request: SessionRequest): string {
  request.session.csrf ??= randomBytes(32).toString('base64url');
  return request.session.csrf;
}

/** Stable identity binding: role and session, never taken from a request body. */
export function bindingOf(request: object): string {
  const value = request as Partial<SessionRequest>;
  if (!value.session?.csrf || !value.sessionID)
    throw new UnauthorizedException();
  return `${value.session.role ?? 'guest'}-session:${value.sessionID}`;
}

export function isOperatorBinding(binding: string): boolean {
  return binding.startsWith('operator-session:');
}

/** The identity shape accepted by Live and uploads. */
export function liveIdentity(request: object): {
  binding: string;
  csrfToken: string;
} {
  const binding = bindingOf(request);
  const csrf = (request as Partial<SessionRequest>).session?.csrf;
  if (!csrf) throw new UnauthorizedException();
  return { binding, csrfToken: csrf };
}

export function sameToken(left: unknown, right: string | undefined): boolean {
  if (typeof left !== 'string' || right === undefined) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
