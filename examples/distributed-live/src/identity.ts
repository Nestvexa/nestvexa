import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Stateless guest identity for the demonstration: a random id signed with a
 * secret every replica shares, so any replica resolves the same identity
 * without a shared session store. Production hosts use their real
 * authentication (and a shared session store if they keep server sessions).
 */
export interface Guest {
  readonly id: string;
  /** Live and realtime identity binding. */
  readonly binding: string;
  /** Deterministic per-guest CSRF token (HMAC of the id). */
  readonly csrf: string;
}
export const cookieName = 'nv_guest';

function mac(secret: string, label: string, id: string): string {
  return createHmac('sha256', secret)
    .update(`${label}:${id}`)
    .digest('base64url');
}
function guest(secret: string, id: string): Guest {
  return Object.freeze({
    id,
    binding: `guest:${id}`,
    csrf: mac(secret, 'csrf', id),
  });
}
/** Verify the signed cookie from a raw Cookie header; undefined when absent or forged. */
export function guestFromCookie(
  secret: string,
  header: string | undefined,
): Guest | undefined {
  for (const part of (header ?? '').split(';')) {
    const [name, value] = part.trim().split('=');
    if (name !== cookieName || !value) continue;
    const match = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(value);
    if (!match?.[1] || !match[2]) return undefined;
    const expected = Buffer.from(mac(secret, 'guest', match[1]));
    const given = Buffer.from(match[2]);
    return expected.length === given.length && timingSafeEqual(expected, given)
      ? guest(secret, match[1])
      : undefined;
  }
  return undefined;
}
/** Public presence id for a guest binding: an HMAC prefix, never the id itself. */
export function presenceId(secret: string, binding: string): string {
  return mac(secret, 'presence', binding.replace(/^guest:/, '')).slice(0, 10);
}
export function issueGuest(secret: string): { guest: Guest; cookie: string } {
  const id = randomBytes(16).toString('base64url');
  return {
    guest: guest(secret, id),
    cookie: `${cookieName}=${id}.${mac(secret, 'guest', id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600`,
  };
}
