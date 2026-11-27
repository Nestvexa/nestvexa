import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { seal, unseal } from './action-policy.js';
import type { LiveActionCoordination } from './action-policy.js';
import type { LiveDownload } from './effects.js';

/*
 * Single-use download attachments shared by replicas through the store's
 * `LiveActionCoordination` records, so a download URL (including one inside
 * an idempotent replay served by another replica) works on every replica.
 *
 * Store keys are SHA-256 digests of the 256-bit download token; values are
 * AES-256-GCM records sealed under a key derived from the token, which the
 * store never holds, so a store reader learns neither the body nor its owner.
 * The body is split into 512 KiB chunks (each well under a store's record
 * limit) and the manifest is written last, so a reader never sees a partial
 * download. Consumption takes a one-time lease (`SET NX`) after the owner
 * check: exactly one request on any replica serves a token.
 */
const chunkBytes = 524_288;
const maxChunks = 16;

function storageKey(label: string, token: string, index = 0): string {
  return createHash('sha256')
    .update(`nestvexa-live-download-${label}\u0000${token}\u0000${index}`)
    .digest('base64url');
}
function sealingKey(token: string): Buffer {
  return createHash('sha256')
    .update(`nestvexa-live-download-key\u0000${token}`)
    .digest();
}

/** Write a download record for `ttlMs`; rejects when the store fails. */
export async function putSharedDownload(
  store: LiveActionCoordination,
  token: string,
  binding: Buffer,
  component: string,
  download: LiveDownload,
  ttlMs: number,
  now = Date.now(),
): Promise<void> {
  const body = Buffer.from(download.body);
  const chunks = Math.max(1, Math.ceil(body.length / chunkBytes));
  if (chunks > maxChunks) throw new Error('Download body is too large');
  const key = sealingKey(token);
  for (let index = 0; index < chunks; index++) {
    const name = storageKey('chunk', token, index);
    const part = body.subarray(index * chunkBytes, (index + 1) * chunkBytes);
    await store.writeReplay(
      name,
      seal(key, name, part.toString('base64url')),
      ttlMs,
    );
  }
  const manifest = storageKey('manifest', token);
  await store.writeReplay(
    manifest,
    seal(
      key,
      manifest,
      JSON.stringify({
        b: binding.toString('base64url'),
        c: component,
        f: download.filename,
        t: download.contentType,
        n: body.length,
        k: chunks,
        e: now + ttlMs,
      }),
    ),
    ttlMs,
  );
}

function manifestOf(text: string | undefined):
  | {
      binding: Buffer;
      component: string;
      filename: string;
      contentType: string;
      size: number;
      chunks: number;
      expiresAt: number;
    }
  | undefined {
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const get = (name: string): unknown => Reflect.get(value, name);
  const [b, c, f, t, n, k, e] = ['b', 'c', 'f', 't', 'n', 'k', 'e'].map(get);
  if (
    typeof b !== 'string' ||
    typeof c !== 'string' ||
    typeof f !== 'string' ||
    typeof t !== 'string' ||
    typeof n !== 'number' ||
    typeof k !== 'number' ||
    typeof e !== 'number' ||
    !Number.isSafeInteger(n) ||
    !Number.isSafeInteger(k) ||
    !Number.isSafeInteger(e) ||
    k < 1 ||
    k > maxChunks
  )
    return undefined;
  return {
    binding: Buffer.from(b, 'base64url'),
    component: c,
    filename: f,
    contentType: t,
    size: n,
    chunks: k,
    expiresAt: e,
  };
}

/**
 * Serve a shared download once: undefined when the token is unknown,
 * expired, for another component, owned by another identity, already
 * consumed on any replica, or its record is incomplete.
 */
export async function takeSharedDownload(
  store: LiveActionCoordination,
  token: string,
  binding: Buffer,
  component: string,
  now = Date.now(),
): Promise<LiveDownload | undefined> {
  const key = sealingKey(token);
  const name = storageKey('manifest', token);
  const sealed: unknown = await store.readReplay(name);
  const manifest = manifestOf(
    typeof sealed === 'string' ? unseal(key, name, sealed) : undefined,
  );
  if (
    !manifest ||
    manifest.expiresAt <= now ||
    manifest.component !== component ||
    manifest.binding.length !== binding.length ||
    !timingSafeEqual(manifest.binding, binding)
  )
    return undefined;
  // Consume before reading the body: a token is never served twice, even
  // by two replicas at once.
  const consumed = await store.acquireActionLease(
    storageKey('consumed', token),
    randomBytes(18).toString('base64url'),
    Math.max(1, manifest.expiresAt - now),
  );
  if (!consumed) return undefined;
  const parts: Buffer[] = [];
  for (let index = 0; index < manifest.chunks; index++) {
    const chunkName = storageKey('chunk', token, index);
    const chunk: unknown = await store.readReplay(chunkName);
    const text =
      typeof chunk === 'string' ? unseal(key, chunkName, chunk) : undefined;
    if (text === undefined) return undefined;
    parts.push(Buffer.from(text, 'base64url'));
  }
  const body = Buffer.concat(parts);
  if (body.length !== manifest.size) return undefined;
  return Object.freeze({
    filename: manifest.filename,
    contentType: manifest.contentType,
    body: new Uint8Array(body),
  });
}
