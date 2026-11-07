import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { API_KEY } from '../examples/api-coexistence/src/contract.js';
import { connectItemsClient } from '../examples/api-coexistence/src/client.js';
import type { ItemsClient } from '../examples/api-coexistence/src/client.js';

// VISION-018: REST, GraphQL, a TCP microservice, a Nest WebSocket gateway
// and Nestvexa (page, Live actions, realtime) in one Nest application. Each
// side answers exactly as it would alone, and neither side's guards apply to
// the other's routes. The built example runs as its own process (its
// GraphQL/microservice/WebSocket packages are devDependencies of the example
// only). Ports stay inside 3886-3895.

const root = fileURLToPath(
  new URL('../examples/api-coexistence/', import.meta.url),
);

/** Start `dist/main.js` and wait until its HTTP health route answers. */
async function start(
  env: Record<string, string>,
  origin: string,
): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: root,
    // A plain production process: no test-runner NODE_OPTIONS or NODE_ENV.
    env: { ...process.env, NODE_OPTIONS: '', NODE_ENV: 'production', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout?.on('data', (chunk: Buffer) => (logs += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (logs += chunk.toString()));
  // Generous for loaded CI hosts; failures report the server output.
  const deadline = Date.now() + 480_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    const ready = await fetch(`${origin}/api/health`).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) return child;
    await new Promise((done) => setTimeout(done, 100));
  }
  child.kill();
  throw new Error(
    `api-coexistence did not start (exit ${String(child.exitCode)}): ${logs}`,
  );
}

interface Fixture {
  readonly app: ChildProcess;
  readonly origin: string;
  readonly client: ItemsClient;
  readonly gatewayUrl: string;
}

async function graphql(
  origin: string,
  query: string,
  variables: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${origin}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ query, variables }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

/** One request/response exchange on a fresh WebSocket. */
function exchange(url: string, message: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('WebSocket exchange timed out'));
    }, 5000);
    socket.once('open', () => socket.send(JSON.stringify(message)));
    socket.once('message', (data: Buffer) => {
      clearTimeout(timer);
      socket.close();
      resolve(JSON.parse(data.toString('utf8')));
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Outcome of a WebSocket upgrade: the close code/reason, or a failed upgrade. */
function upgradeOutcome(
  url: string,
  origin: string,
  first?: unknown,
): Promise<string> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { origin });
    const timer = setTimeout(() => {
      socket.terminate();
      resolve('timeout');
    }, 8000);
    socket.once('open', () => {
      if (first !== undefined) socket.send(JSON.stringify(first));
    });
    socket.once('close', (code: number, reason: Buffer) => {
      clearTimeout(timer);
      resolve(`close ${code} ${reason.toString('utf8')}`);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve('upgrade failed');
    });
  });
}

/** Mount the Live page, then run one Live action with the session cookie. */
async function liveRefresh(origin: string): Promise<{
  status: number;
  count: unknown;
  pageHeaders: Headers;
}> {
  const page = await fetch(`${origin}/`);
  const html = await page.text();
  expect(page.status, html).toBe(200);
  const cookie = page.headers.get('set-cookie')?.split(';')[0] ?? '';
  const snapshot = /data-nv-snapshot="([^"]+)"/.exec(html)?.[1];
  const csrf = /data-nv-csrf="([^"]+)"/.exec(html)?.[1] ?? '';
  const response = await fetch(`${origin}/_nestvexa/live/inventory/refresh`, {
    method: 'POST',
    headers: {
      origin,
      cookie,
      'content-type': 'application/json',
      'x-nestvexa-csrf': csrf,
    },
    body: JSON.stringify({
      protocol: 'nestvexa-live/1',
      requestId: crypto.randomUUID(),
      snapshot,
      revision: 0,
      updates: {},
      input: null,
    }),
  });
  const body = (await response.json()) as { state?: { count?: unknown } };
  return {
    status: response.status,
    count: body.state?.count,
    pageHeaders: page.headers,
  };
}

describe.each([
  { label: 'gateway on the shared HTTP port', port: 3886, gateway: 'shared' },
  { label: 'gateway on its own port', port: 3890, gateway: 3892 },
] as const)('API coexistence ($label)', ({ port, gateway }) => {
  let fixture: Fixture;
  beforeAll(async () => {
    const origin = `http://127.0.0.1:${port}`;
    const app = await start(
      {
        PORT: String(port),
        MICROSERVICE_PORT: String(port + 1),
        ...(gateway === 'shared' ? {} : { GATEWAY_PORT: String(gateway) }),
      },
      origin,
    );
    const client = await connectItemsClient(port + 1);
    fixture = {
      app,
      client,
      origin,
      gatewayUrl: `ws://127.0.0.1:${gateway === 'shared' ? port : gateway}/ws/items`,
    };
  }, 540_000);
  afterAll(async () => {
    await fixture?.client.close();
    fixture?.app.kill();
  });

  it('serves REST JSON untouched, with the host guard on its own route only', async () => {
    const { origin } = fixture;
    const list = await fetch(`${origin}/api/items`);
    expect(list.status).toBe(200);
    expect(list.headers.get('content-type')).toMatch(/^application\/json/);
    // No Nestvexa session, CSP or Inertia headers on API responses.
    expect(list.headers.get('set-cookie')).toBeNull();
    expect(list.headers.get('content-security-policy')).toBeNull();
    expect(list.headers.get('x-inertia')).toBeNull();
    expect(await list.json()).toEqual(
      expect.arrayContaining([{ id: '1', name: 'Existing item' }]),
    );
    const denied = await fetch(`${origin}/api/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'REST item' }),
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ statusCode: 403 });
    const created = await fetch(`${origin}/api/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ name: 'REST item' }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ name: 'REST item' });
    // Unknown API paths keep Nest's JSON 404, not an HTML page.
    const missing = await fetch(`${origin}/api/missing`, {
      headers: { accept: 'application/json' },
    });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toMatch(/^application\/json/);
  });

  it('answers GraphQL queries and applies the GraphQL guard to mutations', async () => {
    const { origin } = fixture;
    const query = await graphql(origin, '{ items { id name } }');
    expect(query.status).toBe(200);
    expect(query.body['errors']).toBeUndefined();
    expect(Reflect.get(Object(query.body['data']), 'items')).toEqual(
      expect.arrayContaining([{ id: '1', name: 'Existing item' }]),
    );
    const mutation =
      'mutation Add($name: String!) { addItem(name: $name) { id name } }';
    const denied = await graphql(origin, mutation, { name: 'Graph item' });
    expect(JSON.stringify(denied.body['errors'])).toMatch(/Forbidden|API key/i);
    const allowed = await graphql(
      origin,
      mutation,
      { name: 'Graph item' },
      { 'x-api-key': API_KEY },
    );
    expect(allowed.body['errors']).toBeUndefined();
    expect(Reflect.get(Object(allowed.body['data']), 'addItem')).toMatchObject({
      name: 'Graph item',
    });
    // Apollo's own CSRF prevention still runs: a simple cross-site style
    // GET with a mutation is refused by GraphQL, not by Nestvexa.
    const get = await fetch(
      `${origin}/graphql?query=${encodeURIComponent('{ items { id } }')}`,
    );
    expect(get.status).toBe(400);
  });

  it('serves the TCP microservice from the same application and domain service', async () => {
    const { client, origin } = fixture;
    const before = await client.count();
    expect(await client.add('Message item')).toMatchObject({
      name: 'Message item',
    });
    expect(await client.count()).toBe(before + 1);
    // The REST view sees the same in-memory service instance.
    const items = (await (await fetch(`${origin}/api/items`)).json()) as {
      name: string;
    }[];
    expect(items.map((item) => item.name)).toContain('Message item');
  });

  it('answers the Nest WebSocket gateway', async () => {
    const reply = await exchange(fixture.gatewayUrl, {
      event: 'items',
      data: {},
    });
    expect(reply).toMatchObject({ event: 'items' });
    expect(Reflect.get(Object(reply), 'data')).toEqual(
      expect.arrayContaining([{ id: '1', name: 'Existing item' }]),
    );
  });

  it('runs the Nestvexa page and Live pipeline without the API guards', async () => {
    const { origin } = fixture;
    // No x-api-key: the host's API guards are route-scoped and never see Live.
    const result = await liveRefresh(origin);
    expect(result.status).toBe(201);
    const count = (await (await fetch(`${origin}/api/items`)).json()) as [];
    expect(result.count).toBe(count.length);
    expect(result.pageHeaders.get('content-type')).toMatch(/^text\/html/);
    // Nestvexa still enforces its own protocol checks on the shared server.
    const forged = await fetch(`${origin}/_nestvexa/live/inventory/refresh`, {
      method: 'POST',
      headers: {
        origin: 'http://evil.invalid',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect([400, 401, 403]).toContain(forged.status);
    // The realtime HTTP transports answer on their own path.
    const sse = await fetch(`${origin}/_nestvexa/realtime/poll`);
    expect(sse.status).toBeGreaterThanOrEqual(400);
    expect(sse.status).toBeLessThan(500);
  });

  it(
    gateway === 'shared'
      ? 'documents that a shared-port WsAdapter owns every upgrade on that server'
      : 'runs the Nestvexa realtime WebSocket transport beside a gateway on its own port',
    async () => {
      const { origin } = fixture;
      const outcome = await upgradeOutcome(
        `ws://127.0.0.1:${port}/_nestvexa/realtime/ws`,
        origin,
        { tokens: ['not-a-token'] },
      );
      if (gateway === 'shared')
        // Nest's WsAdapter destroys upgrades for paths it does not own, so
        // Nestvexa does not attach its WebSocket transport here (SSE/polling).
        expect(outcome).toBe('upgrade failed');
      // Nestvexa's handler accepted the upgrade and rejected the bad token.
      else expect(outcome).toMatch(/^close 4003 /);
      // A wrong Origin is refused by Nestvexa, not passed to the gateway.
      if (gateway !== 'shared')
        expect(
          await upgradeOutcome(
            `ws://127.0.0.1:${port}/_nestvexa/realtime/ws`,
            'http://evil.invalid',
          ),
        ).toBe('upgrade failed');
    },
  );
});
