import type { INestApplication } from '@nestjs/common';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ExampleClient,
  decodeEntities,
  inputValue,
  liveReference,
  nextReference,
} from './support/example-client.js';
import type { LiveReference } from './support/example-client.js';

/*
 * DATA-017/018: one logged-in user context and one server-resolved tenant
 * across every transport of examples/multi-tenant (port 4026): MVC pages and
 * REST, Live, Inertia, server actions, islands, uploads, realtime and the
 * cache. Each block proves both cross-tenant and cross-user isolation, and
 * that no client-supplied tenant id is honoured.
 */

const port = 4026;
const base = `http://127.0.0.1:${port}`;
const password = 'demo-password-2026';
let app: INestApplication;
let data: string;

beforeAll(async () => {
  // examples/multi-tenant reads PORT when its config module loads.
  process.env['PORT'] = String(port);
  data = await mkdtemp(join(tmpdir(), 'nestvexa-multi-tenant-'));
  const { createApp } = await import('../examples/multi-tenant/dist/app.js');
  app = await createApp({ dataDirectory: data, logger: false });
  await app.listen(port, '127.0.0.1');
}, 120_000);
afterAll(async () => {
  await app.close();
  await rm(data, { recursive: true, force: true, maxRetries: 10 });
});

async function signIn(email: string): Promise<ExampleClient> {
  const client = new ExampleClient(base);
  const page = await client.get('/login');
  const response = await client.form('/login', {
    _csrf: inputValue(page.text, '_csrf'),
    email,
    password,
  });
  expect(response.headers.get('location')).toBe('/');
  return client;
}
/** Opens a workspace page (records it as the active tenant) and returns the board. */
async function openBoard(client: ExampleClient, tenant: string) {
  const page = await client.get(`/t/${tenant}/projects`);
  expect(page.status).toBe(200);
  return { html: page.text, board: liveReference(page.text, 'tenant-board') };
}
const attribute = (html: string, name: string) => {
  const value = new RegExp(`\\s${name}="([^"]*)"`).exec(html)?.[1];
  if (value === undefined) throw new Error(`Missing ${name}`);
  return decodeEntities(value);
};
const acmeNames = [
  'Warehouse robot firmware',
  'Assembly line audit',
  'Sensor calibration',
];
const globexNames = ['Route optimisation', 'Fleet telematics rollout'];
const mentionsAny = (text: string, names: readonly string[]) =>
  names.some((name) => text.includes(name));

async function projects(client: ExampleClient, tenant: string) {
  const reply = await client.get(`/api/t/${tenant}/projects`);
  expect(reply.status).toBe(200);
  return (reply.json()['projects'] as { name: string }[]).map((p) => p.name);
}

let max: ExampleClient; // Acme member
let ada: ExampleClient; // Acme admin
let liz: ExampleClient; // Globex member
let sam: ExampleClient; // member of both
beforeAll(async () => {
  max = await signIn('max@acme.test');
  ada = await signIn('ada@acme.test');
  liz = await signIn('liz@globex.test');
  sam = await signIn('sam@consult.test');
}, 120_000);

describe('MVC pages and REST', { timeout: 120_000 }, () => {
  it('serve a tenant only to its members and leak nothing to others', async () => {
    const guest = new ExampleClient(base);
    expect((await guest.get('/t/acme/projects')).headers.get('location')).toBe(
      '/login',
    );
    expect((await guest.get('/api/t/acme/projects')).status).toBe(401);
    const denied = await liz.get('/t/acme/projects');
    expect(denied.status).toBe(403);
    expect(mentionsAny(denied.text, acmeNames)).toBe(false);
    expect(denied.text).not.toContain('data-nv-snapshot');
    expect((await liz.get('/api/t/acme/projects')).status).toBe(403);
    // The tenant comes from the guarded route, never a query or header.
    const spoofed = await liz.get('/api/t/globex/projects?tenant=acme', {
      'x-tenant': 'acme',
    });
    expect(mentionsAny(spoofed.text, acmeNames)).toBe(false);
    expect(await projects(max, 'acme')).toEqual(
      expect.arrayContaining(acmeNames),
    );
  });
});

describe('Live components', { timeout: 120_000 }, () => {
  it('bind snapshots to user, tenant and session and re-check membership', async () => {
    let { board } = await openBoard(max, 'acme');
    const created = await max.live('tenant-board', 'create', board, {
      updates: { draftName: 'Max live project' },
    });
    expect(created.status, created.text).toBeLessThan(300);
    expect(created.text).toContain('Max live project was created.');
    board = nextReference(board, created);
    expect(await projects(max, 'acme')).toContain('Max live project');

    // Another tenant's member, and another user of the same tenant, cannot
    // replay Max's snapshot.
    await openBoard(liz, 'globex');
    for (const thief of [liz, ada]) {
      const replay = await thief.live('tenant-board', 'create', board, {
        updates: { draftName: 'Stolen project' },
      });
      expect(replay.status).toBeGreaterThanOrEqual(400);
    }
    // The tenant is not component state: a forged update is refused.
    const forged = await max.live('tenant-board', 'create', board, {
      updates: { tenant: 'globex', draftName: 'Forged' },
    });
    expect(forged.status).toBeGreaterThanOrEqual(400);
    expect(await projects(max, 'acme')).not.toContain('Stolen project');
    expect(await projects(liz, 'globex')).not.toContain('Stolen project');
  });

  it('invalidates a tenant snapshot when the user switches tenants', async () => {
    const acme = await openBoard(sam, 'acme');
    const globex = await openBoard(sam, 'globex');
    const stale = await sam.live('tenant-board', 'create', acme.board, {
      updates: { draftName: 'Wrong tenant' },
    });
    expect(stale.status).toBeGreaterThanOrEqual(400);
    const fresh = await sam.live('tenant-board', 'create', globex.board, {
      updates: { draftName: 'Sam globex project' },
    });
    expect(fresh.status, fresh.text).toBeLessThan(300);
    expect(await projects(liz, 'globex')).toContain('Sam globex project');
    expect(await projects(max, 'acme')).not.toContain('Sam globex project');
    expect(await projects(max, 'acme')).not.toContain('Wrong tenant');
  });
});

describe('Inertia pages', { timeout: 120_000 }, () => {
  const inertia = {
    'x-inertia': 'true',
    'x-inertia-version': 'multi-tenant-1',
  };
  it('share the same user context and scope props to the route tenant', async () => {
    const page = await max.get('/t/acme/report', inertia);
    expect(page.status, page.text).toBe(200);
    const body = page.json();
    expect(body['component']).toBe('Tenant/Report');
    const props = body['props'] as Record<string, unknown>;
    expect(props).toMatchObject({
      tenant: 'acme',
      userName: 'Max (Acme member)',
      tenantName: 'Acme Robotics',
      role: 'member',
    });
    expect(mentionsAny(page.text, globexNames)).toBe(false);
    const html = await max.get('/t/acme/report');
    expect(html.text).toContain('data-page');
    expect(html.text).toContain('Acme Robotics');

    const denied = await liz.get('/t/acme/report', inertia);
    expect(denied.status).toBe(403);
    expect(mentionsAny(denied.text, acmeNames)).toBe(false);
    expect(
      (await new ExampleClient(base).get('/t/acme/report', inertia)).status,
    ).toBe(303);
  });
});

describe('Server actions', { timeout: 120_000 }, () => {
  it('scope every call to the verified tenant and ignore client tenant ids', async () => {
    const { board } = await openBoard(max, 'acme');
    // Input on an action that takes none is refused outright.
    const smuggled = await max.action(
      'workspace/projects',
      { tenant: 'globex' },
      board.csrf,
    );
    expect(smuggled.status).toBe(400);
    expect(smuggled.json()).toMatchObject({
      error: { reason: 'UNEXPECTED_INPUT' },
    });
    const list = await max.action('workspace/projects', undefined, board.csrf);
    expect(list.status, list.text).toBe(200);
    expect(list.json()['data']).toMatchObject({ tenant: 'acme' });
    expect(mentionsAny(list.text, globexNames)).toBe(false);

    const created = await max.action(
      'workspace/create',
      { name: 'Action project', tenant: 'globex' },
      board.csrf,
    );
    expect(created.json()['data']).toMatchObject({
      name: 'Action project',
      tenant: 'acme',
    });
    expect(await projects(max, 'acme')).toContain('Action project');
    expect(await projects(liz, 'globex')).not.toContain('Action project');

    // A signed-in user without an opened workspace has no tenant.
    const fresh = await signIn('gus@globex.test');
    const csrf = inputValue((await fresh.get('/')).text, '_csrf');
    const none = await fresh.action('workspace/projects', undefined, csrf);
    expect(none.status).toBe(403);
    // Another user's CSRF token does not work in this session.
    expect(
      (await liz.action('workspace/projects', undefined, board.csrf)).status,
    ).toBe(403);
    const guest = new ExampleClient(base);
    const guestCsrf = inputValue((await guest.get('/login')).text, '_csrf');
    expect(
      (await guest.action('workspace/projects', undefined, guestCsrf)).status,
    ).toBe(403);
  });
});

describe('Islands', { timeout: 120_000 }, () => {
  it('render only the tenant data and refuse signed props from another tenant', async () => {
    const acme = (await openBoard(max, 'acme')).html;
    const globex = await openBoard(liz, 'globex');
    const acmeProps = attribute(acme, 'data-nv-props');
    const acmeToken = attribute(acme, 'data-nv-props-token');
    expect(JSON.parse(acmeProps)).toMatchObject({ tenant: 'acme' });
    expect(JSON.parse(attribute(globex.html, 'data-nv-props'))).toMatchObject({
      tenant: 'globex',
    });
    const own = await max.action(
      'workspace/island-stats',
      { props: acmeProps, token: acmeToken },
      liveReference(acme, 'tenant-board').csrf,
    );
    expect(own.status, own.text).toBe(200);
    // A valid signature proves origin, not permission.
    const foreign = await liz.action(
      'workspace/island-stats',
      { props: acmeProps, token: acmeToken },
      globex.board.csrf,
    );
    expect(foreign.status).toBe(403);
    expect(foreign.json()).toMatchObject({
      error: { reason: 'TENANT_MISMATCH' },
    });
    const tampered = await liz.action(
      'workspace/island-stats',
      {
        props: acmeProps.replace('"acme"', '"globex"'),
        token: acmeToken,
      },
      globex.board.csrf,
    );
    expect(tampered.json()).toMatchObject({
      error: { reason: 'ISLAND_SIGNATURE' },
    });
  });
});

describe('Uploads', { timeout: 120_000 }, () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('tenant-isolation-test-image'),
  ]);
  async function upload(client: ExampleClient, reference: LiveReference) {
    const reply = await client.request('POST', '/_nestvexa/uploads/files', {
      headers: {
        origin: base,
        'content-type': 'application/octet-stream',
        'x-nestvexa-csrf': reference.csrf,
        'x-nestvexa-upload-purpose': 'project.attachment',
        'x-nestvexa-upload-name': 'diagram.png',
      },
      body: png,
    });
    expect(reply.status, reply.text).toBeLessThan(300);
    return String(reply.json()['token']);
  }
  const attach = (
    client: ExampleClient,
    tenant: string,
    token: string,
    csrf: string,
  ) =>
    client.request('POST', `/t/${tenant}/attachments`, {
      headers: {
        origin: base,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token, _csrf: csrf }),
    });

  it('bind upload tokens to the uploading user and tenant', async () => {
    const maxBoard = (await openBoard(max, 'acme')).board;
    const lizBoard = (await openBoard(liz, 'globex')).board;
    const token = await upload(max, maxBoard);
    // Another tenant cannot attach Max's upload, to its own or Max's tenant.
    expect((await attach(liz, 'globex', token, lizBoard.csrf)).status).toBe(
      403,
    );
    expect((await attach(liz, 'acme', token, lizBoard.csrf)).status).toBe(403);
    // Another user of the same tenant cannot claim it either.
    const adaBoard = (await openBoard(ada, 'acme')).board;
    expect((await attach(ada, 'acme', token, adaBoard.csrf)).status).toBe(403);
    expect((await attach(max, 'acme', token, 'x'.repeat(43))).status).toBe(403);
    const attached = await attach(max, 'acme', token, maxBoard.csrf);
    expect(attached.status, attached.text).toBe(201);
    expect(
      (await max.get('/api/t/acme/attachments')).json()['attachments'],
    ).toEqual([{ name: 'diagram.png', size: png.byteLength }]);
    expect((await liz.get('/api/t/acme/attachments')).status).toBe(403);
    expect(
      (await liz.get('/api/t/globex/attachments')).json()['attachments'],
    ).toEqual([]);

    // A token uploaded in one tenant stops working after a tenant switch.
    const samAcme = (await openBoard(sam, 'acme')).board;
    const samToken = await upload(sam, samAcme);
    const samGlobex = (await openBoard(sam, 'globex')).board;
    expect((await attach(sam, 'globex', samToken, samGlobex.csrf)).status).toBe(
      403,
    );
    // Guests cannot upload at all.
    const guest = new ExampleClient(base);
    const guestCsrf = inputValue((await guest.get('/login')).text, '_csrf');
    const anonymous = await guest.request('POST', '/_nestvexa/uploads/files', {
      headers: {
        origin: base,
        'content-type': 'application/octet-stream',
        'x-nestvexa-csrf': guestCsrf,
        'x-nestvexa-upload-purpose': 'project.attachment',
        'x-nestvexa-upload-name': 'x.png',
      },
      body: png,
    });
    expect(anonymous.status).toBeGreaterThanOrEqual(400);
  });
});

describe('Realtime', { timeout: 120_000 }, () => {
  function poll(client: ExampleClient, token: string, signal?: AbortSignal) {
    return fetch(
      `${base}/_nestvexa/realtime/poll?t=${encodeURIComponent(token)}`,
      {
        headers: {
          cookie: `nvtenant.sid=${client.cookie('nvtenant.sid') ?? ''}`,
        },
        ...(signal ? { signal } : {}),
      },
    );
  }
  it('deliver tenant events only to that tenant and refuse borrowed tokens', async () => {
    const acme = await openBoard(max, 'acme');
    const globex = await openBoard(liz, 'globex');
    const acmeToken = attribute(acme.html, 'data-nv-realtime');
    const globexToken = attribute(globex.html, 'data-nv-realtime');
    // Tokens are identity-bound: Liz cannot use Max's, nor Ada (same tenant).
    expect((await poll(liz, acmeToken)).status).toBe(403);
    await openBoard(ada, 'acme');
    expect((await poll(ada, acmeToken)).status).toBe(403);

    const abort = new AbortController();
    const lizEvents = poll(liz, globexToken, abort.signal).then(
      async (response) => ({
        status: response.status,
        body: await response.text(),
      }),
      () => 'aborted' as const,
    );
    const maxEvents = poll(max, acmeToken).then((response) => response.json());
    await new Promise((resolve) => setTimeout(resolve, 300));
    await max.action(
      'workspace/create',
      { name: 'Realtime project' },
      acme.board.csrf,
    );
    const delivered = (await maxEvents) as { events?: unknown[] };
    expect(delivered.events?.length).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    abort.abort();
    // Liz's poll saw nothing from Acme (it was still waiting, or empty).
    const result = await lizEvents;
    if (result !== 'aborted') expect(result.body).not.toContain('acme');

    // A user who switched tenants loses the old tenant's token.
    const samAcme = attribute(
      (await openBoard(sam, 'acme')).html,
      'data-nv-realtime',
    );
    await openBoard(sam, 'globex');
    expect((await poll(sam, samAcme)).status).toBe(403);
  });
});

describe('Cache', { timeout: 120_000 }, () => {
  it('keys cached data by tenant, checks access first and invalidates on writes', async () => {
    const summary = async (client: ExampleClient, tenant: string) => {
      const reply = await client.get(`/api/t/${tenant}/summary`);
      return { status: reply.status, body: reply.json() };
    };
    const first = await summary(max, 'acme');
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body['summary']).toMatchObject({ tenant: 'acme' });
    const acmeNamesNow = (first.body['summary'] as { names: string[] }).names;
    expect(acmeNamesNow).toEqual(expect.arrayContaining(acmeNames));
    // Same tenant, another user: served from the tenant's cache entry.
    const second = await summary(ada, 'acme');
    expect(second.body['summary']).toEqual(first.body['summary']);
    const hits = (second.body['metrics'] as { hits: number }).hits;
    expect(hits).toBeGreaterThan(0);
    // Another tenant never receives the cached Acme value.
    const other = await summary(liz, 'globex');
    expect(other.body['summary']).toMatchObject({ tenant: 'globex' });
    expect(mentionsAny(JSON.stringify(other.body['summary']), acmeNames)).toBe(
      false,
    );
    // Cross-tenant requests are refused before the cache is consulted.
    const denied = await liz.get('/api/t/acme/summary');
    expect(denied.status).toBe(403);
    expect(mentionsAny(denied.text, acmeNames)).toBe(false);
    // A write invalidates the tenant's entry.
    const { board } = await openBoard(max, 'acme');
    await max.action('workspace/create', { name: 'Cache project' }, board.csrf);
    const after = await summary(max, 'acme');
    expect((after.body['summary'] as { names: string[] }).names).toContain(
      'Cache project',
    );
    expect(
      ((await summary(liz, 'globex')).body['summary'] as { names: string[] })
        .names,
    ).not.toContain('Cache project');
  });
});

describe('Cross-user role policy', { timeout: 120_000 }, () => {
  it('refuses a member forging an admin-only Live action in the same tenant', async () => {
    const page = await max.get('/t/acme/projects');
    const row = liveReference(page.text, 'tenant-project');
    const forged = await max.live('tenant-project', 'remove', row);
    expect(forged.status).toBe(403);
    expect(await projects(max, 'acme')).toEqual(
      expect.arrayContaining(acmeNames),
    );
  });
});
