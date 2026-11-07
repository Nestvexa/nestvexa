import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HttpSsrGateway,
  InertiaSsrError,
} from '../packages/inertia/dist/index.js';
import type { InertiaPageObject } from '../packages/inertia/dist/index.js';
import {
  S3Storage,
  UploadError,
  assertStorageKey,
} from '../packages/uploads/dist/index.js';

// SEC-029: SSRF. Every server-side outbound connection in the packages goes to
// a target fixed by host configuration (SSR gateway URL, S3 endpoint, ClamAV
// and Redis host/port). These tests prove request data (page props, component
// names, upload names, storage keys) cannot steer those connections, that
// redirects are never followed to another host, that responses are bounded,
// and that no new outbound primitive appears in package sources unreviewed.

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly host: string;
}
interface Fake {
  readonly url: string;
  readonly requests: Recorded[];
  readonly server: Server;
}
const servers: Server[] = [];
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
  for (const step of cleanup.splice(0)) await step();
});

async function fake(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<Fake> {
  const requests: Recorded[] = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? '',
      url: request.url ?? '',
      host: request.headers.host ?? '',
    });
    request.resume();
    request.on('end', () => handler(request, response));
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  return { url: `http://127.0.0.1:${address.port}`, requests, server };
}

function page(props: Record<string, unknown>, component = 'Home') {
  const value: InertiaPageObject = {
    component,
    props: { errors: {}, ...props },
    url: '/',
    version: 'v1',
  } as InertiaPageObject;
  return { value, json: JSON.stringify(value) };
}

async function ssrError(promise: Promise<unknown>): Promise<InertiaSsrError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof InertiaSsrError) return error;
    throw error;
  }
  throw new Error('Expected an SSR failure');
}

describe('Inertia SSR gateway (HttpSsrGateway)', () => {
  it.each([
    'file:///etc/passwd',
    'ftp://127.0.0.1/',
    'gopher://127.0.0.1:6379/_INFO',
    'data:text/plain,x',
    'javascript:alert(1)',
    'http://user:secret@127.0.0.1:13714',
    'http://127.0.0.1:13714/?target=http://169.254.169.254/',
    'http://127.0.0.1:13714/#fragment',
  ])('refuses the configured URL %s', (url) => {
    expect(() => new HttpSsrGateway({ url })).toThrow(TypeError);
  });

  it('always posts to the configured /render endpoint whatever the page contains', async () => {
    const ssr = await fake((_request, response) =>
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ head: [], body: '<div id="app"></div>' })),
    );
    const gateway = new HttpSsrGateway({ url: `${ssr.url}/ssr` });
    const hostile = page(
      {
        next: 'http://169.254.169.254/latest/meta-data/',
        avatar: '//internal.example/admin',
        file: 'file:///etc/passwd',
      },
      'http://evil.example/../../health',
    );
    await gateway.render(hostile.value, hostile.json);
    expect(ssr.requests).toEqual([
      {
        method: 'POST',
        url: '/ssr/render',
        host: new URL(ssr.url).host,
      },
    ]);
  });

  it('never follows a redirect from /render or /health to another host', async () => {
    const internal = await fake((_request, response) =>
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ status: 'OK', head: [], body: 'leak' })),
    );
    for (const status of [301, 302, 303, 307, 308]) {
      const redirecting = await fake((request, response) =>
        response
          .writeHead(status, {
            location: `${internal.url}${request.url ?? '/'}`,
          })
          .end(),
      );
      const gateway = new HttpSsrGateway({ url: redirecting.url });
      const hostile = page({});
      const error = await ssrError(gateway.render(hostile.value, hostile.json));
      expect(error.type).toBe('connection');
      expect(await gateway.health()).toBe(false);
      expect(redirecting.requests.map((request) => request.url)).toEqual([
        '/render',
        '/health',
      ]);
    }
    expect(internal.requests).toEqual([]);
  });

  it('stops reading an oversized or endless response instead of buffering it', async () => {
    let closed = false;
    const endless = await fake((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      const chunk = Buffer.alloc(16 * 1024, 0x20);
      const timer = setInterval(() => response.write(chunk), 1);
      request.socket.on('close', () => {
        closed = true;
        clearInterval(timer);
      });
    });
    const gateway = new HttpSsrGateway({
      url: endless.url,
      maxResponseBytes: 64 * 1024,
      timeoutMs: 10_000,
    });
    const hostile = page({});
    const started = Date.now();
    const error = await ssrError(gateway.render(hostile.value, hostile.json));
    expect(error.type).toBe('invalid-response');
    expect(error.message).toBe('SSR response too large');
    expect(Date.now() - started).toBeLessThan(5_000);
    await expect.poll(() => closed, { timeout: 2_000 }).toBe(true);

    const declared = await fake((_request, response) =>
      response
        .writeHead(200, {
          'content-type': 'application/json',
          'content-length': String(10 * 1024 * 1024),
        })
        .end('{}'),
    );
    const bounded = new HttpSsrGateway({
      url: declared.url,
      maxResponseBytes: 1024,
    });
    expect(
      (await ssrError(bounded.render(hostile.value, hostile.json))).type,
    ).toBe('invalid-response');
    const health = await fake((_request, response) =>
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ status: 'OK', padding: 'x'.repeat(8192) })),
    );
    expect(await new HttpSsrGateway({ url: health.url }).health()).toBe(false);
  });
});

describe('S3-compatible storage (S3Storage)', () => {
  const credentials = {
    accessKeyId: 'AKIDSSRFTEST',
    secretAccessKey: 'ssrf-test-secret-key-0123456789',
  };
  const key = 'ab/' + 'c'.repeat(43);

  it.each([
    'file:///var/data',
    'ftp://127.0.0.1',
    'http://user:pass@127.0.0.1:9000',
    'http://127.0.0.1:9000/bucket-path',
    'http://127.0.0.1:9000/?x=1',
    'http://127.0.0.1:9000/#x',
  ])('refuses the endpoint %s', (endpoint) => {
    expect(
      () =>
        new S3Storage({
          endpoint,
          region: 'eu-test-1',
          bucket: 'nestvexa-test',
          credentials,
        }),
    ).toThrow(/S3 endpoint/);
  });

  it.each([
    '../../../latest/meta-data',
    '@169.254.169.254/x',
    '//evil.example/aa',
    'ab/../../etc/passwd/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    'http://evil.example/',
    'ab/%2e%2e%2fxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    `ab/${'c'.repeat(42)}#`,
    `ab/${'c'.repeat(42)}?`,
  ])('refuses the object key %j before building a URL', (hostile) => {
    expect(() => assertStorageKey(hostile)).toThrow(/Invalid storage key/);
    const storage = new S3Storage({
      endpoint: 'http://127.0.0.1:9000',
      region: 'eu-test-1',
      bucket: 'nestvexa-test',
      credentials,
    });
    expect(() => storage.url(hostile)).toThrow(/Invalid storage key/);
  });

  it('keeps every object, presigned and download URL on the configured host', async () => {
    for (const forcePathStyle of [true, false]) {
      const storage = new S3Storage({
        endpoint: 'https://s3.eu-test-1.example.com',
        region: 'eu-test-1',
        bucket: 'nestvexa-test',
        credentials,
        forcePathStyle,
      });
      const host = forcePathStyle
        ? 's3.eu-test-1.example.com'
        : 'nestvexa-test.s3.eu-test-1.example.com';
      expect(storage.url(key).host).toBe(host);
      const upload = await storage.presignUpload(key, {
        contentType: 'image/png',
        size: 10,
        expiresInSeconds: 60,
      });
      expect(new URL(upload.url).host).toBe(host);
      const download = await storage.presignDownload(key, {
        filename: 'x@evil.example/\r\nLocation: http://evil.example/#?.png',
        contentType: 'image/png',
      });
      const url = new URL(download);
      expect(url.host).toBe(host);
      expect(url.pathname).toBe(
        forcePathStyle ? `/nestvexa-test/${key}` : `/${key}`,
      );
    }
  });

  it('does not follow storage redirects to another host', async () => {
    const internal = await fake((_request, response) =>
      response.writeHead(200, { 'content-length': '4' }).end('leak'),
    );
    const redirecting = await fake((request, response) =>
      response
        .writeHead(307, { location: `${internal.url}${request.url ?? '/'}` })
        .end(),
    );
    const storage = new S3Storage({
      endpoint: redirecting.url,
      region: 'eu-test-1',
      bucket: 'nestvexa-test',
      credentials,
    });
    const directory = await mkdtemp(join(tmpdir(), 'nestvexa-ssrf-s3-'));
    cleanup.push(async () => {
      if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
        throw new Error('Unexpected fixture directory');
      await rm(directory, { recursive: true, force: true });
    });
    const path = join(directory, 'object.bin');
    await writeFile(path, 'body');
    const failures: unknown[] = [];
    for (const operation of [
      () => storage.open(key),
      () => storage.stat(key),
      () => storage.delete(key),
      () =>
        storage.put(key, {
          path,
          size: 4,
          contentType: 'application/octet-stream',
          sha256:
            '230d8358dc8e8890b4c58deeb62912ee2f20357ae92a5cc861b98e68fe31acb5',
        }),
    ])
      await operation().catch((error: unknown) => failures.push(error));
    expect(failures).toHaveLength(4);
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(UploadError);
      expect((failure as UploadError).getStatus()).toBe(502);
    }
    expect(redirecting.requests.map((request) => request.method)).toEqual([
      'GET',
      'HEAD',
      'DELETE',
      'PUT',
    ]);
    expect(internal.requests).toEqual([]);
  });
});

// Static inventory of outbound network primitives in package sources. A new
// entry must be reviewed for SSRF (target from host configuration only, no
// redirects to other hosts, bounded responses) and added here with its reason.
const outbound: Readonly<Record<string, string>> = {
  'packages/inertia/src/ssr.ts:fetch':
    'HttpSsrGateway: configured SSR server URL; redirect: error; bounded body',
  'packages/uploads/src/s3.ts:node:http':
    'S3Storage: configured endpoint, generated keys; node:http never follows redirects',
  'packages/uploads/src/s3.ts:node:https': 'S3Storage over TLS (as above)',
  'packages/uploads/src/scanner.ts:node:net':
    'ClamdScanner: configured host/port or Unix socket',
  'packages/realtime/src/broker.ts:node:net':
    'Redis broker: configured host/port',
  'packages/realtime-redis/src/resp.ts:node:net':
    'Redis client: configured host/port',
  // Browser code: requests the page's own configured endpoints (same origin
  // unless the host configures otherwise); not server-side fetches.
  'packages/client/src/index.ts:window.fetch':
    'Live transport to the data-nv-endpoint of server-rendered markup',
  'packages/client/src/realtime.ts:EventSource':
    'Realtime SSE to the configured endpoint',
  'packages/client/src/realtime.ts:WebSocket':
    'Realtime WebSocket to the configured endpoint',
  'packages/client/src/upload.ts:XMLHttpRequest':
    'Live upload progress to the configured endpoint',
  'packages/uploads/src/browser/index.ts:XMLHttpRequest':
    'Browser upload client to the configured endpoint',
  'packages/actions/src/client/index.ts:globalThis.fetch':
    'Generated action client to the configured endpoint',
  // Source text of a generated test file, not executed by the package.
  'packages/cli/src/templates-app.ts:fetch':
    'Template for a generated e2e test hitting the generated app',
};

const primitives: readonly (readonly [string, RegExp])[] = [
  ['fetch', /(?<![.\w])fetch\(/],
  ['window.fetch', /\bwindow\.fetch\b/],
  ['globalThis.fetch', /\bglobalThis\.fetch\b/],
  [
    'node:http',
    /import\s*\{[^}]*\b(?:request|get|Agent)\b[^}]*\}\s*from\s*'node:http'/,
  ],
  [
    'node:https',
    /import\s*\{[^}]*\b(?:request|get|Agent)\b[^}]*\}\s*from\s*'node:https'/,
  ],
  [
    'node:net',
    /import\s*\{[^}]*\b(?:connect|createConnection|Socket)\b[^}]*\}\s*from\s*'node:net'/,
  ],
  ['node:tls', /from\s*'node:tls'/],
  ['node:http2', /from\s*'node:http2'/],
  ['node:dgram', /from\s*'node:dgram'/],
  ['EventSource', /new\s+(?:window\.)?EventSource\(/],
  ['WebSocket', /new\s+(?:window\.)?WebSocket\(/],
  ['XMLHttpRequest', /new\s+(?:window\.)?XMLHttpRequest\(/],
  ['sendBeacon', /\bsendBeacon\(/],
];

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sources(path)));
    else if (/\.(?:ts|tsx|vue|svelte|mjs|js)$/.test(entry.name))
      files.push(path);
  }
  return files;
}

describe('outbound network surface', () => {
  it('matches the reviewed inventory exactly', async () => {
    const workspace = resolve(import.meta.dirname, '..');
    const packages = await readdir(join(workspace, 'packages'), {
      withFileTypes: true,
    });
    const found = new Set<string>();
    for (const entry of packages) {
      if (!entry.isDirectory()) continue;
      const src = join(workspace, 'packages', entry.name, 'src');
      let files: string[];
      try {
        files = await sources(src);
      } catch {
        continue;
      }
      for (const file of files) {
        const text = await readFile(file, 'utf8');
        const name = relative(workspace, file).split(sep).join('/');
        for (const [label, pattern] of primitives)
          if (pattern.test(text)) found.add(`${name}:${label}`);
      }
    }
    expect([...found].sort()).toEqual(Object.keys(outbound).sort());
  }, 120_000);
});
