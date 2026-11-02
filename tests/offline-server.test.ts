import { describe, expect, it } from 'vitest';
import {
  clearSiteDataHeader,
  draftScope,
} from '../packages/offline/dist/server/index.js';

const secret = 'offline-test-secret-0123456789abcdefghij';

describe('draftScope', () => {
  it('derives a deterministic opaque scope per identity and secret', () => {
    const first = draftScope(secret, 'guest-session:alice');
    expect(first).toBe(draftScope(secret, 'guest-session:alice'));
    expect(first).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(first).not.toContain('alice');
    expect(draftScope(secret, 'guest-session:bob')).not.toBe(first);
    expect(draftScope(`${secret}-rotated`, 'guest-session:alice')).not.toBe(
      first,
    );
    expect(draftScope(Buffer.from(secret), 'guest-session:alice')).toBe(first);
  });

  it('rejects weak secrets and invalid identities', () => {
    expect(() => draftScope('short-secret', 'alice')).toThrow(/32 bytes/);
    expect(() => draftScope(Buffer.alloc(31), 'alice')).toThrow(/32 bytes/);
    expect(() => draftScope(secret, '')).toThrow(/non-empty/);
    expect(() => draftScope(secret, 'x'.repeat(1025))).toThrow(/too long/);
  });

  it('exposes a frozen Clear-Site-Data storage header for logout responses', () => {
    expect(clearSiteDataHeader).toEqual({
      name: 'Clear-Site-Data',
      value: '"storage"',
    });
    expect(Object.isFrozen(clearSiteDataHeader)).toBe(true);
  });

  it('keeps the browser entry safe to import in Node', async () => {
    const browser = await import('../packages/offline/dist/index.js');
    expect(Object.keys(browser).sort()).toEqual([
      'announceLogout',
      'attachOfflineDrafts',
      'clearAllDrafts',
      'createDraftStore',
      'createSnapshotCache',
      'listenForLogout',
      'loadRegion',
      'markCommitted',
    ]);
    expect(() => browser.createDraftStore({ scope: 'short' })).toThrow(/scope/);
  });
});
