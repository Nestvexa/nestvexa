import { createServer, request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { connect } from 'node:net';

/*
 * Development stand-in for a load balancer in front of two replicas (use
 * nginx, HAProxy or a cloud load balancer in production). Requests go to
 * replica A unless the `nv_replica=b` cookie selects B, so tests can pin or
 * move a browser between replicas. SSE streams and WebSocket upgrades are
 * proxied; responses carry `x-nestvexa-replica`.
 */
const port = Number(process.env['PROXY_PORT'] ?? 3222);
const targets: Record<string, URL> = {
  a: new URL(process.env['TARGET_A'] ?? 'http://127.0.0.1:3220'),
  b: new URL(process.env['TARGET_B'] ?? 'http://127.0.0.1:3221'),
};
function pick(headers: IncomingHttpHeaders): { name: string; url: URL } {
  const cookie = headers.cookie ?? '';
  const name = /(?:^|;\s*)nv_replica=b(?:;|$)/.test(cookie) ? 'b' : 'a';
  const url = targets[name];
  if (!url) throw new Error('Unknown replica');
  return { name, url };
}

const server = createServer((request, response) => {
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
  console.log(`Replica proxy: http://127.0.0.1:${port} -> a, b`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => server.close(() => process.exit(0)));
