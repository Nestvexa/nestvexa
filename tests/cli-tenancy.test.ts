import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../packages/cli/dist/index.js';
import {
  boot,
  freshApp,
  idempotent,
  node,
  ok,
  read,
  repo,
  tsc,
} from './support/cli-fixture.js';
import type { BootedApp } from './support/cli-fixture.js';

// DX round 8 port range 4300-4319.
const port = 4302;

interface LiveResult {
  readonly status: number;
  readonly body: {
    readonly code?: string;
    readonly snapshot?: string;
    readonly component?: { readonly revision: number };
    readonly state?: {
      readonly tenant?: string;
      readonly notes?: readonly string[];
      readonly error?: string;
    };
  };
}

/** The component reference a Live request continues from. */
interface LiveSource {
  readonly snapshot: string;
  readonly csrf: string;
  readonly revision: number;
}
function mounted(html: string): LiveSource {
  return {
    snapshot: /data-nv-snapshot="([^"]+)"/.exec(html)?.[1] ?? '',
    csrf: /data-nv-csrf="([^"]+)"/.exec(html)?.[1] ?? '',
    revision: Number(/data-nv-revision="([0-9]+)"/.exec(html)?.[1] ?? 0),
  };
}
/** The next reference after a successful response. */
function after(source: LiveSource, result: LiveResult): LiveSource {
  return {
    ...source,
    snapshot: result.body.snapshot ?? '',
    revision: result.body.component?.revision ?? source.revision,
  };
}

/** One browser session: a cookie jar holding the express-session cookie. */
class Visitor {
  cookie = '';
  constructor(private readonly origin: string) {}
  async get(path: string): Promise<{ status: number; html: string }> {
    const response = await fetch(`${this.origin}${path}`, {
      headers: { cookie: this.cookie },
    });
    this.remember(response);
    return { status: response.status, html: await response.text() };
  }
  async post(
    path: string,
    form: Record<string, string>,
    headers: Record<string, string> = { origin: this.origin },
  ): Promise<Response> {
    const response = await fetch(`${this.origin}${path}`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie: this.cookie,
        'content-type': 'application/x-www-form-urlencoded',
        ...headers,
      },
      body: new URLSearchParams(form).toString(),
    });
    this.remember(response);
    return response;
  }
  /** GET /tenancy and select a tenant through the CSRF-checked form. */
  async select(tenant: string): Promise<string> {
    const page = await this.get('/tenancy');
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page.html)?.[1] ?? '';
    const response = await this.post('/tenancy/select', {
      _csrf: csrf,
      tenant,
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/tenancy');
    return csrf;
  }
  async live(
    source: LiveSource,
    action: string,
    updates: Record<string, unknown>,
    headers: Record<string, string> = {},
  ): Promise<LiveResult> {
    const response = await fetch(
      `${this.origin}/_nestvexa/live/tenant-notes/${action}`,
      {
        method: 'POST',
        headers: {
          cookie: this.cookie,
          origin: this.origin,
          'content-type': 'application/json',
          'x-nestvexa-csrf': source.csrf,
          ...headers,
        },
        body: JSON.stringify({
          protocol: 'nestvexa-live/1',
          requestId: crypto.randomUUID(),
          snapshot: source.snapshot,
          revision: source.revision,
          updates,
          input: null,
        }),
      },
    );
    return {
      status: response.status,
      body: (await response.json()) as LiveResult['body'],
    };
  }
  private remember(response: Response): void {
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    if (cookie) this.cookie = cookie;
  }
}

describe('nestvexa make:tenancy', { timeout: 600_000 }, () => {
  let root = '';
  let app: BootedApp | undefined;
  beforeAll(() => {
    root = freshApp('tenancy-app', { directory: 'cli-tenancy' });
  }, 120_000);
  afterAll(() => app?.stop());

  it('refuses to run before init without writing', () => {
    const result = run(['make:tenancy'], root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.join('\n')).toContain('run `nestvexa init` first');
    expect(read(root, 'src/app.module.ts')).not.toContain('Tenancy');
  });

  it('generates kernel tenant resolution, a tenant-scoped component and wiring, idempotently', () => {
    ok(run(['init'], root));
    idempotent(root, ['make:tenancy']);
    const module = read(root, 'src/app.module.ts');
    expect(module).toContain(
      'NestvexaModule.forRoot(nestvexaOptions, nestvexaLive, nestvexaKernel)',
    );
    expect(module).toContain('TenancyController');
    const kernel = read(root, 'src/nestvexa/extensions.ts');
    expect(kernel).toContain('requestContext: tenancyRequestContext');
    expect(kernel).toContain('global: true');
    const config = read(root, 'src/nestvexa/nestvexa.config.ts');
    expect(config).toContain('kernelIdentity: true');
    expect(config).toContain("'tenant-notes': ['$mount', 'add']");
    expect(config).toMatch(/TenancyModule,\n\s+\/\/ nestvexa:imports/);
    expect(config).toMatch(
      /TenantNotesComponent,\n\s+\/\/ nestvexa:components/,
    );
    // The tenant is never read from headers, query strings or bodies.
    const context = read(root, 'src/nestvexa/tenancy/tenancy.ts');
    expect(context).not.toMatch(
      /request\.(?:headers|query|body)|Reflect\.get\(request, '(?:headers|query|body)'\)/,
    );
    expect(read(root, 'package.json')).toContain('"vitest"');
    const compiled = tsc(root);
    expect(compiled.status, compiled.output).toBe(0);
  });

  it('passes the generated isolation test', () => {
    writeFileSync(
      join(root, 'vitest.config.mjs'),
      "export default { test: { include: ['dist/src/**/tenancy.spec.js'] } };\n",
    );
    const result = node(
      [
        join(repo, 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        '--root',
        root,
        '--config',
        'vitest.config.mjs',
        '--reporter',
        'dot',
        '--no-color',
      ],
      root,
    );
    expect(result.status, result.output).toBe(0);
    expect(result.output).toMatch(/Tests\s+3 passed/);
  }, 120_000);

  it('boots and keeps each tenant isolated across sessions, forged input and tenant switches', async () => {
    app = await boot(root, port);
    const origin = app.origin;
    const alice = new Visitor(origin);
    const bob = new Visitor(origin);

    const empty = await alice.get('/tenancy');
    expect(empty.status).toBe(200);
    expect(empty.html).toContain('Choose a tenant to see its notes.');
    expect(empty.html).not.toContain('data-nv-name="tenant-notes"');

    // The selection form needs the session CSRF token, the same origin and a known tenant.
    const csrf = /name="_csrf" value="([^"]+)"/.exec(empty.html)?.[1] ?? '';
    expect(
      (await alice.post('/tenancy/select', { tenant: 'acme' })).status,
    ).toBe(403);
    expect(
      (
        await alice.post(
          '/tenancy/select',
          { _csrf: csrf, tenant: 'acme' },
          { origin: 'https://attacker.example' },
        )
      ).status,
    ).toBe(403);
    expect(
      (await alice.post('/tenancy/select', { _csrf: csrf, tenant: 'initech' }))
        .status,
    ).toBe(400);

    await alice.select('acme');
    const acme = await alice.get('/tenancy');
    expect(acme.html).toContain('data-nv-name="tenant-notes"');
    expect(acme.html).toContain('Notes for acme');
    const aliceAcme = mounted(acme.html);
    const added = await alice.live(aliceAcme, 'add', { draft: 'Acme secret' });
    expect(added.status).toBe(201);
    expect(added.body.state).toMatchObject({
      tenant: 'acme',
      notes: ['Acme secret'],
    });

    await bob.select('globex');
    const globex = await bob.get('/tenancy');
    expect(globex.html).toContain('Notes for globex');
    expect(globex.html).toContain('No notes in this tenant yet.');
    expect(globex.html).not.toContain('Acme secret');
    // Forged tenant input: a header is ignored and the state field is not writable.
    const bobGlobex = mounted(globex.html);
    const forgedHeader = await bob.live(
      bobGlobex,
      'add',
      { draft: 'Globex note' },
      { 'x-tenant': 'acme', 'x-nestvexa-tenant': 'acme' },
    );
    expect(forgedHeader.status).toBe(201);
    expect(forgedHeader.body.state).toMatchObject({
      tenant: 'globex',
      notes: ['Globex note'],
    });
    const forgedState = await bob.live(after(bobGlobex, forgedHeader), 'add', {
      tenant: 'acme',
      draft: 'x',
    });
    expect(forgedState.status).toBe(422);
    expect(forgedState.body.code).toBe('STATE_LOCKED');
    // Another session cannot use alice's component snapshot.
    expect(
      (
        await bob.live(after(aliceAcme, added), 'add', {
          draft: 'cross-session',
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);

    // A snapshot minted in one tenant is refused after the session switches tenant.
    await alice.select('globex');
    const replay = await alice.live(after(aliceAcme, added), 'add', {
      draft: 'replayed',
    });
    expect(replay.status).toBeGreaterThanOrEqual(400);
    const switched = await alice.get('/tenancy');
    expect(switched.html).toContain('Notes for globex');
    expect(switched.html).toContain('Globex note');
    expect(switched.html).not.toContain('Acme secret');
    expect(switched.html).not.toContain('replayed');
    expect(switched.html).not.toContain('cross-session');

    // Back in acme only acme's note exists.
    await alice.select('acme');
    const back = await alice.get('/tenancy');
    expect(back.html).toContain('Acme secret');
    expect(back.html).not.toContain('Globex note');
  });
});
