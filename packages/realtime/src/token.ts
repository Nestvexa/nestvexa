import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Channel names are opaque, server-chosen identifiers such as `orders:tenant-a`. */
const channelPattern = /^[a-z0-9][a-z0-9:._-]{0,127}$/;
export function parseChannel(value: unknown): string {
  if (typeof value !== 'string' || !channelPattern.test(value))
    throw new RealtimeTokenError('Invalid realtime channel');
  return value;
}
export class RealtimeTokenError extends Error {
  override readonly name = 'RealtimeTokenError';
}
export interface SubscriptionClaims {
  /** SHA-256 of the identity binding; the binding itself never leaves the server. */
  readonly identity: string;
  readonly channels: readonly string[];
  /** Expiry, milliseconds since the epoch. */
  readonly expiresAt: number;
}
export interface TokenSigner {
  sign(binding: string, channels: readonly string[], now?: number): string;
  verify(token: string, binding: string, now?: number): SubscriptionClaims;
}
export function bindingHash(binding: string): string {
  if (
    typeof binding !== 'string' ||
    binding.length < 16 ||
    binding.length > 1024
  )
    throw new RealtimeTokenError('Realtime identity binding is required');
  return createHash('sha256').update(binding).digest('base64url');
}

/**
 * HMAC-SHA256 subscription tokens. The first secret signs; every secret verifies,
 * so keys can rotate without dropping connected clients. Tokens are integrity
 * protected, not encrypted: channel names are visible to the browser.
 */
export function createTokenSigner(options: {
  readonly secrets: readonly string[];
  readonly ttlMs?: number;
}): TokenSigner {
  const secrets = [...options.secrets];
  if (
    !secrets.length ||
    secrets.length > 8 ||
    secrets.some(
      (secret) => typeof secret !== 'string' || Buffer.byteLength(secret) < 32,
    )
  )
    throw new Error('Realtime requires 1–8 secrets of at least 32 bytes');
  const ttl = options.ttlMs ?? 900_000;
  if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 86_400_000)
    throw new Error('Realtime token ttlMs must be 1 second to 24 hours');
  const mac = (secret: string, body: string) =>
    createHmac('sha256', secret).update(body).digest();
  return Object.freeze({
    sign(
      binding: string,
      channels: readonly string[],
      now = Date.now(),
    ): string {
      const unique = [...new Set(channels.map(parseChannel))].sort();
      if (!unique.length || unique.length > 32)
        throw new RealtimeTokenError('A token covers 1–32 channels');
      const body = Buffer.from(
        JSON.stringify({ i: bindingHash(binding), c: unique, e: now + ttl }),
      ).toString('base64url');
      const first = secrets[0];
      if (first === undefined) throw new Error('Missing realtime secret');
      return `${body}.${mac(first, body).toString('base64url')}`;
    },
    verify(
      token: string,
      binding: string,
      now = Date.now(),
    ): SubscriptionClaims {
      if (typeof token !== 'string' || token.length > 8192)
        throw new RealtimeTokenError('Invalid realtime token');
      const [body, signature, extra] = token.split('.');
      if (!body || !signature || extra !== undefined)
        throw new RealtimeTokenError('Invalid realtime token');
      const presented = Buffer.from(signature, 'base64url');
      // Only the canonical encoding is accepted: the final base64url character
      // carries unused bits, so alternate spellings of one MAC must not verify.
      if (presented.toString('base64url') !== signature)
        throw new RealtimeTokenError('Invalid realtime token');
      const valid = secrets.some((secret) => {
        const expected = mac(secret, body);
        return (
          expected.length === presented.length &&
          timingSafeEqual(expected, presented)
        );
      });
      if (!valid) throw new RealtimeTokenError('Invalid realtime token');
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      } catch {
        throw new RealtimeTokenError('Invalid realtime token');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new RealtimeTokenError('Invalid realtime token');
      const identity: unknown = Reflect.get(parsed, 'i');
      const channels: unknown = Reflect.get(parsed, 'c');
      const expiresAt: unknown = Reflect.get(parsed, 'e');
      if (
        typeof identity !== 'string' ||
        !Array.isArray(channels) ||
        typeof expiresAt !== 'number' ||
        !Number.isSafeInteger(expiresAt)
      )
        throw new RealtimeTokenError('Invalid realtime token');
      if (expiresAt <= now)
        throw new RealtimeTokenError('Expired realtime token');
      const expected = Buffer.from(bindingHash(binding));
      const actual = Buffer.from(identity);
      if (
        expected.length !== actual.length ||
        !timingSafeEqual(expected, actual)
      )
        throw new RealtimeTokenError(
          'Realtime token belongs to another identity',
        );
      return Object.freeze({
        identity,
        channels: Object.freeze(channels.map(parseChannel)),
        expiresAt,
      });
    },
  });
}
