/**
 * PROT-018 asset-version mismatch: the server stamps its asset version on
 * every component root, requires it back in `x-nestvexa-asset-version`, and
 * answers a mismatch with `409 ASSET_VERSION_MISMATCH` plus a reload header.
 */
import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Action,
  LIVE_ERROR_CODES,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  State,
} from '../packages/live/dist/index.js';
import {
  application,
  cleanup,
  csrf,
  envelope,
  marker,
  origin,
  platforms,
  policies,
  renderer,
} from './support/live-fixture.js';

afterEach(cleanup);

let runs = 0;
@LiveComponent({ name: 'versioned', view: 'versioned' })
class Versioned {
  @State() count = 0;
  @Action() increment(): void {
    runs++;
    this.count++;
  }
}

describe('asset version option validation', () => {
  it('rejects malformed versions at registration', async () => {
    const { engine } = await renderer({ versioned: '{{count}}' });
    for (const assetVersion of ['', 'has space', 'x'.repeat(129), '<v>'])
      expect(() =>
        LiveModule.register({
          ...policies(engine),
          components: [Versioned],
          assetVersion,
        }),
      ).toThrow(/assetVersion/);
  });
});

describe.each(platforms)('asset version mismatch: %s', (platform) => {
  async function fixture() {
    runs = 0;
    const { engine, module, resource } = await renderer({
      versioned: '<p>{{count}}</p>',
    });
    const app = await application(
      platform,
      [
        LiveModule.registerAsync({
          components: [Versioned],
          imports: [module],
          useFactory: () => ({ ...policies(engine), assetVersion: 'build.42' }),
        }),
      ],
      [],
      resource,
    );
    const html = (await app.get(LiveRuntime).mount(Versioned, { headers: {} }))
      .value;
    const call = async (headers: Record<string, string>) => {
      const response = await fetch(
        `${await app.getUrl()}/_nestvexa/live/versioned/increment`,
        {
          method: 'POST',
          headers: {
            origin,
            'content-type': 'application/json',
            'x-nestvexa-csrf': csrf,
            ...headers,
          },
          body: JSON.stringify(envelope(marker(html))),
        },
      );
      return {
        status: response.status,
        reload: response.headers.get('x-nestvexa-reload'),
        body: (await response.json()) as Record<string, unknown>,
      };
    };
    return { html, call };
  }

  it('renders the version and accepts only requests that echo it', async () => {
    const { html, call } = await fixture();
    expect(html).toContain('data-nv-asset-version="build.42"');
    for (const headers of [{}, { 'x-nestvexa-asset-version': 'build.41' }]) {
      const stale = await call(headers);
      expect(stale).toMatchObject({
        status: 409,
        reload: 'asset-version',
        body: { statusCode: 409, code: 'ASSET_VERSION_MISMATCH' },
      });
      // Nothing but the code: no versions or internals in the body.
      expect(Object.keys(stale.body).sort()).toEqual(['code', 'statusCode']);
    }
    expect(runs).toBe(0);
    const current = await call({ 'x-nestvexa-asset-version': 'build.42' });
    expect(current.status).toBe(201);
    expect(current.reload).toBeNull();
    expect(runs).toBe(1);
  });

  it('checks CSRF first, so foreign pages never receive a reload instruction', async () => {
    const { call } = await fixture();
    const forged = await call({ 'x-nestvexa-csrf': 'wrong' });
    expect(forged.status).toBe(403);
    expect(forged.body).toMatchObject({ code: 'CSRF_REJECTED' });
    expect(forged.reload).toBeNull();
    expect(runs).toBe(0);
  });

  it('is catalogued with the reload recovery', () => {
    expect(LIVE_ERROR_CODES.ASSET_VERSION_MISMATCH).toMatchObject({
      status: 409,
      recovery: 'reload',
    });
  });
});
