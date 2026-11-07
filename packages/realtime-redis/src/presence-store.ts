import type {
  PresenceEntry,
  PresenceMember,
  PresenceStore,
} from '@nestvexa/realtime';
import { expectReply, RespConnection } from './resp.js';
import type { RespConnectionOptions } from './resp.js';

export interface RedisPresenceStoreOptions extends RespConnectionOptions {
  /** Key prefix isolating one application/environment on a shared server. */
  readonly prefix?: string;
}

const replicaPattern = /^[A-Za-z0-9_-]{8,64}$/;
const channelPattern = /^[a-z0-9][a-z0-9:._-]{0,127}$/;
const maxEntryBytes = 262_144;
/**
 * Index lifetime after the last write. Entries carry the real TTL; the index
 * only names candidate replicas (lapsed ones are pruned on read), so a replica
 * with a shorter TTL never shortens other replicas' presence.
 */
const indexTtlMs = '86400000';

/**
 * Cross-replica presence for `RealtimeModule({ presence: { store } })`, over
 * RESP with no client library. Each replica's members per channel live in
 * `<prefix>pm:<replica>:<channel>` with a Redis expiry (`PX`), indexed by the
 * set `<prefix>pr:<channel>`; a replica that dies stops refreshing its key and
 * drops out of presence when the key expires. Readers re-validate every entry.
 */
export class RedisPresenceStore implements PresenceStore {
  readonly #redis: RespConnection;
  readonly #prefix: string;
  constructor(options: RedisPresenceStoreOptions = {}) {
    this.#prefix = options.prefix ?? 'nestvexa:presence:';
    if (!/^[a-z0-9:._-]{0,64}$/.test(this.#prefix))
      throw new Error('Invalid Redis presence prefix');
    this.#redis = new RespConnection({
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.username === undefined ? {} : { username: options.username }),
      ...(options.password === undefined ? {} : { password: options.password }),
      ...(options.database === undefined ? {} : { database: options.database }),
      ...(options.commandTimeoutMs === undefined
        ? {}
        : { commandTimeoutMs: options.commandTimeoutMs }),
    });
  }
  #check(replica: string, channel: string): void {
    if (!replicaPattern.test(replica) || !channelPattern.test(channel))
      throw new Error('Invalid presence replica or channel');
  }
  #entry(replica: string, channel: string): string {
    return `${this.#prefix}pm:${replica}:${channel}`;
  }
  #index(channel: string): string {
    return `${this.#prefix}pr:${channel}`;
  }
  async #run(...parts: string[]) {
    return expectReply(await this.#redis.command(...parts));
  }
  async write(
    replica: string,
    channel: string,
    entry: {
      readonly members: readonly PresenceMember[];
      readonly total: number;
    },
    ttlMs: number,
  ): Promise<void> {
    this.#check(replica, channel);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 86_400_000)
      throw new Error('Invalid presence TTL');
    const text = JSON.stringify({ v: 1, t: entry.total, m: entry.members });
    if (Buffer.byteLength(text) > maxEntryBytes)
      throw new Error('Presence entry too large');
    const ttl = String(ttlMs);
    // Pipelined on one connection: the index may briefly name a replica
    // whose entry is not written yet, which readers treat as absent.
    await Promise.all([
      this.#run('SET', this.#entry(replica, channel), text, 'PX', ttl),
      this.#run('SADD', this.#index(channel), replica),
      this.#run('PEXPIRE', this.#index(channel), indexTtlMs),
    ]);
  }
  async remove(replica: string, channel: string): Promise<void> {
    this.#check(replica, channel);
    await Promise.all([
      this.#run('DEL', this.#entry(replica, channel)),
      this.#run('SREM', this.#index(channel), replica),
    ]);
  }
  async read(channel: string): Promise<readonly PresenceEntry[]> {
    if (!channelPattern.test(channel)) return [];
    const members = await this.#run('SMEMBERS', this.#index(channel));
    const replicas = (Array.isArray(members) ? members : [])
      .filter(
        (value): value is string =>
          typeof value === 'string' && replicaPattern.test(value),
      )
      .slice(0, 1024);
    const values = await Promise.all(
      replicas.map((replica) =>
        this.#run('GET', this.#entry(replica, channel)),
      ),
    );
    const entries: PresenceEntry[] = [];
    const lapsed: string[] = [];
    replicas.forEach((replica, index) => {
      const raw = values[index];
      if (typeof raw !== 'string') {
        lapsed.push(replica);
        return;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        const total: unknown =
          parsed && typeof parsed === 'object'
            ? Reflect.get(parsed, 't')
            : undefined;
        const list: unknown =
          parsed && typeof parsed === 'object'
            ? Reflect.get(parsed, 'm')
            : undefined;
        if (
          Reflect.get(parsed as object, 'v') !== 1 ||
          typeof total !== 'number' ||
          !Array.isArray(list)
        )
          return;
        // Member shapes are validated by RealtimeService before use.
        entries.push(
          Object.freeze({
            replica,
            total,
            members: Object.freeze([...(list as unknown[])]),
          }),
        );
      } catch {
        // Malformed entries from a shared server are ignored.
      }
    });
    // Expired replicas leave the index lazily.
    if (lapsed.length)
      await this.#run('SREM', this.#index(channel), ...lapsed).catch(
        () => undefined,
      );
    return entries;
  }
  async close(): Promise<void> {
    await this.#redis.close();
  }
}
