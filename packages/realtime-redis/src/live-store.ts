import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  assertLiveComponentName,
  cloneState,
  freezeChildReferences,
  freezeJson,
  freezeStateSnapshot,
  isSnapshotToken,
  liveBindingHash,
  liveStateUnavailable,
  LiveProtocolError,
} from '@nestvexa/live';
import type {
  ChildReference,
  JsonValue,
  LiveActionCoordination,
  LiveStateStore,
  LiveTransactionCallback,
  LiveTransactionResult,
  StateSnapshot,
} from '@nestvexa/live';
import { expectReply, RespConnection } from './resp.js';
import type { RespConnectionOptions, RespError, RespReply } from './resp.js';

/**
 * Tenant and user an identity binding belongs to, resolved by the host (the
 * host composed the binding, so it knows both). Never derived from a request.
 */
export interface RedisLiveNamespace {
  /** Tenant id: 1–64 letters, digits, `.`, `_` or `-`; appears in key names. */
  readonly tenant: string;
  /** Optional user id (any string up to 1024 bytes); only its SHA-256 is stored. */
  readonly user?: string;
}
export interface RedisLiveStoreOptions extends RespConnectionOptions {
  /** Key prefix isolating one application/environment on a shared server. */
  readonly prefix?: string;
  /**
   * Tenant/user namespacing. When set, every entry, lease and index lives
   * under `<prefix>t:<tenant>:` (one key space per tenant, usable with Redis
   * ACL key patterns and `SCAN MATCH`), each read checks the stored tenant,
   * and `revokeTenant` / `revokeUser` become available. Changing this option
   * makes existing entries unreadable (browsers reload).
   */
  readonly namespace?: (binding: string) => RedisLiveNamespace;
  /** Entry lifetime from creation (default 15 minutes, like MemoryLiveStore). */
  readonly ttlMs?: number;
  /**
   * Transaction lease (default 30 s). An action still running when its lease
   * expires cannot commit: the entry is invalidated and the browser reloads.
   */
  readonly lockTtlMs?: number;
  /** Live entries one identity binding may hold (default 1000). */
  readonly maxEntriesPerBinding?: number;
  /** Concurrent transactions this process runs (default 1000). */
  readonly maxInFlight?: number;
  /**
   * Optional AES-256-GCM keys (32 bytes each) for state at rest. The first
   * encrypts; all decrypt (rotation). With keys configured, plaintext records
   * are rejected. Public Live state is not secret by design, so enable this
   * only when policy requires encrypting the store.
   */
  readonly encryptionKeys?: readonly Uint8Array[];
  readonly now?: () => number;
  /** Test injection only: production tokens require 256 bits of randomness. */
  readonly randomToken?: () => string;
  readonly randomId?: () => string;
}

const uuidV4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const anyUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hashPattern = /^[0-9a-f]{64}$/;
const tenantPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Index members a tenant/user revocation deletes per atomic round. */
const revokeBatch = 64;
const maxHtmlBytes = 1_048_576;
const coordinationKeyPattern = /^[A-Za-z0-9_-]{43}$/;
/** Sealed replay records hold one response (at most ~2 MiB of JSON) in base64url. */
const maxReplayBytes = 4 * 1_048_576;

function optionsError(message: string): never {
  throw new LiveProtocolError('INVALID_STORE_OPTIONS', 500, message);
}
/**
 * Redis I/O failures (connection, timeout, error reply) become a retryable
 * `503 STORE_UNAVAILABLE`, never `410` (which would make browsers discard
 * state that still exists). The original error is kept as `cause` for logs.
 */
function unavailable(cause: unknown): never {
  if (cause instanceof LiveProtocolError) throw cause;
  const error = new LiveProtocolError(
    'STORE_UNAVAILABLE',
    503,
    'Live state store is unavailable',
  );
  Object.defineProperty(error, 'cause', { value: cause });
  throw error;
}
function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function hashToken(token: string): string {
  return hashText(token);
}
function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    optionsError(`Invalid Redis Live store ${name}`);
  return value;
}
interface Decoded {
  readonly snapshot: StateSnapshot;
  readonly binding: Buffer;
  readonly tenant: string | undefined;
}
/** Key space of one binding: the legacy layout or one tenant's namespace. */
interface Space {
  /** `<prefix>` or `<prefix>t:<tenant>:`. */
  readonly base: string;
  readonly tenant: string | undefined;
  /** SHA-256 hex of the user id, when the namespace names one. */
  readonly user: string | undefined;
}
function children(
  value: unknown,
): Readonly<Record<string, ChildReference>> | undefined {
  if (value === undefined) return undefined;
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
      !anyUuid.test(id) ||
      !isSnapshotToken(token)
    )
      liveStateUnavailable();
    copy[key] = { alias, name, id, token };
  }
  return freezeChildReferences(copy);
}

/**
 * Shared Live state for multiple replicas, over RESP with no client library.
 * Same contract as `MemoryLiveStore` (identity binding, revision locks, TTL,
 * replay protection), implemented with Redis primitives:
 *
 * - keys hold SHA-256 hashes of snapshot tokens, bindings and users, never
 *   raw values; with `namespace`, each tenant has its own key space;
 * - `SET NX PX` is the per-entry transaction lease; commits are
 *   `WATCH`/`MULTI`/`EXEC` compare-and-set on the lease owner and revision;
 * - a fence key records that a callback started for a revision and is
 *   removed by the same `EXEC` that commits it: an attempt whose commit was
 *   never recorded (crashed replica, Redis outage, lapsed lease) invalidates
 *   the entry instead of letting a retry run the callback a second time;
 * - Redis expiry (`PX`) enforces the TTL alongside the stored `expiresAt`;
 * - Redis failures surface as `503 STORE_UNAVAILABLE` (retry later), never as
 *   missing state.
 *
 * Targets a single Redis primary (standalone or Sentinel-managed). Redis
 * Cluster is not supported: commits span keys in different hash slots.
 */
export class RedisLiveStore implements LiveStateStore, LiveActionCoordination {
  readonly #commands: RespConnection;
  /** Dedicated connection: WATCH/MULTI state is connection-scoped. */
  readonly #transactions: RespConnection;
  readonly #prefix: string;
  readonly #namespace: ((binding: string) => RedisLiveNamespace) | undefined;
  readonly #ttlMs: number;
  readonly #lockTtlMs: number;
  readonly #maxEntriesPerBinding: number;
  readonly #maxInFlight: number;
  readonly #keys: readonly { readonly id: string; readonly key: Buffer }[];
  readonly #now: () => number;
  readonly #token: () => string;
  readonly #id: () => string;
  #inFlight = 0;
  /** Entry lifetime in milliseconds. */
  get ttlMs(): number {
    return this.#ttlMs;
  }
  constructor(options: RedisLiveStoreOptions = {}) {
    this.#prefix = options.prefix ?? 'nestvexa:live:';
    if (!/^[a-z0-9:._-]{0,64}$/.test(this.#prefix))
      optionsError('Invalid Redis Live store prefix');
    if (
      options.namespace !== undefined &&
      typeof options.namespace !== 'function'
    )
      optionsError('Redis Live store namespace must be a function');
    this.#namespace = options.namespace;
    this.#ttlMs = boundedInteger(
      options.ttlMs ?? 900_000,
      1,
      86_400_000,
      'TTL',
    );
    this.#lockTtlMs = boundedInteger(
      options.lockTtlMs ?? 30_000,
      100,
      300_000,
      'lock TTL',
    );
    this.#maxEntriesPerBinding = boundedInteger(
      options.maxEntriesPerBinding ?? 1000,
      1,
      100_000,
      'capacity',
    );
    this.#maxInFlight = boundedInteger(
      options.maxInFlight ?? 1000,
      1,
      100_000,
      'in-flight limit',
    );
    const keys = options.encryptionKeys ?? [];
    if (keys.length > 8) optionsError('At most 8 Live store encryption keys');
    this.#keys = keys.map((key) => {
      if (!(key instanceof Uint8Array) || key.byteLength !== 32)
        optionsError('Live store encryption keys must be 32 bytes');
      const copy = Buffer.from(key);
      return {
        id: createHash('sha256').update(copy).digest('hex').slice(0, 16),
        key: copy,
      };
    });
    this.#now = options.now ?? Date.now;
    this.#token =
      options.randomToken ?? (() => randomBytes(32).toString('base64url'));
    this.#id = options.randomId ?? randomUUID;
    const connection: RespConnectionOptions = {
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.username === undefined ? {} : { username: options.username }),
      ...(options.password === undefined ? {} : { password: options.password }),
      ...(options.database === undefined ? {} : { database: options.database }),
      ...(options.commandTimeoutMs === undefined
        ? {}
        : { commandTimeoutMs: options.commandTimeoutMs }),
    };
    this.#commands = new RespConnection(connection);
    this.#transactions = new RespConnection(connection);
  }
  #time(): number {
    const now = this.#now();
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      now > Number.MAX_SAFE_INTEGER - this.#ttlMs
    )
      optionsError('Invalid Live store clock');
    return now;
  }
  /** One command on the shared connection; I/O failures become `STORE_UNAVAILABLE`. */
  async #command(...parts: string[]): Promise<Exclude<RespReply, RespError>> {
    try {
      return expectReply(await this.#commands.command(...parts));
    } catch (error) {
      unavailable(error);
    }
  }
  #tenantSpace(tenant: unknown, user: unknown): Space {
    if (typeof tenant !== 'string' || !tenantPattern.test(tenant))
      optionsError('Live store namespace returned an invalid tenant');
    if (
      user !== undefined &&
      (typeof user !== 'string' ||
        user.length === 0 ||
        Buffer.byteLength(user) > 1024)
    )
      optionsError('Live store namespace returned an invalid user');
    return {
      base: `${this.#prefix}t:${tenant}:`,
      tenant,
      user: user === undefined ? undefined : hashText(user),
    };
  }
  /** Key space for a validated binding (host-resolved tenant and user). */
  #space(binding: string): Space {
    const resolve = this.#namespace;
    if (!resolve)
      return { base: this.#prefix, tenant: undefined, user: undefined };
    const namespace: unknown = resolve(binding);
    if (!namespace || typeof namespace !== 'object')
      optionsError('Live store namespace returned an invalid value');
    return this.#tenantSpace(
      Reflect.get(namespace, 'tenant'),
      Reflect.get(namespace, 'user'),
    );
  }
  #stateKey(space: Space, tokenHash: string): string {
    return `${space.base}s:${tokenHash}`;
  }
  #lockKey(space: Space, tokenHash: string): string {
    return `${space.base}l:${tokenHash}`;
  }
  /** Present while a callback for the stored revision may have run uncommitted. */
  #fenceKey(space: Space, tokenHash: string): string {
    return `${space.base}f:${tokenHash}`;
  }
  #indexKey(space: Space, bindingHash: string): string {
    return `${space.base}b:${bindingHash}`;
  }
  /** Binding hashes of one user within a tenant. */
  #userKey(space: Space, userHash: string): string {
    return `${space.base}u:${userHash}`;
  }
  /** Binding hashes of one tenant. */
  #tenantKey(space: Space): string {
    return `${space.base}i`;
  }
  /** User hashes of one tenant (to delete their indexes with the tenant). */
  #usersKey(space: Space): string {
    return `${space.base}us`;
  }
  /** Token hash → tenant, so host-only `delete(token)` finds a namespaced entry. */
  #pointerKey(tokenHash: string): string {
    return `${this.#prefix}p:${tokenHash}`;
  }
  #encode(
    snapshot: StateSnapshot,
    binding: string,
    space: Space,
    key: string,
  ): string {
    const text = JSON.stringify({
      v: 1,
      i: snapshot.id,
      n: snapshot.name,
      r: snapshot.revision,
      s: snapshot.state,
      e: snapshot.expiresAt,
      b: binding,
      ...(space.tenant === undefined ? {} : { t: space.tenant }),
      ...(snapshot.children === undefined ? {} : { c: snapshot.children }),
    });
    const current = this.#keys[0];
    if (!current) return text;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', current.key, iv);
    // The key name is authenticated: a record copied to another key fails.
    cipher.setAAD(Buffer.from(key));
    const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return `e1.${current.id}.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`;
  }
  #decode(raw: string, key: string, token: string): Decoded {
    let text = raw;
    if (this.#keys.length) {
      const match = /^e1\.([0-9a-f]{16})\.([A-Za-z0-9_-]+)$/.exec(raw);
      const entry = match
        ? this.#keys.find((candidate) => candidate.id === match[1])
        : undefined;
      if (!match?.[2] || !entry) liveStateUnavailable();
      const bytes = Buffer.from(match[2], 'base64url');
      if (bytes.length < 29) liveStateUnavailable();
      try {
        const decipher = createDecipheriv(
          'aes-256-gcm',
          entry.key,
          bytes.subarray(0, 12),
        );
        decipher.setAAD(Buffer.from(key));
        decipher.setAuthTag(bytes.subarray(12, 28));
        text = Buffer.concat([
          decipher.update(bytes.subarray(28)),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        liveStateUnavailable();
      }
    } else if (raw.startsWith('e1.')) liveStateUnavailable();
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      liveStateUnavailable();
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
      liveStateUnavailable();
    const record = value as Record<string, unknown>;
    const {
      i: id,
      n: name,
      r: revision,
      e: expiresAt,
      b: binding,
      t: tenant,
    } = record;
    if (
      record['v'] !== 1 ||
      typeof id !== 'string' ||
      !anyUuid.test(id) ||
      typeof name !== 'string' ||
      typeof revision !== 'number' ||
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      typeof expiresAt !== 'number' ||
      !Number.isSafeInteger(expiresAt) ||
      typeof binding !== 'string' ||
      !hashPattern.test(binding) ||
      (tenant !== undefined &&
        (typeof tenant !== 'string' || !tenantPattern.test(tenant)))
    )
      liveStateUnavailable();
    let state: Record<string, JsonValue>;
    try {
      assertLiveComponentName(name);
      // Rejects prototype keys, non-JSON values and oversized structures.
      state = freezeJson(cloneState(record['s']));
    } catch {
      liveStateUnavailable();
    }
    const references = children(record['c']);
    return {
      snapshot: Object.freeze({
        id,
        name,
        revision,
        state,
        snapshot: token,
        expiresAt,
        ...(references === undefined ? {} : { children: references }),
      }),
      binding: Buffer.from(binding, 'hex'),
      tenant,
    };
  }
  /** Decode and check binding and tenant; anything else is unavailable state. */
  #verified(
    raw: string,
    key: string,
    token: string,
    hashed: Buffer,
    space: Space,
  ): StateSnapshot {
    const decoded = this.#decode(raw, key, token);
    if (
      decoded.binding.length !== hashed.length ||
      !timingSafeEqual(decoded.binding, hashed) ||
      decoded.tenant !== space.tenant
    )
      liveStateUnavailable();
    return decoded.snapshot;
  }
  async #read(
    token: string,
    binding: string,
    space: Space,
  ): Promise<StateSnapshot> {
    if (!isSnapshotToken(token)) liveStateUnavailable();
    const hashed = liveBindingHash(binding);
    const key = this.#stateKey(space, hashToken(token));
    const raw = await this.#command('GET', key);
    if (typeof raw !== 'string') liveStateUnavailable();
    const snapshot = this.#verified(raw, key, token, hashed, space);
    if (snapshot.expiresAt <= this.#time()) liveStateUnavailable();
    return snapshot;
  }
  /** Approximate per-binding cap; dead index members are pruned lazily. */
  async #reserve(space: Space, index: string): Promise<void> {
    const count = await this.#command('SCARD', index);
    if (typeof count !== 'number' || count < this.#maxEntriesPerBinding) return;
    const hashes = RedisLiveStore.#hashes(
      await this.#command('SMEMBERS', index),
    );
    const live = await Promise.all(
      hashes.map((hash) =>
        this.#command('EXISTS', this.#stateKey(space, hash)),
      ),
    );
    const dead = hashes.filter((_hash, index) => live[index] === 0);
    if (dead.length) await this.#command('SREM', index, ...dead);
    if (hashes.length - dead.length >= this.#maxEntriesPerBinding)
      throw new LiveProtocolError(
        'STORE_CAPACITY',
        503,
        'Live state capacity reached',
      );
  }
  /**
   * Optimistic transaction on the dedicated connection: WATCH `watch`, let
   * `plan` read current values and return the commands to queue (or null to
   * abort), then MULTI/EXEC. Resolves null when aborted or when a watched key
   * changed before EXEC. I/O failures become `STORE_UNAVAILABLE`.
   */
  async #atomic(
    watch: readonly string[],
    plan: (
      run: (...parts: string[]) => Promise<RespReply>,
    ) => Promise<readonly (readonly string[])[] | null>,
  ): Promise<RespReply[] | null> {
    try {
      return await this.#transactions.exclusive(async () => {
        const run = async (...parts: string[]) =>
          expectReply(await this.#transactions.command(...parts));
        let watching = false;
        let queued = false;
        try {
          if (watch.length) {
            await run('WATCH', ...watch);
            watching = true;
          }
          const commands = await plan(run);
          if (!commands) return null;
          await run('MULTI');
          queued = true;
          for (const parts of commands) await run(...parts);
          const result = await run('EXEC');
          queued = false;
          watching = false;
          return Array.isArray(result) ? result : null;
        } finally {
          // Leave the dedicated connection clean for the next transaction.
          if (queued)
            await this.#transactions.command('DISCARD').catch(() => undefined);
          else if (watching)
            await this.#transactions.command('UNWATCH').catch(() => undefined);
        }
      });
    } catch (error) {
      unavailable(error);
    }
  }
  async create(
    component: string,
    binding: string,
    state: Record<string, JsonValue>,
    references?: Readonly<Record<string, ChildReference>>,
  ): Promise<StateSnapshot> {
    assertLiveComponentName(component);
    const bindingHash = liveBindingHash(binding).toString('hex');
    const space = this.#space(binding);
    const validated = freezeJson(cloneState(state));
    const token = this.#token();
    if (!isSnapshotToken(token))
      optionsError('Live token generator returned an invalid token');
    const id = this.#id();
    if (!uuidV4.test(id))
      optionsError('Live identity generator returned an invalid UUID');
    const frozen = freezeChildReferences(references);
    const index = this.#indexKey(space, bindingHash);
    await this.#reserve(space, index);
    const snapshot: StateSnapshot = Object.freeze({
      id,
      name: component,
      revision: 0,
      state: validated,
      snapshot: token,
      expiresAt: this.#time() + this.#ttlMs,
      ...(frozen === undefined ? {} : { children: frozen }),
    });
    const tokenHash = hashToken(token);
    const key = this.#stateKey(space, tokenHash);
    const ttl = String(this.#ttlMs);
    const indexes: (readonly string[])[] = [
      ['SADD', index, tokenHash],
      ['PEXPIRE', index, ttl],
    ];
    if (space.tenant !== undefined) {
      const tenantIndex = this.#tenantKey(space);
      indexes.push(
        ['SET', this.#pointerKey(tokenHash), space.tenant, 'PX', ttl],
        ['SADD', tenantIndex, bindingHash],
        ['PEXPIRE', tenantIndex, ttl],
      );
      if (space.user !== undefined) {
        const userIndex = this.#userKey(space, space.user);
        indexes.push(
          ['SADD', userIndex, bindingHash],
          ['PEXPIRE', userIndex, ttl],
          ['SADD', this.#usersKey(space), space.user],
          ['PEXPIRE', this.#usersKey(space), ttl],
        );
      }
    }
    // Entry and indexes are written atomically so a concurrent revoke sees both.
    const result = await this.#atomic([], async () => [
      [
        'SET',
        key,
        this.#encode(snapshot, bindingHash, space, key),
        'NX',
        'PX',
        ttl,
      ],
      ...indexes,
    ]);
    if (!result || result[0] !== 'OK')
      optionsError('Live token generator returned a duplicate token');
    return freezeStateSnapshot(snapshot);
  }
  async peek(token: string, binding: string): Promise<StateSnapshot> {
    liveBindingHash(binding);
    return freezeStateSnapshot(
      await this.#read(token, binding, this.#space(binding)),
    );
  }
  /** Compare-and-delete of our lease (and fence), leaving another owner's. */
  async #release(lock: string, fence: string, owner: string): Promise<void> {
    await this.#atomic([lock], async (run) =>
      (await run('GET', lock)) === owner ? [['DEL', lock, fence]] : null,
    ).catch(() => undefined);
  }
  async transaction(
    token: string,
    binding: string,
    revision: number,
    callback: LiveTransactionCallback,
  ): Promise<LiveTransactionResult> {
    liveBindingHash(binding);
    const space = this.#space(binding);
    const before = await this.#read(token, binding, space);
    if (
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      revision !== before.revision ||
      revision === Number.MAX_SAFE_INTEGER
    )
      throw new LiveProtocolError(
        'STALE_REVISION',
        409,
        'Live state revision conflict',
      );
    if (this.#inFlight >= this.#maxInFlight)
      throw new LiveProtocolError(
        'STORE_CAPACITY',
        503,
        'Live action capacity reached',
      );
    const tokenHash = hashToken(token);
    const key = this.#stateKey(space, tokenHash);
    const lock = this.#lockKey(space, tokenHash);
    const fence = this.#fenceKey(space, tokenHash);
    const owner = randomBytes(18).toString('base64url');
    const leased = await this.#command(
      'SET',
      lock,
      owner,
      'NX',
      'PX',
      String(this.#lockTtlMs),
    );
    if (leased !== 'OK')
      throw new LiveProtocolError(
        'COMPONENT_BUSY',
        409,
        'Live component has an action in progress',
      );
    this.#inFlight++;
    try {
      let current: StateSnapshot;
      try {
        // Another replica may have committed between the read and the lease.
        current = await this.#read(token, binding, space);
        if (current.id !== before.id || current.revision !== revision)
          throw new LiveProtocolError(
            'STALE_REVISION',
            409,
            'Live state revision conflict',
          );
      } catch (error) {
        await this.#release(lock, fence, owner);
        throw error;
      }
      const lifetime = current.expiresAt - this.#time();
      if (lifetime <= 0) {
        await this.#release(lock, fence, owner);
        liveStateUnavailable();
      }
      // Record the attempt before running the callback. A fence left by an
      // earlier attempt means its callback may have run without a recorded
      // commit: invalidate rather than run it a second time.
      const fenced = await this.#command(
        'SET',
        fence,
        String(revision),
        'NX',
        'PX',
        String(lifetime),
      ).catch(async (error: unknown) => {
        await this.#release(lock, fence, owner);
        throw error;
      });
      if (fenced !== 'OK') {
        await this.#command('DEL', key, lock, fence).catch(() => undefined);
        liveStateUnavailable();
      }
      try {
        const result = await callback(freezeStateSnapshot(current));
        const state = freezeJson(cloneState(result.state));
        if (
          typeof result.html !== 'string' ||
          Buffer.byteLength(result.html) > maxHtmlBytes
        )
          throw new LiveProtocolError(
            'PAYLOAD_TOO_LARGE',
            413,
            'Live rendered response exceeds limits',
          );
        const remaining = current.expiresAt - this.#time();
        if (remaining <= 0) liveStateUnavailable();
        const nextChildren =
          result.children === undefined
            ? current.children
            : freezeChildReferences(result.children);
        const next: StateSnapshot = Object.freeze({
          id: current.id,
          name: current.name,
          snapshot: token,
          expiresAt: current.expiresAt,
          state,
          revision: revision + 1,
          ...(nextChildren === undefined ? {} : { children: nextChildren }),
        });
        const hashed = liveBindingHash(binding);
        // Compare-and-set: the lease is still ours and nobody revoked,
        // deleted or advanced the entry while the callback ran. The same
        // EXEC removes the lease and the fence.
        const committed = await this.#atomic([key, lock], async (run) => {
          if ((await run('GET', lock)) !== owner) return null;
          const raw = await run('GET', key);
          if (typeof raw !== 'string') return null;
          const stored = this.#verified(raw, key, token, hashed, space);
          if (stored.id !== current.id || stored.revision !== revision)
            return null;
          return [
            [
              'SET',
              key,
              this.#encode(next, hashed.toString('hex'), space, key),
              'XX',
              'PX',
              String(remaining),
            ],
            ['DEL', lock, fence],
          ];
        });
        if (!committed || committed[0] !== 'OK') liveStateUnavailable();
        return Object.freeze({
          ...freezeStateSnapshot(next),
          html: result.html,
        });
      } catch (error) {
        // The callback may already have committed an external effect.
        // Invalidate instead of permitting a retry of the same revision; if
        // Redis is unreachable the fence stays and does the same later.
        await this.#command('DEL', key, lock, fence).catch(() => undefined);
        throw error;
      }
    } finally {
      this.#inFlight--;
    }
  }
  /** Keys of the given entries: state, lease, fence and (namespaced) pointer. */
  #entryKeys(space: Space, tokenHashes: readonly string[]): string[] {
    return tokenHashes.flatMap((hash) => [
      this.#stateKey(space, hash),
      this.#lockKey(space, hash),
      this.#fenceKey(space, hash),
      ...(space.tenant === undefined ? [] : [this.#pointerKey(hash)]),
    ]);
  }
  /** Drop revoked bindings from the tenant (and user) indexes, so counts stay exact. */
  #groupRemovals(space: Space, bindingHashes: readonly string[]): string[][] {
    const user = space.user;
    if (space.tenant === undefined || !bindingHashes.length) return [];
    return [
      ['SREM', this.#tenantKey(space), ...bindingHashes],
      ...(user === undefined
        ? []
        : [['SREM', this.#userKey(space, user), ...bindingHashes]]),
    ];
  }
  static #hashes(members: RespReply): string[] {
    return Array.isArray(members)
      ? members.filter(
          (member): member is string =>
            typeof member === 'string' && hashPattern.test(member),
        )
      : [];
  }
  async revoke(binding: string): Promise<void> {
    const bindingHash = liveBindingHash(binding).toString('hex');
    const space = this.#space(binding);
    const index = this.#indexKey(space, bindingHash);
    // WATCH the index: an entry created concurrently aborts EXEC and the
    // deletion is retried with the new member list, so none survives.
    for (let attempt = 0; attempt < 16; attempt++) {
      const result = await this.#atomic([index], async (run) => [
        [
          'DEL',
          index,
          ...this.#entryKeys(
            space,
            RedisLiveStore.#hashes(await run('SMEMBERS', index)),
          ),
        ],
        ...this.#groupRemovals(space, [bindingHash]),
      ]);
      if (result) return;
    }
    unavailable(new Error('Live state revocation did not converge'));
  }
  /**
   * Delete every entry of the bindings listed in `group` (a tenant or user
   * index), in atomic rounds of up to 64 bindings. Each round WATCHes the
   * group and the binding indexes it deletes, so an entry created during the
   * round aborts it and the next round sees it. Ends when the group is empty.
   */
  async #revokeGroup(space: Space, group: string): Promise<number> {
    let bindings = 0;
    for (let round = 0; round < 10_000; round++) {
      let removed = 0;
      const result = await this.#atomic([group], async (run) => {
        const members = RedisLiveStore.#hashes(
          await run('SRANDMEMBER', group, String(revokeBatch)),
        );
        if (!members.length) return [['DEL', group]];
        const indexes = members.map((hash) => this.#indexKey(space, hash));
        await run('WATCH', ...indexes);
        const keys: string[] = [];
        for (const index of indexes)
          keys.push(
            index,
            ...this.#entryKeys(
              space,
              RedisLiveStore.#hashes(await run('SMEMBERS', index)),
            ),
          );
        removed = members.length;
        return [
          ['DEL', ...keys],
          ['SREM', group, ...members],
          // A user revocation also leaves the tenant index exact.
          ...(group === this.#tenantKey(space)
            ? []
            : [['SREM', this.#tenantKey(space), ...members]]),
        ];
      });
      if (result && removed === 0) return bindings;
      if (result) bindings += removed;
    }
    unavailable(new Error('Live state revocation did not converge'));
  }
  /**
   * Tenant offboarding: delete every Live entry of one tenant (all its users
   * and sessions). Requires `namespace`. Resolves the number of bindings
   * revoked. Host-only; never expose it as an unauthenticated endpoint.
   */
  async revokeTenant(tenant: string): Promise<number> {
    if (!this.#namespace)
      optionsError(
        'revokeTenant requires the Redis Live store namespace option',
      );
    const space = this.#tenantSpace(tenant, undefined);
    const revoked = await this.#revokeGroup(space, this.#tenantKey(space));
    // Then the per-user indexes, in rounds as well.
    const users = this.#usersKey(space);
    for (let round = 0; round < 10_000; round++) {
      let done = false;
      const result = await this.#atomic([users], async (run) => {
        const members = RedisLiveStore.#hashes(
          await run('SRANDMEMBER', users, String(revokeBatch)),
        );
        done = members.length === 0;
        if (done) return [['DEL', users]];
        return [
          ['DEL', ...members.map((hash) => this.#userKey(space, hash))],
          ['SREM', users, ...members],
        ];
      });
      if (result && done) return revoked;
    }
    unavailable(new Error('Live state revocation did not converge'));
  }
  /**
   * Sign a user out everywhere: delete the entries of every binding (session)
   * the namespace attributed to this user within the tenant. Requires
   * `namespace`. Resolves the number of bindings revoked.
   */
  async revokeUser(tenant: string, user: string): Promise<number> {
    if (!this.#namespace)
      optionsError('revokeUser requires the Redis Live store namespace option');
    const space = this.#tenantSpace(tenant, user);
    if (space.user === undefined)
      optionsError('Live store namespace returned an invalid user');
    return this.#revokeGroup(space, this.#userKey(space, space.user));
  }
  async delete(token: string): Promise<boolean> {
    if (!isSnapshotToken(token)) return false;
    const tokenHash = hashToken(token);
    let space: Space = {
      base: this.#prefix,
      tenant: undefined,
      user: undefined,
    };
    if (this.#namespace) {
      const tenant = await this.#command('GET', this.#pointerKey(tokenHash));
      if (typeof tenant !== 'string' || !tenantPattern.test(tenant))
        return false;
      space = this.#tenantSpace(tenant, undefined);
    }
    const [removed] = await Promise.all([
      this.#command('DEL', this.#stateKey(space, tokenHash)),
      this.#command(
        'DEL',
        this.#lockKey(space, tokenHash),
        this.#fenceKey(space, tokenHash),
        ...(space.tenant === undefined ? [] : [this.#pointerKey(tokenHash)]),
      ),
    ]);
    return removed === 1;
  }
  #coordinationKey(kind: 'r' | 'a', key: string): string {
    // Live passes SHA-256 digests; anything else is a programming error.
    if (typeof key !== 'string' || !coordinationKeyPattern.test(key))
      optionsError('Invalid Live coordination key');
    return `${this.#prefix}${kind}:${key}`;
  }
  #coordinationTtl(ttlMs: number): string {
    return String(boundedInteger(ttlMs, 1, 86_400_000, 'coordination TTL'));
  }
  /**
   * Sealed idempotent replay record shared by replicas (`LiveActionCoordination`).
   * Values are ciphertext produced by Live; this store never sees responses.
   */
  async readReplay(key: string): Promise<string | undefined> {
    const raw = await this.#command('GET', this.#coordinationKey('r', key));
    return typeof raw === 'string' ? raw : undefined;
  }
  async writeReplay(key: string, value: string, ttlMs: number): Promise<void> {
    if (
      typeof value !== 'string' ||
      !/^r1\.[A-Za-z0-9_-]+$/.test(value) ||
      value.length > maxReplayBytes
    )
      optionsError('Invalid Live replay record');
    await this.#command(
      'SET',
      this.#coordinationKey('r', key),
      value,
      'PX',
      this.#coordinationTtl(ttlMs),
    );
  }
  /** Per-identity action lease (`SET NX PX`), shared by replicas; expires after `ttlMs`. */
  async acquireActionLease(
    key: string,
    owner: string,
    ttlMs: number,
  ): Promise<boolean> {
    if (typeof owner !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(owner))
      optionsError('Invalid Live lease owner');
    const reply = await this.#command(
      'SET',
      this.#coordinationKey('a', key),
      owner,
      'NX',
      'PX',
      this.#coordinationTtl(ttlMs),
    );
    return reply === 'OK';
  }
  /** Compare-and-delete: a lease that expired and was taken by another owner stays. */
  async releaseActionLease(key: string, owner: string): Promise<void> {
    const lease = this.#coordinationKey('a', key);
    await this.#atomic([lease], async (run) =>
      (await run('GET', lease)) === owner ? [['DEL', lease]] : null,
    );
  }
  /** Close connections; shared state stays in Redis for the other replicas. */
  async close(): Promise<void> {
    await Promise.all([this.#commands.close(), this.#transactions.close()]);
  }
}
