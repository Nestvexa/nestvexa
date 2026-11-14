import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';

/**
 * In-process RESP2 test double. NOT Redis: it implements only the commands the
 * Nestvexa Redis adapters use (strings with NX/XX/PX, INCR, sets incl.
 * SRANDMEMBER with a count, sorted sets
 * with ZRANGEBYSCORE, expiry, optimistic WATCH/MULTI/EXEC, PUBLISH/SUBSCRIBE,
 * AUTH), with lazily applied expiry and a
 * per-key version for WATCH. Real-server behavior is checked by
 * `pnpm test:services` against Redis.
 */
export interface RespDouble {
  readonly port: number;
  readonly server: Server;
  /** Raw stored values by key (for tamper and at-rest assertions). */
  readonly values: Map<string, string | Set<string> | Map<string, number>>;
  /** Commands received, without arguments (for diagnostics). */
  readonly log: string[];
  /** Resets every client connection, like a server restart that keeps data. */
  drop(): void;
  close(): Promise<void>;
}
interface Client {
  authenticated: boolean;
  watched: Map<string, number>;
  queue: string[][] | undefined;
  dirty: boolean;
}

function bulk(value: string | null): string {
  return value === null
    ? '$-1\r\n'
    : `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
}
function array(items: readonly string[]): string {
  return `*${items.length}\r\n` + items.map((item) => bulk(item)).join('');
}

export async function respDouble(
  options: { readonly password?: string; readonly port?: number } = {},
): Promise<RespDouble> {
  const values = new Map<string, string | Set<string> | Map<string, number>>();
  const expiry = new Map<string, number>();
  const versions = new Map<string, number>();
  const subscribers = new Map<string, Set<Socket>>();
  const connections = new Set<Socket>();
  const log: string[] = [];
  const touch = (key: string) =>
    versions.set(key, (versions.get(key) ?? 0) + 1);
  const live = (key: string): boolean => {
    const at = expiry.get(key);
    if (at !== undefined && at <= Date.now()) {
      values.delete(key);
      expiry.delete(key);
      touch(key);
    }
    return values.has(key);
  };
  const remove = (key: string): boolean => {
    if (!live(key)) return false;
    values.delete(key);
    expiry.delete(key);
    touch(key);
    return true;
  };
  const string = (key: string): string | null => {
    if (!live(key)) return null;
    const value = values.get(key);
    return typeof value === 'string' ? value : null;
  };
  const set = (key: string): Set<string> | undefined => {
    if (!live(key)) return undefined;
    const value = values.get(key);
    return value instanceof Set ? value : undefined;
  };
  const zset = (key: string): Map<string, number> | undefined => {
    if (!live(key)) return undefined;
    const value = values.get(key);
    return value instanceof Map ? value : undefined;
  };
  /** Parse a ZRANGEBYSCORE bound: `-inf`, `+inf`, `n` or exclusive `(n`. */
  const bound = (text: string): { value: number; open: boolean } => {
    const open = text.startsWith('(');
    const raw = open ? text.slice(1) : text;
    const value =
      raw === '-inf' ? -Infinity : raw === '+inf' ? Infinity : Number(raw);
    return { value, open };
  };
  const wrongType =
    '-WRONGTYPE Operation against a key holding the wrong kind of value\r\n';
  /** Execute one command; returns the encoded reply. */
  function execute(socket: Socket, parts: string[]): string {
    const [raw = '', ...args] = parts;
    const name = raw.toUpperCase();
    switch (name) {
      case 'PING':
        return '+PONG\r\n';
      case 'SELECT':
        return '+OK\r\n';
      case 'GET':
        return bulk(string(args[0] ?? ''));
      case 'SET': {
        const [key = '', value = '', ...flags] = args;
        let nx = false;
        let xx = false;
        let px: number | undefined;
        for (let index = 0; index < flags.length; index++) {
          const flag = (flags[index] ?? '').toUpperCase();
          if (flag === 'NX') nx = true;
          else if (flag === 'XX') xx = true;
          else if (flag === 'PX') px = Number(flags[++index]);
          else return '-ERR syntax error\r\n';
        }
        if (px !== undefined && (!Number.isSafeInteger(px) || px <= 0))
          return '-ERR invalid expire time in set\r\n';
        const exists = live(key);
        if ((nx && exists) || (xx && !exists)) return '$-1\r\n';
        values.set(key, value);
        if (px === undefined) expiry.delete(key);
        else expiry.set(key, Date.now() + px);
        touch(key);
        return '+OK\r\n';
      }
      case 'DEL': {
        let count = 0;
        for (const key of args) if (remove(key)) count++;
        return `:${count}\r\n`;
      }
      case 'EXISTS': {
        let count = 0;
        for (const key of args) if (live(key)) count++;
        return `:${count}\r\n`;
      }
      case 'PEXPIRE': {
        const [key = '', ms = ''] = args;
        if (!live(key)) return ':0\r\n';
        expiry.set(key, Date.now() + Number(ms));
        touch(key);
        return ':1\r\n';
      }
      case 'PTTL': {
        const key = args[0] ?? '';
        if (!live(key)) return ':-2\r\n';
        const at = expiry.get(key);
        return `:${at === undefined ? -1 : at - Date.now()}\r\n`;
      }
      case 'SADD': {
        const [key = '', ...members] = args;
        if (live(key) && !set(key))
          return '-WRONGTYPE Operation against a key holding the wrong kind of value\r\n';
        const target = set(key) ?? new Set<string>();
        let added = 0;
        for (const member of members)
          if (!target.has(member)) {
            target.add(member);
            added++;
          }
        values.set(key, target);
        touch(key);
        return `:${added}\r\n`;
      }
      case 'SREM': {
        const [key = '', ...members] = args;
        const target = set(key);
        let removed = 0;
        for (const member of members) if (target?.delete(member)) removed++;
        if (target && !target.size) remove(key);
        else if (removed) touch(key);
        return `:${removed}\r\n`;
      }
      case 'INCR': {
        const key = args[0] ?? '';
        const next = Number(string(key) ?? '0') + 1;
        if (!Number.isSafeInteger(next))
          return '-ERR value is not an integer or out of range\r\n';
        values.set(key, String(next));
        touch(key);
        return `:${next}\r\n`;
      }
      case 'ZADD': {
        const [key = '', ...pairs] = args;
        if (live(key) && !zset(key)) return wrongType;
        if (!pairs.length || pairs.length % 2) return '-ERR syntax error\r\n';
        const target = zset(key) ?? new Map<string, number>();
        let added = 0;
        for (let index = 0; index < pairs.length; index += 2) {
          const score = Number(pairs[index]);
          if (Number.isNaN(score)) return '-ERR value is not a valid float\r\n';
          const member = pairs[index + 1] ?? '';
          if (!target.has(member)) added++;
          target.set(member, score);
        }
        values.set(key, target);
        touch(key);
        return `:${added}\r\n`;
      }
      case 'ZREM': {
        const [key = '', ...members] = args;
        if (live(key) && !zset(key)) return wrongType;
        const target = zset(key);
        let removed = 0;
        for (const member of members) if (target?.delete(member)) removed++;
        if (target && !target.size) remove(key);
        else if (removed) touch(key);
        return `:${removed}\r\n`;
      }
      case 'ZCARD':
        return `:${zset(args[0] ?? '')?.size ?? 0}\r\n`;
      case 'ZRANGEBYSCORE': {
        const [key = '', min = '', max = '', ...rest] = args;
        const low = bound(min);
        const high = bound(max);
        let offset = 0;
        let count = Infinity;
        if (rest.length) {
          if (rest.length !== 3 || (rest[0] ?? '').toUpperCase() !== 'LIMIT')
            return '-ERR syntax error\r\n';
          offset = Number(rest[1]);
          count = Number(rest[2]);
          if (count < 0) count = Infinity;
        }
        // Redis orders by score, then lexicographically by member.
        const sorted = [...(zset(key) ?? new Map<string, number>())]
          .filter(
            ([, score]) =>
              (low.open ? score > low.value : score >= low.value) &&
              (high.open ? score < high.value : score <= high.value),
          )
          .sort(([a, x], [b, y]) => x - y || (a < b ? -1 : a > b ? 1 : 0))
          .map(([member]) => member);
        return array(sorted.slice(offset, offset + count));
      }
      case 'SMEMBERS':
        return array([...(set(args[0] ?? '') ?? [])]);
      case 'SCARD':
        return `:${set(args[0] ?? '')?.size ?? 0}\r\n`;
      case 'SRANDMEMBER': {
        // Only the form with a positive count: up to `count` distinct members.
        const count = Number(args[1]);
        if (!Number.isSafeInteger(count) || count < 1)
          return '-ERR value is not an integer or out of range\r\n';
        return array([...(set(args[0] ?? '') ?? [])].slice(0, count));
      }
      case 'PUBLISH': {
        const [channel = '', message = ''] = args;
        const targets = subscribers.get(channel) ?? new Set();
        for (const target of targets)
          target.write(
            `*3\r\n$7\r\nmessage\r\n${bulk(channel)}${bulk(message)}`,
          );
        return `:${targets.size}\r\n`;
      }
      case 'SUBSCRIBE': {
        let reply = '';
        for (const channel of args) {
          const targets = subscribers.get(channel) ?? new Set();
          targets.add(socket);
          subscribers.set(channel, targets);
          reply += `*3\r\n$9\r\nsubscribe\r\n${bulk(channel)}:1\r\n`;
        }
        return reply;
      }
      default:
        return `-ERR unknown command '${name}'\r\n`;
    }
  }
  const server = createServer((socket) => {
    connections.add(socket);
    const client: Client = {
      authenticated: options.password === undefined,
      watched: new Map(),
      queue: undefined,
      dirty: false,
    };
    socket.on('close', () => {
      connections.delete(socket);
      for (const targets of subscribers.values()) targets.delete(socket);
    });
    socket.on('error', () => undefined);
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const text = buffer.toString('latin1');
        const match = /^\*(\d+)\r\n/.exec(text);
        if (!match) return;
        let offset = match[0].length;
        const parts: string[] = [];
        for (let index = 0; index < Number(match[1]); index++) {
          const header = /^\$(\d+)\r\n/.exec(text.slice(offset));
          if (!header) return;
          offset += header[0].length;
          const length = Number(header[1]);
          if (buffer.length < offset + length + 2) return;
          parts.push(buffer.toString('utf8', offset, offset + length));
          offset += length + 2;
        }
        buffer = buffer.subarray(offset);
        const name = (parts[0] ?? '').toUpperCase();
        log.push(name);
        if (name === 'AUTH') {
          const password = parts.at(-1);
          client.authenticated = password === options.password;
          socket.write(
            client.authenticated
              ? '+OK\r\n'
              : '-WRONGPASS invalid username-password pair\r\n',
          );
          continue;
        }
        if (!client.authenticated) {
          socket.write('-NOAUTH Authentication required.\r\n');
          continue;
        }
        if (name === 'MULTI') {
          if (client.queue)
            socket.write('-ERR MULTI calls can not be nested\r\n');
          else {
            client.queue = [];
            socket.write('+OK\r\n');
          }
          continue;
        }
        if (name === 'DISCARD') {
          client.queue = undefined;
          client.watched.clear();
          socket.write('+OK\r\n');
          continue;
        }
        if (name === 'WATCH') {
          if (client.queue) {
            socket.write('-ERR WATCH inside MULTI is not allowed\r\n');
            continue;
          }
          for (const key of parts.slice(1)) {
            live(key);
            client.watched.set(key, versions.get(key) ?? 0);
          }
          socket.write('+OK\r\n');
          continue;
        }
        if (name === 'UNWATCH') {
          client.watched.clear();
          socket.write('+OK\r\n');
          continue;
        }
        if (name === 'EXEC') {
          const queue = client.queue;
          client.queue = undefined;
          if (!queue) {
            socket.write('-ERR EXEC without MULTI\r\n');
            continue;
          }
          let changed = false;
          for (const [key, version] of client.watched) {
            live(key);
            if ((versions.get(key) ?? 0) !== version) changed = true;
          }
          client.watched.clear();
          if (changed) {
            socket.write('*-1\r\n');
            continue;
          }
          socket.write(
            `*${queue.length}\r\n` +
              queue.map((queued) => execute(socket, queued)).join(''),
          );
          continue;
        }
        if (client.queue) {
          client.queue.push(parts);
          socket.write('+QUEUED\r\n');
          continue;
        }
        socket.write(execute(socket, parts));
      }
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, '127.0.0.1', resolve),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  return {
    port: address.port,
    server,
    values,
    log,
    drop: () => {
      for (const socket of connections) socket.destroy();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of connections) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
