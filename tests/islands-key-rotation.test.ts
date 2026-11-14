/**
 * Islands signing-key rotation and invalid keys (QA-073). A rolling deploy
 * moves through three key sets on replicas that each build their own
 * registry, as separate processes would:
 *
 *   1. `[old]`        every replica signs and verifies with the old key;
 *   2. `[new, old]`   new pages are signed with the new key, pages rendered
 *                     before the deploy still verify;
 *   3. `[new]`        the old key is retired: its tokens are refused.
 *
 * A token signed with a key no replica holds, or tampered in transit, is
 * refused with `IslandError` (the host maps it to a validation error), never
 * accepted and never a crash. Live snapshots are opaque random references
 * held by the state store, not signed tokens, so they have no key to rotate;
 * realtime token rotation is covered by tests/property-realtime-token.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { IslandError, IslandRegistry } from '../packages/islands/dist/index.js';
// Fails the test on any server-side unhandled promise rejection (QA-073).
import './support/no-unhandled-rejections.js';

const oldKey = 'old-island-signing-key-0123456789abcdef';
const newKey = 'new-island-signing-key-0123456789abcdef';
const foreignKey = 'foreign-signing-key-not-in-any-replica-01';
const island = [
  {
    id: 'order-summary',
    framework: 'react' as const,
    signed: true,
    props: {
      type: 'object' as const,
      properties: { orderId: { type: 'integer' as const, minimum: 1 } },
      required: ['orderId'],
    },
  },
];
let now = Date.UTC(2026, 10, 14, 12, 0, 0);
const replica = (keys: readonly (string | Uint8Array)[]) =>
  new IslandRegistry(island, {
    signingKeys: keys,
    signatureTtlMs: 600_000,
    now: () => now,
  });
/** What the browser sends back: the props JSON and token from the markup. */
function rendered(registry: IslandRegistry, orderId: number) {
  const html = registry.render('order-summary', { orderId }).value;
  const token = /data-nv-props-token="([^"]+)"/.exec(html)?.[1] ?? '';
  expect(token).toMatch(/^v1\.\d+\.\d+\.[A-Za-z0-9_-]{43}$/);
  return { json: JSON.stringify({ orderId }), token };
}
/** Host verification, mapped the way the examples map it (422, no detail). */
function verify(
  registry: IslandRegistry,
  page: { json: string; token: string },
): { status: number; props?: Record<string, unknown> } {
  try {
    return {
      status: 200,
      props: registry.verifyProps('order-summary', page.json, page.token),
    };
  } catch (error) {
    if (error instanceof IslandError) return { status: 422 };
    throw error;
  }
}

describe('islands signing-key rotation across a rolling deploy', () => {
  it('keeps pages working through the overlap and refuses retired keys after it', () => {
    const before = replica([oldKey]);
    const pageBefore = rendered(before, 1);
    expect(verify(before, pageBefore)).toEqual({
      status: 200,
      props: { orderId: 1 },
    });

    // Phase 2: replicas already on the new key set and replicas still on the
    // old one serve the same users at the same time.
    const rotating = replica([newKey, oldKey]);
    const lagging = replica([oldKey, newKey]);
    expect(verify(rotating, pageBefore).status).toBe(200);
    const pageDuring = rendered(rotating, 2);
    // New tokens use the new key: a replica that knows only the old key
    // refuses them, which is why both keys must be deployed before signing.
    expect(verify(before, pageDuring).status).toBe(422);
    expect(verify(lagging, pageDuring).status).toBe(200);
    expect(verify(rotating, pageDuring).status).toBe(200);

    // Phase 3: the old key is retired.
    now += 60_000;
    const after = replica([newKey]);
    expect(verify(after, pageDuring)).toEqual({
      status: 200,
      props: { orderId: 2 },
    });
    expect(verify(after, pageBefore).status).toBe(422);
    expect(verify(after, rendered(after, 3)).status).toBe(200);
  });

  it('refuses tokens from a key no replica holds, tampering and replay into another island', () => {
    const foreign = rendered(replica([foreignKey]), 4);
    const current = replica([newKey, oldKey]);
    expect(verify(current, foreign).status).toBe(422);
    const page = rendered(current, 5);
    // Props changed after signing.
    expect(
      verify(current, { json: '{"orderId":6}', token: page.token }).status,
    ).toBe(422);
    // Expiry moved forward without re-signing.
    const [, iat = '', exp = '', mac = ''] = page.token.split('.');
    expect(
      verify(current, {
        json: page.json,
        token: `v1.${iat}.${Number(exp) + 3600}.${mac}`,
      }).status,
    ).toBe(422);
    // Truncated, empty and non-string tokens.
    for (const token of [
      '',
      'v1',
      page.token.slice(0, -1),
      'v2' + page.token.slice(2),
    ])
      expect(verify(current, { json: page.json, token }).status).toBe(422);
    expect(() =>
      current.verifyProps('order-summary', page.json, 42 as unknown as string),
    ).toThrow(IslandError);
  });

  it('a token signed before rotation still expires on schedule', () => {
    const before = replica([oldKey]);
    const page = rendered(before, 7);
    now += 600_000;
    expect(verify(replica([newKey, oldKey]), page).status).toBe(422);
  });

  it('refuses weak or missing keys at boot instead of signing with them', () => {
    expect(() => replica(['short-key'])).toThrow(/at least 32 bytes/);
    expect(() => replica([newKey, 'x'.repeat(31)])).toThrow(/32 bytes/);
    expect(() => replica([])).toThrow(/no signingKeys/);
    expect(() => replica([new Uint8Array(32)])).not.toThrow();
  });
});
