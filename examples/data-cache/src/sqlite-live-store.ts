import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  LiveProtocolError,
  assertLiveComponentName,
  cloneState,
  freezeChildReferences,
  freezeJson,
  freezeStateSnapshot,
  isSnapshotToken,
  liveBindingHash,
  liveStateUnavailable,
} from '@nestvexa/live';
import type {
  ChildReference,
  JsonValue,
  LiveStateStore,
  LiveTransactionCallback,
  LiveTransactionResult,
  StateSnapshot,
} from '@nestvexa/live';

/**
 * Example custom `LiveStateStore` on SQLite (`node:sqlite`, no dependency).
 * It shows how to implement the store contract on any database with atomic
 * conditional updates; the same statements work on PostgreSQL or MySQL.
 *
 * - Keys are SHA-256 hashes of the snapshot token and identity binding.
 * - The lease (`lease_owner`, `lease_until`) is taken by one conditional
 *   `UPDATE ... WHERE revision = ? AND lease_owner IS NULL`: of N concurrent
 *   transactions exactly one changes the row; the others see `COMPONENT_BUSY`.
 * - The commit is compare-and-set on revision, lease owner and lease expiry.
 * - A lease that lapsed without a commit marks an attempt whose callback may
 *   have run: the entry is invalidated, never retried (at most once).
 * - Several store instances (or processes) on one database file share state.
 *
 * Not a production store: state is stored as plain JSON (no encryption at
 * rest), pruning runs on create, and `node:sqlite` is experimental in Node.
 * Prove a store like this with `liveStoreContract` from `@nestvexa/live/testing`.
 */
export interface SqliteLiveStoreOptions {
  /** Database file shared by every instance; `:memory:` for one instance. */
  readonly path: string;
  readonly ttlMs?: number;
  readonly lockTtlMs?: number;
  readonly maxEntriesPerBinding?: number;
  readonly now?: () => number;
}

interface Row {
  readonly binding_hash: string;
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly state: string;
  readonly children: string | null;
  readonly expires_at: number;
  readonly lease_owner: string | null;
  readonly lease_until: number | null;
}

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
function bounded(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new LiveProtocolError(
      'INVALID_STORE_OPTIONS',
      500,
      'Invalid SQLite Live store options',
    );
  return value;
}
/** Stored rows are re-validated like any other untrusted data. */
function row(value: unknown): Row | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const get = (name: string): unknown => Reflect.get(value, name);
  const binding = get('binding_hash');
  const id = get('id');
  const name = get('name');
  const revision = get('revision');
  const state = get('state');
  const children = get('children');
  const expires = get('expires_at');
  const owner = get('lease_owner');
  const until = get('lease_until');
  if (
    typeof binding !== 'string' ||
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof revision !== 'number' ||
    typeof state !== 'string' ||
    (children !== null && typeof children !== 'string') ||
    typeof expires !== 'number' ||
    (owner !== null && typeof owner !== 'string') ||
    (until !== null && typeof until !== 'number')
  )
    liveStateUnavailable();
  return {
    binding_hash: binding,
    id,
    name,
    revision,
    state,
    children,
    expires_at: expires,
    lease_owner: owner,
    lease_until: until,
  };
}
/** Stored child references are re-validated before use. */
function references(
  text: string | null,
): Readonly<Record<string, ChildReference>> | undefined {
  if (text === null) return undefined;
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    liveStateUnavailable();
  const copy = Object.create(null) as Record<string, ChildReference>;
  for (const [key, child] of Object.entries(value)) {
    if (!child || typeof child !== 'object') liveStateUnavailable();
    const alias: unknown = Reflect.get(child, 'alias');
    const name: unknown = Reflect.get(child, 'name');
    const id: unknown = Reflect.get(child, 'id');
    const token: unknown = Reflect.get(child, 'token');
    if (
      ['__proto__', 'prototype', 'constructor'].includes(key) ||
      typeof alias !== 'string' ||
      typeof name !== 'string' ||
      typeof id !== 'string' ||
      typeof token !== 'string' ||
      !isSnapshotToken(token)
    )
      liveStateUnavailable();
    copy[key] = { alias, name, id, token };
  }
  return freezeChildReferences(copy);
}

export class SqliteLiveStore implements LiveStateStore {
  readonly #db: DatabaseSync;
  readonly #ttlMs: number;
  readonly #lockTtlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;
  #closed = false;
  get ttlMs(): number {
    return this.#ttlMs;
  }
  constructor(options: SqliteLiveStoreOptions) {
    this.#ttlMs = bounded(options.ttlMs ?? 900_000, 1, 86_400_000);
    this.#lockTtlMs = bounded(options.lockTtlMs ?? 30_000, 100, 300_000);
    this.#maxEntries = bounded(
      options.maxEntriesPerBinding ?? 1000,
      1,
      100_000,
    );
    this.#now = options.now ?? Date.now;
    // `timeout` waits for another connection's write lock instead of failing.
    this.#db = new DatabaseSync(options.path, { timeout: 5000 });
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS nv_live_entries (
        token_hash   TEXT PRIMARY KEY,
        binding_hash TEXT NOT NULL,
        id           TEXT NOT NULL,
        name         TEXT NOT NULL,
        revision     INTEGER NOT NULL,
        state        TEXT NOT NULL,
        children     TEXT,
        expires_at   INTEGER NOT NULL,
        lease_owner  TEXT,
        lease_until  INTEGER
      );
      CREATE INDEX IF NOT EXISTS nv_live_entries_binding
        ON nv_live_entries (binding_hash);
    `);
  }
  #row(tokenHash: string): Row | undefined {
    return row(
      this.#db
        .prepare(
          'SELECT binding_hash, id, name, revision, state, children, expires_at, lease_owner, lease_until FROM nv_live_entries WHERE token_hash = ?',
        )
        .get(tokenHash),
    );
  }
  /** Read and verify one entry: binding, expiry and stored JSON. */
  #entry(token: string, binding: string): StateSnapshot {
    if (!isSnapshotToken(token)) liveStateUnavailable();
    const expected = liveBindingHash(binding);
    const found = this.#row(hash(token));
    if (!found) liveStateUnavailable();
    const stored = Buffer.from(found.binding_hash, 'hex');
    if (stored.length !== expected.length || !timingSafeEqual(stored, expected))
      liveStateUnavailable();
    if (found.expires_at <= this.#now()) liveStateUnavailable();
    try {
      const children = references(found.children);
      return freezeStateSnapshot({
        id: found.id,
        name: assertLiveComponentName(found.name),
        revision: found.revision,
        state: freezeJson(cloneState(JSON.parse(found.state))),
        snapshot: token,
        expiresAt: found.expires_at,
        ...(children === undefined ? {} : { children }),
      });
    } catch {
      liveStateUnavailable();
    }
  }
  create(
    component: string,
    binding: string,
    state: Record<string, JsonValue>,
    children?: Readonly<Record<string, ChildReference>>,
  ): StateSnapshot {
    assertLiveComponentName(component);
    const bindingHash = liveBindingHash(binding).toString('hex');
    const validated = freezeJson(cloneState(state));
    const now = this.#now();
    this.#db
      .prepare('DELETE FROM nv_live_entries WHERE expires_at <= ?')
      .run(now);
    const held = this.#db
      .prepare(
        'SELECT COUNT(*) AS total FROM nv_live_entries WHERE binding_hash = ?',
      )
      .get(bindingHash);
    if (Number(held?.['total'] ?? 0) >= this.#maxEntries)
      throw new LiveProtocolError(
        'STORE_CAPACITY',
        503,
        'Live state capacity reached',
      );
    const token = randomBytes(32).toString('base64url');
    const frozen = freezeChildReferences(children);
    const snapshot: StateSnapshot = {
      id: randomUUID(),
      name: component,
      revision: 0,
      state: validated,
      snapshot: token,
      expiresAt: now + this.#ttlMs,
      ...(frozen === undefined ? {} : { children: frozen }),
    };
    this.#db
      .prepare(
        'INSERT INTO nv_live_entries (token_hash, binding_hash, id, name, revision, state, children, expires_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)',
      )
      .run(
        hash(token),
        bindingHash,
        snapshot.id,
        component,
        JSON.stringify(validated),
        frozen === undefined ? null : JSON.stringify(frozen),
        snapshot.expiresAt,
      );
    return freezeStateSnapshot(snapshot);
  }
  peek(token: string, binding: string): StateSnapshot {
    return this.#entry(token, binding);
  }
  async transaction(
    token: string,
    binding: string,
    revision: number,
    callback: LiveTransactionCallback,
  ): Promise<LiveTransactionResult> {
    const snapshot = this.#entry(token, binding);
    if (
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      revision !== snapshot.revision ||
      revision === Number.MAX_SAFE_INTEGER
    )
      throw new LiveProtocolError(
        'STALE_REVISION',
        409,
        'Live state revision conflict',
      );
    const tokenHash = hash(token);
    const owner = randomBytes(18).toString('base64url');
    const now = this.#now();
    // One atomic conditional update takes the lease for this revision.
    const leased = this.#db
      .prepare(
        'UPDATE nv_live_entries SET lease_owner = ?, lease_until = ? WHERE token_hash = ? AND revision = ? AND lease_owner IS NULL AND expires_at > ?',
      )
      .run(owner, now + this.#lockTtlMs, tokenHash, revision, now);
    if (Number(leased.changes) !== 1) {
      const current = this.#row(tokenHash);
      if (!current) liveStateUnavailable();
      if (current.lease_owner !== null) {
        if ((current.lease_until ?? 0) > now)
          throw new LiveProtocolError(
            'COMPONENT_BUSY',
            409,
            'Live component has an action in progress',
          );
        // A lease that lapsed without a commit: its callback may have run.
        this.delete(token);
        liveStateUnavailable();
      }
      throw new LiveProtocolError(
        'STALE_REVISION',
        409,
        'Live state revision conflict',
      );
    }
    try {
      const result = await callback(snapshot);
      const state = freezeJson(cloneState(result.state));
      if (
        typeof result.html !== 'string' ||
        Buffer.byteLength(result.html) > 1_048_576
      )
        throw new LiveProtocolError(
          'PAYLOAD_TOO_LARGE',
          413,
          'Live rendered response exceeds limits',
        );
      const nextChildren =
        result.children === undefined
          ? snapshot.children
          : freezeChildReferences(result.children);
      const at = this.#now();
      // Compare-and-set: same revision, our unexpired lease, live entry.
      // Revocation or deletion removed the row, so nothing is resurrected.
      const committed = this.#db
        .prepare(
          'UPDATE nv_live_entries SET revision = revision + 1, state = ?, children = ?, lease_owner = NULL, lease_until = NULL WHERE token_hash = ? AND revision = ? AND lease_owner = ? AND lease_until > ? AND expires_at > ?',
        )
        .run(
          JSON.stringify(state),
          nextChildren === undefined ? null : JSON.stringify(nextChildren),
          tokenHash,
          revision,
          owner,
          at,
          at,
        );
      if (Number(committed.changes) !== 1) liveStateUnavailable();
      return Object.freeze({
        ...freezeStateSnapshot({
          ...snapshot,
          revision: revision + 1,
          state,
          ...(nextChildren === undefined ? {} : { children: nextChildren }),
        }),
        html: result.html,
      });
    } catch (error) {
      // The callback may have caused an external effect: invalidate.
      this.delete(token);
      throw error;
    }
  }
  revoke(binding: string): void {
    this.#db
      .prepare('DELETE FROM nv_live_entries WHERE binding_hash = ?')
      .run(liveBindingHash(binding).toString('hex'));
  }
  delete(token: string): boolean {
    if (!isSnapshotToken(token)) return false;
    const removed = this.#db
      .prepare('DELETE FROM nv_live_entries WHERE token_hash = ?')
      .run(hash(token));
    return Number(removed.changes) === 1;
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}
