import session from 'express-session';
import type { SessionData } from 'express-session';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface Entry {
  readonly data: SessionData;
  /** Epoch milliseconds after which the entry is ignored and dropped. */
  readonly expires: number;
}

const maxSessions = 10_000;
const fallbackTtlMs = 60 * 60_000;

function expiry(data: SessionData, now: number): number {
  const expires: unknown = data.cookie.expires;
  if (expires instanceof Date) return expires.getTime();
  if (typeof expires === 'string') {
    const time = Date.parse(expires);
    if (Number.isFinite(time)) return time;
  }
  return now + fallbackTtlMs;
}

/**
 * `SESSION_STORE=file`: sessions in one JSON file of the data directory, so a
 * restart of a single showcase process keeps everyone signed in (the
 * resilience test restarts the server mid-session). Sign-in, sign-out and
 * other session changes are written at once (atomically); expiry refreshes
 * are coalesced. Expired entries are dropped. A demonstration store for one
 * process: replicas need a shared store (for example Redis) instead.
 */
export class FileSessionStore extends session.Store {
  readonly #file: string;
  readonly #entries = new Map<string, Entry>();
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(file: string) {
    super();
    this.#file = file;
    let raw: string | undefined;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      raw = undefined;
    }
    const parsed: unknown = raw === undefined ? {} : JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error(`${file} is not a session file; delete it`);
    const now = Date.now();
    for (const [id, value] of Object.entries(parsed)) {
      const data: unknown =
        value && typeof value === 'object' ? Reflect.get(value, 'data') : null;
      const expires: unknown =
        value && typeof value === 'object'
          ? Reflect.get(value, 'expires')
          : null;
      if (
        typeof expires === 'number' &&
        expires > now &&
        data &&
        typeof data === 'object' &&
        Reflect.get(data, 'cookie')
      )
        this.#entries.set(id, { data: data as SessionData, expires });
    }
  }

  override get(
    sid: string,
    callback: (error: unknown, session?: SessionData | null) => void,
  ): void {
    const entry = this.#entries.get(sid);
    if (!entry || entry.expires <= Date.now()) {
      if (entry && this.#entries.delete(sid)) this.#later();
      callback(null, null);
      return;
    }
    // A copy: express-session mutates the object it receives.
    callback(null, structuredClone(entry.data));
  }

  override set(
    sid: string,
    data: SessionData,
    callback?: (error?: unknown) => void,
  ): void {
    if (!this.#entries.has(sid) && this.#entries.size >= maxSessions) {
      callback?.(new Error('Too many sessions'));
      return;
    }
    const copy = JSON.parse(JSON.stringify(data)) as SessionData;
    this.#entries.set(sid, { data: copy, expires: expiry(data, Date.now()) });
    this.#now();
    callback?.();
  }

  override touch(sid: string, data: SessionData, callback?: () => void): void {
    const entry = this.#entries.get(sid);
    if (entry) {
      this.#entries.set(sid, { ...entry, expires: expiry(data, Date.now()) });
      this.#later();
    }
    callback?.();
  }

  override destroy(sid: string, callback?: (error?: unknown) => void): void {
    if (this.#entries.delete(sid)) this.#now();
    callback?.();
  }

  #later(): void {
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined;
      this.#write();
    }, 50);
  }
  #now(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#write();
  }
  #write(): void {
    const now = Date.now();
    const output: Record<string, Entry> = {};
    for (const [id, entry] of this.#entries)
      if (entry.expires > now) output[id] = entry;
    mkdirSync(dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(output), { mode: 0o600 });
    renameSync(temporary, this.#file);
  }
}
