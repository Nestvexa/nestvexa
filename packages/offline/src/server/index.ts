import { createHmac } from 'node:crypto';

/**
 * Opaque, non-reversible draft namespace for one identity. Render it into the
 * page (for example `<meta name="nv-draft-scope" content="…">`) and pass it to
 * `createDraftStore({ scope })`. Rotating the secret orphans existing drafts,
 * which then expire or are purged on the next attach.
 */
export function draftScope(secret: string | Buffer, identity: string): string {
  const key = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : secret;
  if (!Buffer.isBuffer(key) || key.byteLength < 32)
    throw new TypeError('Draft scope secret must be at least 32 bytes');
  if (typeof identity !== 'string' || identity.length === 0)
    throw new TypeError('Draft scope identity must be a non-empty string');
  if (identity.length > 1024)
    throw new TypeError('Draft scope identity is too long');
  return createHmac('sha256', key)
    .update(`nestvexa-draft-scope:v1:${identity}`, 'utf8')
    .digest('base64url')
    .slice(0, 32);
}

/**
 * Defense in depth for logout responses. Browser support varies (WebKit has
 * partial support), so the explicit client `announceLogout()` call remains the
 * primary clearing mechanism.
 */
export const clearSiteDataHeader: {
  readonly name: 'Clear-Site-Data';
  readonly value: '"storage"';
} = Object.freeze({ name: 'Clear-Site-Data', value: '"storage"' });

export {
  MemoryOfflineReplayStore,
  createOfflineReplayGuard,
  offlineActionAllowlist,
  offlineKeyHeader,
  offlineReplayedHeader,
  offlineScopeHeader,
  offlineServerAction,
} from './queue.js';
export type {
  OfflineAction,
  OfflineActionAllowlist,
  OfflineActionDefinition,
  OfflineActionEncoding,
  OfflineActionMethod,
  OfflineReplayBegin,
  OfflineReplayError,
  OfflineReplayErrorCode,
  OfflineReplayGuard,
  OfflineReplayGuardOptions,
  OfflineReplayOutcome,
  OfflineReplayRejection,
  OfflineReplayRequest,
  OfflineReplayResult,
  OfflineReplayStore,
  ServerActionDescriptor,
} from './queue.js';
