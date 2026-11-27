import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { Server as TlsServer } from 'node:tls';

/**
 * Time bounds for slow clients (slowloris, slow headers, trickled bodies) on
 * the host's Node HTTP/1.1 server. Node's own `headersTimeout` and
 * `requestTimeout` are only checked every `connectionsCheckingInterval`
 * (30 s), and Fastify sets `requestTimeout` to 0 (no bound on a trickled
 * body), so these bounds use their own per-connection timers.
 */
export interface HttpServerBounds {
  /**
   * Longest a connection may take to deliver a complete request head,
   * counted from the connection (or from the end of the previous response on
   * a kept-alive connection). Default 30000 ms (1000-600000).
   */
  readonly headersTimeoutMs?: number;
  /**
   * Longest a request may take to deliver its whole body after the head.
   * Default 300000 ms (Node's own default; 1000-3600000). Routes that stream
   * large uploads keep their own inactivity timeouts inside this bound.
   */
  readonly requestTimeoutMs?: number;
}

export interface NormalizedHttpServerBounds {
  readonly headersTimeoutMs: number;
  readonly requestTimeoutMs: number;
}

const bounded = new WeakMap<Server, NormalizedHttpServerBounds>();

function integer(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max)
    throw new Error(
      `Invalid HTTP server bound ${label}: an integer from ${min} through ${max}`,
    );
  return result;
}

/** Validate bounds and apply the defaults. */
export function normalizeHttpServerBounds(
  options: HttpServerBounds = {},
): NormalizedHttpServerBounds {
  if (typeof options !== 'object' || options === null)
    throw new Error('HTTP server bounds must be an object');
  const headersTimeoutMs = integer(
    options.headersTimeoutMs,
    30_000,
    1_000,
    600_000,
    'headersTimeoutMs',
  );
  const requestTimeoutMs = integer(
    options.requestTimeoutMs,
    300_000,
    1_000,
    3_600_000,
    'requestTimeoutMs',
  );
  return Object.freeze({ headersTimeoutMs, requestTimeoutMs });
}

/**
 * Answer 408 when nothing was sent yet, then drop the connection. The socket
 * is destroyed once the answer is flushed, or after one second at most, so a
 * client that stops reading cannot keep it open.
 */
function expire(socket: Socket, response: ServerResponse | undefined): void {
  if (socket.destroyed) return;
  if (response?.headersSent || !socket.writable) {
    socket.destroy();
    return;
  }
  const force = setTimeout(() => socket.destroy(), 1_000);
  force.unref();
  socket.end(
    'HTTP/1.1 408 Request Timeout\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
    () => {
      clearTimeout(force);
      socket.destroy();
    },
  );
}

/**
 * Enforce `bounds` on a Node HTTP/1.1 server (Express and Fastify both run
 * one; `app.getHttpServer()` returns it). Call before `listen()`; repeated
 * calls on the same server keep the first bounds. Node's own
 * `headersTimeout` and `requestTimeout` are set to the same values as a
 * second line of defence. Returns the bounds in force.
 */
export function boundHttpServer(
  server: Server,
  options?: HttpServerBounds,
): NormalizedHttpServerBounds {
  const existing = bounded.get(server);
  if (existing) return existing;
  const bounds = normalizeHttpServerBounds(options);
  bounded.set(server, bounds);
  server.headersTimeout = bounds.headersTimeoutMs;
  server.requestTimeout = bounds.requestTimeoutMs;

  const head = new WeakMap<Socket, ReturnType<typeof setTimeout>>();
  const inFlight = new WeakMap<Socket, number>();
  const awaitHead = (socket: Socket) => {
    clearTimeout(head.get(socket));
    if (socket.destroyed) return;
    const timer = setTimeout(
      () => expire(socket, undefined),
      bounds.headersTimeoutMs,
    );
    timer.unref();
    head.set(socket, timer);
  };
  // TLS servers parse requests on the decrypted socket.
  server.on(
    server instanceof TlsServer ? 'secureConnection' : 'connection',
    (socket: Socket) => {
      awaitHead(socket);
      socket.once('close', () => clearTimeout(head.get(socket)));
    },
  );
  // An upgraded (WebSocket) or tunnelled connection leaves HTTP: its head
  // arrived, and the upgrade handler owns its lifetime from then on. The
  // listener is added only next to a host's own, because Node treats an
  // upgrade without any listener differently.
  const leaveHttp = (request: IncomingMessage) => {
    clearTimeout(head.get(request.socket));
    head.delete(request.socket);
  };
  const watching = new Set<string>();
  const watch = (name: string | symbol) => {
    if (typeof name !== 'string' || watching.has(name)) return;
    if (name !== 'upgrade' && name !== 'connect') return;
    watching.add(name);
    server.prependListener(name, leaveHttp);
  };
  for (const name of ['upgrade', 'connect'])
    if (server.listenerCount(name) > 0) watch(name);
  server.on('newListener', watch);
  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    const socket = request.socket;
    clearTimeout(head.get(socket));
    head.delete(socket);
    inFlight.set(socket, (inFlight.get(socket) ?? 0) + 1);
    // `complete` turns true once the parser has read the whole message,
    // whether or not the handler consumed the body stream.
    const body = setTimeout(() => {
      if (!request.complete) expire(socket, response);
    }, bounds.requestTimeoutMs);
    body.unref();
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(body);
      const left = (inFlight.get(socket) ?? 1) - 1;
      inFlight.set(socket, left);
      // A kept-alive connection must deliver its next head in time too.
      if (left === 0 && !socket.destroyed) awaitHead(socket);
    };
    response.once('finish', done);
    response.once('close', done);
  });
  return bounds;
}
