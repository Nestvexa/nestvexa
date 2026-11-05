import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  RealtimeTokenError,
  createTokenSigner,
  parseChannel,
} from '../packages/realtime/src/token.js';

/**
 * Property-based checks for realtime subscription tokens: integrity under any
 * single-character tampering, identity binding, expiry, rotation, and that
 * arbitrary attacker strings only ever produce RealtimeTokenError.
 */
const runs = { numRuns: 300 };
const secret = (fill: string) => fill.repeat(32);
const signer = createTokenSigner({ secrets: [secret('a')], ttlMs: 60_000 });
const channel = fc.stringMatching(/^[a-z0-9][a-z0-9:._-]{0,40}$/);
const binding = fc.string({ unit: 'binary', minLength: 16, maxLength: 200 });
const now = 1_800_000_000_000;

function rejection(operation: () => unknown): string {
  try {
    operation();
    return 'accepted';
  } catch (error) {
    if (!(error instanceof RealtimeTokenError)) throw error;
    return error.message;
  }
}

describe('Realtime token properties', () => {
  it('round-trips sorted unique channels for the signing identity', () => {
    fc.assert(
      fc.property(
        binding,
        fc.array(channel, { minLength: 1, maxLength: 32 }),
        (identity, channels) => {
          const token = signer.sign(identity, channels, now);
          const claims = signer.verify(token, identity, now + 59_999);
          expect(claims.channels).toEqual([...new Set(channels)].sort());
          expect(claims.expiresAt).toBe(now + 60_000);
          expect(Object.isFrozen(claims)).toBe(true);
        },
      ),
      runs,
    );
  });

  it('rejects every single-character substitution, deletion or insertion', () => {
    fc.assert(
      fc.property(
        binding,
        fc.array(channel, { minLength: 1, maxLength: 4 }),
        fc.nat(),
        fc.constantFrom('substitute', 'delete', 'insert'),
        fc.string({ unit: 'binary', minLength: 1, maxLength: 1 }),
        (identity, channels, position, operation, character) => {
          const token = signer.sign(identity, channels, now);
          const index = position % token.length;
          const tampered =
            operation === 'delete'
              ? token.slice(0, index) + token.slice(index + 1)
              : operation === 'insert'
                ? token.slice(0, index) + character + token.slice(index)
                : token.slice(0, index) + character + token.slice(index + 1);
          fc.pre(tampered !== token);
          expect(rejection(() => signer.verify(tampered, identity, now))).toBe(
            'Invalid realtime token',
          );
        },
      ),
      runs,
    );
  });

  it('binds tokens to the identity and expiry', () => {
    fc.assert(
      fc.property(
        binding,
        binding,
        channel,
        fc.integer({ min: 0, max: 10_000_000 }),
        (owner, other, name, late) => {
          const token = signer.sign(owner, [name], now);
          if (other !== owner)
            expect(rejection(() => signer.verify(token, other, now))).toBe(
              'Realtime token belongs to another identity',
            );
          expect(
            rejection(() => signer.verify(token, owner, now + 60_000 + late)),
          ).toBe('Expired realtime token');
        },
      ),
      runs,
    );
  });

  it('verifies with every rotated secret but never with an unrelated one', () => {
    const previous = createTokenSigner({ secrets: [secret('b')] });
    const rotated = createTokenSigner({ secrets: [secret('c'), secret('b')] });
    const unrelated = createTokenSigner({ secrets: [secret('d')] });
    fc.assert(
      fc.property(binding, channel, (identity, name) => {
        const token = previous.sign(identity, [name], now);
        expect(rotated.verify(token, identity, now).channels).toEqual([name]);
        expect(rejection(() => unrelated.verify(token, identity, now))).toBe(
          'Invalid realtime token',
        );
      }),
      runs,
    );
  });

  it('throws only RealtimeTokenError for arbitrary attacker input', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ unit: 'binary', maxLength: 300 }),
          fc
            .tuple(fc.base64String(), fc.base64String())
            .map(([body, mac]) => `${body}.${mac}`),
          fc.anything(),
        ),
        binding,
        (token, identity) => {
          expect(
            rejection(() => signer.verify(token as string, identity, now)),
          ).not.toBe('accepted');
        },
      ),
      runs,
    );
  });

  it('accepts only the documented channel grammar', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 140 }), (value) => {
        const valid = /^[a-z0-9][a-z0-9:._-]{0,127}$/.test(value);
        if (valid) expect(parseChannel(value)).toBe(value);
        else expect(() => parseChannel(value)).toThrow(RealtimeTokenError);
      }),
      runs,
    );
  });
});
