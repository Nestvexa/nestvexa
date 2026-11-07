import { createServer, request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';

/*
 * Development stand-in for a load balancer in front of the replicas (use
 * nginx, HAProxy or a cloud load balancer in production). Requests go to
 * replica a unless the `nv_replica` cookie selects b, c or d (configured with
 * TARGET_B..TARGET_D), so tests can pin or move a browser between replicas.
 * SSE streams and WebSocket upgrades are proxied; responses carry
 * `x-nestvexa-replica`. `POST /__proxy/drop` cuts every open upstream
 * connection, like a load balancer restart, so tests can exercise reconnects.
 */
const port = Number(process.env['PROXY_PORT'] ?? 3222);
const targets = new Map<string, URL>();
for (const name of ['a', 'b', 'c', 'd']) {
  const fallback = { a: 'http://127.0.0.1:3220', b: 'http://127.0.0.1:3221' }[
    name
  ];
  const value = process.env[`TARGET_${name.toUpperCase()}`] ?? fallback;
  if (value) targets.set(name, new URL(value));
}
function pick(headers: IncomingHttpHeaders): { name: string; url: URL } {
  const cookie = headers.cookie ?? '';
  const chosen = /(?:^|;\s*)nv_replica=([a-d])(?:;|$)/.exec(cookie)?.[1];
  const name = chosen && targets.has(chosen) ? chosen : 'a';
  const url = targets.get(name);
  if (!url) throw new Error('Unknown replica');
  return { name, url };
}
/** Open client connections (streams and sockets) that `drop` cuts. */
const open = new Set<Duplex>();
function track(socket: Duplex): void {
  open.add(socket);
  socket.once('close', () => open.delete(socket));
}

const server = createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/__proxy/drop') {
    const dropped = open.size;
    for (const socket of open) if (socket !== request.socket) socket.destroy();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ dropped }));
    return;
  }
  track(request.socket);
  const target = pick(request.headers);
  const upstream = httpRequest(
    {
      host: target.url.hostname,
      port: target.url.port,
      method: request.method,
      path: request.url,
      headers: request.headers,
    },
    (reply) => {
      response.writeHead(reply.statusCode ?? 502, {
        ...reply.headers,
        'x-nestvexa-replica': target.name,
      });
      reply.pipe(response);
    },
  );
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  // A closed browser connection releases the upstream stream (SSE, long-poll).
  response.on('close', () => upstream.destroy());
  request.pipe(upstream);
});
server.on('upgrade', (request, socket, head) => {
  track(socket);
  const target = pick(request.headers);
  const upstream = connect(Number(target.url.port), target.url.hostname, () => {
    const lines = [`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/1.1`];
    for (let index = 0; index < request.rawHeaders.length; index += 2)
      lines.push(
        `${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`,
      );
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const close = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on('error', close);
  socket.on('error', close);
  upstream.on('close', close);
  socket.on('close', close);
});
server.listen(port, '127.0.0.1', () => {
  console.log(
    `Replica proxy: http://127.0.0.1:${port} -> ${[...targets.keys()].join(', ')}`,
  );
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => server.close(() => process.exit(0)));
