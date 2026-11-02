import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type session from 'express-session';

declare module 'express-session' {
  interface SessionData {
    csrf?: string;
    notice?: string;
  }
}

export interface SessionRequest {
  session: session.Session & Partial<session.SessionData>;
  sessionID: string;
  body?: unknown;
}

function sessionRequest(request: unknown): Partial<SessionRequest> {
  return request && typeof request === 'object'
    ? (request as Partial<SessionRequest>)
    : {};
}

/**
 * Guest identity binding for this demonstration. A real admin product resolves
 * an authenticated user and tenant here; every repository, AI conversation,
 * flag evaluation and draft scope below is keyed by this one value.
 */
export function binding(request: unknown): string {
  const id = sessionRequest(request).sessionID;
  if (typeof id !== 'string' || !id) throw new UnauthorizedException();
  return `guest-session:${id}`;
}

/** Creates the per-session CSRF token used by Live and by the plain forms. */
export function ensureCsrf(request: SessionRequest): string {
  request.session.csrf ??= randomBytes(32).toString('base64url');
  return request.session.csrf;
}

/** The existing session token (already exposed to Live as data-nv-csrf). */
export function sessionCsrfOrEmpty(request: unknown): string {
  const token = sessionRequest(request).session?.csrf;
  return typeof token === 'string' ? token : '';
}

/** Plain HTML forms (locale switch, logout, no-JavaScript product form). */
export function assertFormCsrf(request: SessionRequest, body: unknown): void {
  const expected = request.session.csrf;
  const supplied: unknown =
    body && typeof body === 'object' ? Reflect.get(body, '_csrf') : undefined;
  if (
    typeof expected !== 'string' ||
    typeof supplied !== 'string' ||
    supplied.length !== expected.length ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
  )
    throw new ForbiddenException('Invalid form token');
}

/** Reads one string field from an urlencoded body without trusting its shape. */
export function field(body: unknown, name: string, max: number): string {
  const value: unknown =
    body && typeof body === 'object' && Object.hasOwn(body, name)
      ? Reflect.get(body, name)
      : undefined;
  return typeof value === 'string' ? value.slice(0, max) : '';
}
