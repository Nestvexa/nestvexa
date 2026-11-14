/**
 * `STALE_REVISION` recovery: the reply carries `x-nestvexa-recovery: resync`
 * (browsers never parse error bodies), and a `$sync` marked
 * `x-nestvexa-resync: 1` without updates re-renders the caller's current state
 * at its current revision, read-only (see tests/live-refresh.test.ts). Nothing from the client is written, no action runs.
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
@LiveComponent({ name: 'stale-counter', view: 'stale-counter' })
class StaleCounter {
  @State() count = 0;
  @State({ writable: true }) note = '';
  @Action() increment(): void {
    runs++;
    this.count++;
  }
}

interface Reply {
  readonly status: number;
  readonly recovery: string | null;
  readonly body: Record<string, unknown>;
}

describe.each(platforms)('stale revision recovery: %s', (platform) => {
  async function fixture() {
    runs = 0;
    const { engine, module, resource } = await renderer({
      'stale-counter': '<p>{{count}} {{note}}</p>',
    });
    const app = await application(
      platform,
      [
        LiveModule.registerAsync({
          components: [StaleCounter],
          imports: [module],
          useFactory: () => policies(engine),
        }),
      ],
      [],
      resource,
    );
    const html = (
      await app.get(LiveRuntime).mount(StaleCounter, { headers: {} })
    ).value;
    const reference = marker(html);
    const post = async (
      action: string,
      body: unknown,
      headers: Record<string, string> = {},
    ): Promise<Reply> => {
      const response = await fetch(
        `${await app.getUrl()}/_nestvexa/live/stale-counter/${action}`,
        {
          method: 'POST',
          headers: {
            origin,
            'content-type': 'application/json',
            'x-nestvexa-csrf': csrf,
            ...headers,
          },
          body: JSON.stringify(body),
        },
      );
      return {
        status: response.status,
        recovery: response.headers.get('x-nestvexa-recovery'),
        body: (await response.json()) as Record<string, unknown>,
      };
    };
    // Another tab (or a cut reply) commits revision + 1.
    const committed = await post('increment', envelope(reference));
    expect(committed.status).toBe(201);
    expect(runs).toBe(1);
    return { reference, post };
  }

  it('marks STALE_REVISION with the resync hint and runs nothing', async () => {
    const { reference, post } = await fixture();
    for (const [action, body] of [
      ['increment', envelope(reference)],
      ['_sync', envelope(reference, { updates: { note: 'late' } })],
    ] as const) {
      const stale = await post(action, body);
      expect(stale).toMatchObject({
        status: 409,
        recovery: 'resync',
        body: { statusCode: 409, code: 'STALE_REVISION' },
      });
      expect(Object.keys(stale.body).sort()).toEqual(['code', 'statusCode']);
    }
    expect(runs).toBe(1);
  });

  it('never sends the hint for other failures', async () => {
    const { reference, post } = await fixture();
    const forged = await post('increment', envelope(reference), {
      'x-nestvexa-csrf': 'wrong',
    });
    expect(forged).toMatchObject({ status: 403, recovery: null });
    const unknown = await post('missing', envelope(reference));
    expect(unknown.status).toBe(404);
    expect(unknown.recovery).toBeNull();
  });

  it('re-renders current state for an explicit resync without updates', async () => {
    const { reference, post } = await fixture();
    const resync = await post('_sync', envelope(reference), {
      'x-nestvexa-resync': '1',
    });
    expect(resync.status).toBe(201);
    expect(resync.recovery).toBeNull();
    expect(resync.body).toMatchObject({
      // Read-only: the committed revision, not a new one.
      component: { revision: reference.revision + 1 },
      state: { count: 1, note: '' },
    });
    expect(String(resync.body['html'])).toContain('<p>1 </p>');
    expect(runs).toBe(1);
  });

  it('rejects resync requests that would write state or run an action', async () => {
    const { reference, post } = await fixture();
    const cases: [string, unknown, string][] = [
      ['_sync', envelope(reference, { updates: { note: 'overwrite' } }), '1'],
      ['increment', envelope(reference), '1'],
      ['_sync', envelope(reference), 'true'],
    ];
    for (const [action, body, value] of cases) {
      const rejected = await post(action, body, { 'x-nestvexa-resync': value });
      expect(rejected).toMatchObject({
        status: 400,
        body: { code: 'INVALID_REQUEST' },
      });
    }
    // CSRF is still checked first.
    const forged = await post('_sync', envelope(reference), {
      'x-nestvexa-resync': '1',
      'x-nestvexa-csrf': 'wrong',
    });
    expect(forged.status).toBe(403);
    expect(runs).toBe(1);
    // State is unchanged: a fresh resync still shows the committed value.
    const resync = await post('_sync', envelope(reference), {
      'x-nestvexa-resync': '1',
    });
    expect(resync.body).toMatchObject({ state: { count: 1, note: '' } });
  });

  it('is catalogued with the resync recovery', () => {
    expect(LIVE_ERROR_CODES.STALE_REVISION).toMatchObject({
      status: 409,
      recovery: 'resync',
    });
  });
});
