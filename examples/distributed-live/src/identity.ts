import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Stateless guest identity for the demonstration: a random id and a tenant,
 * signed with a secret every replica shares, so any replica resolves the same
 * identity without a shared session store. Production hosts use their real
 * authentication (and a shared session store if they keep server sessions).
 */
export interface Guest {
  readonly id: string;
  /** The tenant the guest belongs to, fixed when the cookie is issued. */
  readonly tenant: string;
  /** Live and realtime identity binding (scoped to the tenant). */
  readonly binding: string;
  /** Deterministic per-guest CSRF token (HMAC of the id). */
  readonly csrf: string;
}
export const cookieName = 'nv_guest';
/** Tenant names: lowercase letters, 1-16 characters. */
export const tenantPattern = /^[a-z]{1,16}$/;

function mac(secret: string, label: string, id: string): string {
  return createHmac('sha256', secret)
    .update(`${label}:${id}`)
    .digest('base64url');
}
function guest(secret: string, id: string, tenant: string): Guest {
  return Object.freeze({
    id,
    tenant,
    binding: `guest:${tenant}:${id}`,
    csrf: mac(secret, 'csrf', id),
  });
}
/** The tenant of a guest binding, or undefined for anything else. */
export function tenantOf(binding: string): string | undefined {
  return /^guest:([a-z]{1,16}):[A-Za-z0-9_-]{22}$/.exec(binding)?.[1];
}
/** Verify the signed cookie from a raw Cookie header; undefined when absent or forged. */
export function guestFromCookie(
  secret: string,
  header: string | undefined,
): Guest | undefined {
  for (const part of (header ?? '').split(';')) {
    const [name, value] = part.trim().split('=');
    if (name !== cookieName || !value) continue;
    const match =
      /^([A-Za-z0-9_-]{22})\.([a-z]{1,16})\.([A-Za-z0-9_-]{43})$/.exec(value);
    if (!match?.[1] || !match[2] || !match[3]) return undefined;
    // The tenant is signed with the id: a guest cannot move to another tenant.
    const expected = Buffer.from(
      mac(secret, 'guest', `${match[1]}:${match[2]}`),
    );
    const given = Buffer.from(match[3]);
    return expected.length === given.length && timingSafeEqual(expected, given)
      ? guest(secret, match[1], match[2])
      : undefined;
  }
  return undefined;
}
/** Public presence id for a guest binding: an HMAC prefix, never the id itself. */
export function presenceId(secret: string, binding: string): string {
  return mac(secret, 'presence', binding.replace(/^guest:/, '')).slice(0, 10);
}
export function issueGuest(
  secret: string,
  tenant = 'public',
): { guest: Guest; cookie: string } {
  if (!tenantPattern.test(tenant)) throw new Error('Invalid tenant');
  const id = randomBytes(16).toString('base64url');
  return {
    guest: guest(secret, id, tenant),
    cookie: `${cookieName}=${id}.${tenant}.${mac(secret, 'guest', `${id}:${tenant}`)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600`,
  };
}
