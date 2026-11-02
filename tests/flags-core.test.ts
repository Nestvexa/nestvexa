import { describe, expect, it } from 'vitest';
import {
  FlagService,
  StaticFlagProvider,
  flagFingerprint,
  flagHelpers,
  liveFlagPolicy,
  rolloutBucket,
} from '../packages/flags/dist/index.js';
import type { FlagProvider } from '../packages/flags/dist/index.js';

const known = ['ai-assistant', 'bulk-export', 'beta.reports', 'rollout'];
function service(provider: FlagProvider, onError?: (error: unknown) => void) {
  return new FlagService({
    provider,
    flags: known,
    ...(onError ? { onError } : {}),
    timeoutMs: 50,
  });
}
const rules = new StaticFlagProvider({
  'ai-assistant': true,
  'bulk-export': false,
  'beta.reports': { allow: ['alice'], deny: ['mallory'] },
  rollout: { percentage: 50, deny: ['bob'] },
});

describe('StaticFlagProvider and FlagService', () => {
  it('evaluates boolean, allow/deny and percentage rules', async () => {
    const flags = service(rules);
    expect(await flags.isEnabled('ai-assistant', {})).toBe(true);
    expect(await flags.isEnabled('bulk-export', { identity: 'alice' })).toBe(
      false,
    );
    expect(await flags.isEnabled('beta.reports', { identity: 'alice' })).toBe(
      true,
    );
    expect(await flags.isEnabled('beta.reports', { identity: 'carol' })).toBe(
      false,
    );
    expect(await flags.isEnabled('beta.reports', {})).toBe(false);
    expect(await flags.isEnabled('rollout', {})).toBe(false);
    expect(await flags.isEnabled('rollout', { identity: 'bob' })).toBe(false);
  });

  it('assigns deterministic, roughly proportional rollout buckets', async () => {
    const flags = service(rules);
    const identities = Array.from(
      { length: 400 },
      (_, index) => `user-${index}`,
    );
    const first = await Promise.all(
      identities.map((identity) => flags.isEnabled('rollout', { identity })),
    );
    const second = await Promise.all(
      identities.map((identity) => flags.isEnabled('rollout', { identity })),
    );
    expect(first).toEqual(second);
    const enabled = first.filter(Boolean).length;
    expect(enabled).toBeGreaterThan(140);
    expect(enabled).toBeLessThan(260);
    expect(rolloutBucket('rollout', 'user-1')).toBe(
      rolloutBucket('rollout', 'user-1'),
    );
    expect(rolloutBucket('rollout', 'user-1')).toBeGreaterThanOrEqual(0);
    expect(rolloutBucket('rollout', 'user-1')).toBeLessThan(100);
  });

  it('throws for unknown flag names instead of silently enabling typos', async () => {
    const flags = service(rules);
    await expect(flags.isEnabled('ai-asistant', {})).rejects.toThrow(
      'Unknown feature flag',
    );
    await expect(flags.evaluate({}, ['nope'])).rejects.toThrow();
    expect(
      () => new FlagService({ provider: rules, flags: ['Bad Name'] }),
    ).toThrow();
    expect(
      () => new FlagService({ provider: rules, flags: ['a', 'a'] }),
    ).toThrow();
  });

  it('fails closed on provider errors, timeouts and non-boolean values', async () => {
    const errors: unknown[] = [];
    const throwing = service(
      {
        evaluate() {
          throw new Error('provider down');
        },
      },
      (error) => errors.push(error),
    );
    expect(await throwing.isEnabled('ai-assistant', {})).toBe(false);
    const slow = service({
      evaluate: () => new Promise<boolean>(() => undefined),
    });
    expect(await slow.isEnabled('ai-assistant', {})).toBe(false);
    const sloppy = service({
      evaluate: () => 'yes' as unknown as boolean,
    });
    expect(await sloppy.isEnabled('ai-assistant', {})).toBe(false);
    const truthy = service({ evaluate: () => 1 as unknown as boolean });
    expect(await truthy.isEnabled('ai-assistant', {})).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it('evaluates a frozen null-prototype snapshot and asserts with 403', async () => {
    const flags = service(rules);
    const values = await flags.evaluate({ identity: 'alice' });
    expect(Object.getPrototypeOf(values)).toBeNull();
    expect(Object.isFrozen(values)).toBe(true);
    expect({ ...values }).toMatchObject({
      'ai-assistant': true,
      'bulk-export': false,
      'beta.reports': true,
    });
    await expect(flags.assert('bulk-export', {})).rejects.toMatchObject({
      status: 403,
    });
    await expect(flags.assert('ai-assistant', {})).resolves.toBeUndefined();
  });

  it.each([
    [JSON.parse('{"__proto__": true}')],
    [{ constructor: true }],
    [{ 'Bad Flag': true }],
    [{ ok: { percentage: 101 } }],
    [{ ok: { enabled: 'yes' } }],
    [{ ok: { allow: 'alice' } }],
    [{ ok: { unknown: true } }],
    [
      Object.defineProperty({}, 'ok', {
        enumerable: true,
        get: () => true,
      }),
    ],
  ])('rejects unsafe rule tables %#', (table) => {
    expect(() => new StaticFlagProvider(table)).toThrow();
    expect(Object.prototype).not.toHaveProperty('ok');
  });

  it('rejects contexts with prototype or accessor tricks', async () => {
    const flags = service(rules);
    await expect(
      flags.isEnabled('ai-assistant', {
        attributes: JSON.parse('{"__proto__": "x"}'),
      }),
    ).rejects.toThrow();
    await expect(
      flags.isEnabled(
        'ai-assistant',
        Object.defineProperty({}, 'identity', { get: () => 'alice' }),
      ),
    ).rejects.toThrow();
  });
});

describe('flagFingerprint', () => {
  it('is stable and independent of key order', () => {
    const a = flagFingerprint({ x: true, y: false });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(flagFingerprint({ y: false, x: true })).toBe(a);
    expect(flagFingerprint({ x: true, y: true })).not.toBe(a);
  });
});

describe('flag HBS helper', () => {
  const { flag } = flagHelpers();
  const options = (root: unknown) => ({ data: { root }, hash: {} });
  it('reads only an own boolean true from the root flags object', () => {
    expect(flag?.('beta', options({ flags: { beta: true } }))).toBe(true);
    expect(flag?.('beta', options({ flags: { beta: 'true' } }))).toBe(false);
    expect(flag?.('beta', options({ flags: { beta: 1 } }))).toBe(false);
    expect(flag?.('missing', options({ flags: { beta: true } }))).toBe(false);
    expect(flag?.('beta', options({}))).toBe(false);
    expect(
      flag?.('beta', options({ flags: Object.create({ beta: true }) })),
    ).toBe(false);
    expect(flag?.('constructor', options({ flags: {} }))).toBe(false);
    expect(flag?.('__proto__', options({ flags: {} }))).toBe(false);
    expect(flag?.(options({ flags: { beta: true } }))).toBe(false);
  });
});

describe('liveFlagPolicy', () => {
  const identity = { binding: 'alice', csrfToken: 'x'.repeat(32) };
  const flags = service(rules);
  it('denies when the flag is off even if the host policy allows', async () => {
    let delegated = 0;
    const policy = liveFlagPolicy(
      flags,
      {
        'export-panel': 'bulk-export',
        'assistant-panel.approve': 'beta.reports',
      },
      () => {
        delegated += 1;
        return true;
      },
    );
    expect(await policy(identity, 'export-panel', '$mount')).toBe(false);
    expect(delegated).toBe(0);
    expect(await policy(identity, 'assistant-panel', '$mount')).toBe(true);
    expect(await policy(identity, 'assistant-panel', 'approve')).toBe(true);
    expect(
      await policy(
        { binding: 'carol', csrfToken: identity.csrfToken },
        'assistant-panel',
        'approve',
      ),
    ).toBe(false);
    expect(await policy(identity, 'other', '$mount')).toBe(true);
  });
  it('still applies the host policy when flags are on', async () => {
    const policy = liveFlagPolicy(
      flags,
      { 'assistant-panel': 'ai-assistant' },
      () => false,
    );
    expect(await policy(identity, 'assistant-panel', '$mount')).toBe(false);
  });
  it('validates requirement keys and flags at construction', () => {
    expect(() =>
      liveFlagPolicy(flags, { 'x.y': 'nope' }, () => true),
    ).toThrow();
    expect(() =>
      liveFlagPolicy(flags, { '../x': 'ai-assistant' }, () => true),
    ).toThrow();
    expect(() =>
      liveFlagPolicy(flags, { 'x.a b': 'ai-assistant' }, () => true),
    ).toThrow();
  });
});
