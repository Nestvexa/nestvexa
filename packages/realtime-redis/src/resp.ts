import { connect } from 'node:net';
import type { Socket } from 'node:net';

/** An error reply (`-ERR ...`) from the server. Its text never contains values. */
export class RespError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RespError';
  }
}
export type RespReply = string | number | null | RespError | RespReply[];

export interface RespConnectionOptions {
  readonly host?: string;
  readonly port?: number;
  /** ACL user (Redis 6+); omitted means the default user. */
  readonly username?: string;
  /** AUTH password; never logged or included in errors. */
  readonly password?: string;
  /** Logical database index (single-primary deployments only). */
  readonly database?: number;
  /** A command without a reply after this long destroys the connection. */
  readonly commandTimeoutMs?: number;
}

const maxBulkBytes = 8_388_608;
const maxArrayItems = 65_536;
const maxBufferBytes = 16_777_216;

/** Encode one command as a RESP array of bulk strings. */
export function encodeCommand(parts: readonly string[]): Buffer {
  const chunks: Buffer[] = [Buffer.from(`*${parts.length}\r\n`)];
  for (const part of parts) {
    const body = Buffer.from(part, 'utf8');
    chunks.push(Buffer.from(`$${body.length}\r\n`), body, Buffer.from('\r\n'));
  }
  return Buffer.concat(chunks);
}

/** Incremental RESP2 parser. Returns complete replies and the unconsumed rest. */
export function parseReplies(buffer: Buffer): {
  replies: RespReply[];
  rest: Buffer;
} {
  const replies: RespReply[] = [];
  let offset = 0;
  function line(from: number): { text: string; next: number } | undefined {
    const end = buffer.indexOf('\r\n', from);
    if (end < 0) return undefined;
    return { text: buffer.toString('utf8', from, end), next: end + 2 };
  }
  function integer(text: string): number {
    if (!/^-?\d{1,15}$/.test(text)) throw new Error('Malformed RESP reply');
    return Number(text);
  }
  function read(from: number): { value: RespReply; next: number } | undefined {
    if (from >= buffer.length) return undefined;
    const type = String.fromCharCode(buffer[from] ?? 0);
    const header = line(from + 1);
    if (!header) return undefined;
    switch (type) {
      case '+':
        return { value: header.text, next: header.next };
      case '-':
        return { value: new RespError(header.text), next: header.next };
      case ':':
        return { value: integer(header.text), next: header.next };
      case '$': {
        const length = integer(header.text);
        if (length < 0) return { value: null, next: header.next };
        if (length > maxBulkBytes) throw new Error('Oversized RESP reply');
        if (buffer.length < header.next + length + 2) return undefined;
        return {
          value: buffer.toString('utf8', header.next, header.next + length),
          next: header.next + length + 2,
        };
      }
      case '*': {
        const count = integer(header.text);
        if (count < 0) return { value: null, next: header.next };
        if (count > maxArrayItems) throw new Error('Oversized RESP reply');
        const items: RespReply[] = [];
        let cursor = header.next;
        for (let index = 0; index < count; index++) {
          const item = read(cursor);
          if (!item) return undefined;
          items.push(item.value);
          cursor = item.next;
        }
        return { value: items, next: cursor };
      }
      default:
        throw new Error('Malformed RESP reply');
    }
  }
  for (;;) {
    const item = read(offset);
    if (!item) break;
    replies.push(item.value);
    offset = item.next;
  }
  return { replies, rest: buffer.subarray(offset) };
}

interface Pending {
  readonly resolve: (reply: RespReply) => void;
  readonly reject: (error: Error) => void;
}

/**
 * One pipelined request/response connection speaking RESP2 over node:net, with
 * no client library. It connects lazily, reconnects on the next command after
 * a failure, and rejects every pending command when the socket closes, so a
 * caller never mistakes a lost reply for success. Not for SUBSCRIBE.
 *
 * `exclusive` serializes WATCH/MULTI/EXEC sequences: connection-scoped
 * transaction state must never interleave with other callers' commands, so
 * give transactional work its own connection.
 */
export class RespConnection {
  readonly #options: Required<
    Omit<RespConnectionOptions, 'username' | 'password'>
  > &
    Pick<RespConnectionOptions, 'username' | 'password'>;
  #socket: Promise<Socket> | undefined;
  readonly #pending: Pending[] = [];
  #closed = false;
  #queue: Promise<unknown> = Promise.resolve();
  constructor(options: RespConnectionOptions = {}) {
    this.#options = {
      host: options.host ?? '127.0.0.1',
      port: options.port ?? 6379,
      database: options.database ?? 0,
      commandTimeoutMs: options.commandTimeoutMs ?? 5000,
      ...(options.username === undefined ? {} : { username: options.username }),
      ...(options.password === undefined ? {} : { password: options.password }),
    };
    const { port, database, commandTimeoutMs } = this.#options;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
      throw new Error('Invalid Redis port');
    if (!Number.isSafeInteger(database) || database < 0 || database > 1024)
      throw new Error('Invalid Redis database index');
    if (
      !Number.isSafeInteger(commandTimeoutMs) ||
      commandTimeoutMs < 10 ||
      commandTimeoutMs > 120_000
    )
      throw new Error('Invalid Redis command timeout');
  }
  #connect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.#options.port, this.#options.host);
      socket.setNoDelay(true);
      let buffer: Buffer = Buffer.alloc(0);
      let ready = false;
      socket.on('data', (chunk: Buffer) => {
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
        if (buffer.length > maxBufferBytes) {
          socket.destroy(new Error('Redis reply buffer exceeded'));
          return;
        }
        let parsed: ReturnType<typeof parseReplies>;
        try {
          parsed = parseReplies(buffer);
        } catch {
          socket.destroy(new Error('Malformed Redis reply'));
          return;
        }
        buffer = parsed.rest;
        for (const reply of parsed.replies)
          this.#pending.shift()?.resolve(reply);
      });
      socket.once('connect', () => {
        ready = true;
        const setup: string[][] = [];
        const { username, password, database } = this.#options;
        if (password !== undefined)
          setup.push(
            username === undefined
              ? ['AUTH', password]
              : ['AUTH', username, password],
          );
        if (database !== 0) setup.push(['SELECT', String(database)]);
        // Setup replies are consumed first; a refusal closes the connection so
        // queued commands fail instead of running unauthenticated.
        for (const parts of setup) {
          this.#pending.push({
            resolve: (reply) => {
              if (reply instanceof RespError)
                socket.destroy(new Error('Redis connection setup rejected'));
            },
            reject: () => undefined,
          });
          socket.write(encodeCommand(parts));
        }
        resolve(socket);
      });
      // Errors after connecting are followed by 'close'; keep a listener so a
      // reset never becomes an uncaught exception.
      socket.on('error', () => {
        if (!ready) reject(new Error('Redis connection failed'));
      });
      socket.on('close', () => {
        this.#socket = undefined;
        for (const pending of this.#pending.splice(0))
          pending.reject(new Error('Redis connection closed'));
      });
    });
  }
  /** Send one command and await its reply. Error replies resolve as RespError. */
  async command(...parts: string[]): Promise<RespReply> {
    if (this.#closed) throw new Error('Redis connection is closed');
    if (!parts.length || parts.length > maxArrayItems)
      throw new Error('Invalid Redis command');
    this.#socket ??= this.#connect().catch((error: unknown) => {
      this.#socket = undefined;
      throw error;
    });
    const socket = await this.#socket;
    return new Promise<RespReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy(new Error('Redis command timed out'));
      }, this.#options.commandTimeoutMs);
      timer.unref();
      this.#pending.push({
        resolve: (reply) => {
          clearTimeout(timer);
          resolve(reply);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.write(encodeCommand(parts));
    });
  }
  /** Run `work` with no other `exclusive` work interleaved on this connection. */
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.catch(() => undefined);
    return run;
  }
  async close(): Promise<void> {
    this.#closed = true;
    const socket = this.#socket;
    this.#socket = undefined;
    if (!socket) return;
    try {
      (await socket).destroy();
    } catch {
      // Never connected: nothing to close.
    }
  }
}

/** Narrow a reply, turning server errors into exceptions without echoing values. */
export function expectReply(reply: RespReply): Exclude<RespReply, RespError> {
  if (reply instanceof RespError)
    throw new Error(`Redis rejected a command: ${reply.message.split(' ')[0]}`);
  return reply;
}
