/**
 * Read-only refresh (PROT-017): a `$sync` marked `x-nestvexa-resync: 1`
 * without updates renders the stored state at its stored revision. It never
 * opens a store transaction, never advances the revision, never stores state
 * that hooks derive while rendering and never mounts, removes or re-props a
 * child (`409 REFRESH_CONFLICT` with `x-nestvexa-recovery: commit`). The
 * committing resync (`x-nestvexa-resync: commit`) is the explicit mutating
 * fallback. Express and Fastify.
 */
import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Action,
  LIVE_ERROR_CODES,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  Computed,
  Reactive,
  State,
  dispatchLiveEvent,
} from '../packages/live/dist/index.js';
import {
  application,
  cleanup,
  envelope,
  marker,
  platforms,
  policies,
  renderer,
  send,
} from './support/live-fixture.js';
import { memoryStore } from './support/memory-store.js';

afterEach(cleanup);

/** External data a component re-reads on every render (a database stand-in). */
const source = {
  value: 1,
  status: 'open',
  ids: ['a', 'b'],
  title: 'first',
  emit: false,
};
let runs = 0;
let hydrates = 0;

@LiveComponent({ name: 'refresh-feed', view: 'refresh-feed' })
class RefreshFeed {
  @State() count = 0;
  @State({ writable: true }) note = '';
  /** Copied into state in `dehydrate`: a change must be committed. */
  @State() status = 'open';
  hydrate(): void {
    hydrates++;
  }
  /** Re-read on every render; never stored. */
  @Computed() get latest(): number {
    return source.value;
  }
  dehydrate(): void {
    this.status = source.status;
    // Effects queued while refreshing are discarded, never delivered.
    if (source.emit) dispatchLiveEvent(this, 'feed.rendered', { at: 1 });
  }
  @Action() increment(): void {
    runs++;
    this.count++;
  }
}

@LiveComponent({ name: 'refresh-item', view: 'refresh-item' })
class RefreshItem {
  @Reactive() @State() title = '';
}

@LiveComponent({
  name: 'refresh-list',
  view: 'refresh-list',
  children: { item: RefreshItem },
})
class RefreshList {
  @State() label = 'list';
  /** Children follow external data; the stored state never changes. */
  @Computed() get items(): { id: string; title: string }[] {
    return source.ids.map((id) => ({ id, title: source.title }));
  }
}

describe.each(platforms)('read-only refresh: %s', (platform) => {
  async function fixture() {
    runs = 0;
    hydrates = 0;
    source.value = 1;
    source.status = 'open';
    source.ids = ['a', 'b'];
    source.title = 'first';
    source.emit = false;
    const { engine, module, resource } = await renderer({
      'refresh-feed': '<p>{{count}} {{note}} latest={{latest}}</p>',
      'refresh-item': '<span>{{title}}</span>',
      'refresh-list':
        '<ul>{{#each items}}<li>{{nvChild "item" id title=title}}</li>{{/each}}</ul>',
    });
    const app = await application(
      platform,
      [
        LiveModule.registerAsync({
          components: [RefreshFeed, RefreshList, RefreshItem],
          imports: [module],
          useFactory: () => policies(engine),
        }),
      ],
      [],
      resource,
    );
    const runtime = app.get(LiveRuntime);
    const store = memoryStore(runtime);
    const transactions = vi.spyOn(store, 'transaction');
    const creates = vi.spyOn(store, 'create');
    const mount = async (type: typeof RefreshFeed | typeof RefreshList) =>
      marker((await runtime.mount(type, { headers: {} })).value);
    const post = (
      name: string,
      action: string,
      body: unknown,
      headers: Record<string, string> = {},
    ) => send(app, `/_nestvexa/live/${name}/${action}`, body, headers);
    return { store, transactions, creates, mount, post };
  }

  it('renders stored state at the same revision without a transaction', async () => {
    const { store, transactions, mount, post } = await fixture();
    const reference = await mount(RefreshFeed);
    source.value = 7;
    source.emit = true;
    const before = store.peek(
      reference.snapshot,
      'live-fixture/session/principal',
    );
    const reply = await post('refresh-feed', '_sync', envelope(reference), {
      'x-nestvexa-resync': '1',
    });
    expect(reply.status).toBe(201);
    const body = reply.json();
    expect(body).toMatchObject({
      snapshot: reference.snapshot,
      component: { revision: reference.revision },
      // Exactly the stored state; the template re-read the computed value.
      state: { count: 0, note: '', status: 'open' },
    });
    expect(String(body['html'])).toContain('latest=7');
    expect(body['events']).toBeUndefined();
    expect(transactions).not.toHaveBeenCalled();
    // Nothing is stored: same revision, same state, same expiry.
    const after = store.peek(
      reference.snapshot,
      'live-fixture/session/principal',
    );
    expect(after).toEqual(before);
    expect(hydrates).toBe(1);
    expect(runs).toBe(0);
  });

  it('is repeatable and leaves the next action on the same revision', async () => {
    const { transactions, mount, post } = await fixture();
    const reference = await mount(RefreshFeed);
    for (let index = 0; index < 3; index++) {
      const reply = await post('refresh-feed', '_sync', envelope(reference), {
        'x-nestvexa-resync': '1',
      });
      expect(reply.json()).toMatchObject({
        component: { revision: reference.revision },
      });
    }
    expect(transactions).not.toHaveBeenCalled();
    // The client never moved: its rendered revision is still current.
    const action = await post('refresh-feed', 'increment', envelope(reference));
    expect(action.status).toBe(201);
    expect(action.json()).toMatchObject({
      component: { revision: reference.revision + 1 },
      state: { count: 1 },
    });
    expect(transactions).toHaveBeenCalledTimes(1);
  });

  it('targets the current revision for a stale client (STALE_REVISION recovery)', async () => {
    const { transactions, mount, post } = await fixture();
    const reference = await mount(RefreshFeed);
    await post('refresh-feed', 'increment', envelope(reference));
    const stale = await post('refresh-feed', 'increment', envelope(reference));
    expect(stale.status).toBe(409);
    expect(stale.headers['x-nestvexa-recovery']).toBe('resync');
    const refresh = await post('refresh-feed', '_sync', envelope(reference), {
      'x-nestvexa-resync': '1',
    });
    expect(refresh.json()).toMatchObject({
      component: { revision: reference.revision + 1 },
      state: { count: 1 },
    });
    expect(transactions).toHaveBeenCalledTimes(1);
    expect(runs).toBe(1);
  });

  it('refuses a render that changes stored state and commits it on request', async () => {
    const { store, transactions, mount, post } = await fixture();
    const reference = await mount(RefreshFeed);
    source.status = 'closed';
    const refused = await post('refresh-feed', '_sync', envelope(reference), {
      'x-nestvexa-resync': '1',
    });
    expect(refused.status).toBe(409);
    expect(refused.headers['x-nestvexa-recovery']).toBe('commit');
    expect(refused.json()).toEqual({
      statusCode: 409,
      code: 'REFRESH_CONFLICT',
    });
    expect(transactions).not.toHaveBeenCalled();
    const binding = 'live-fixture/session/principal';
    expect(store.peek(reference.snapshot, binding).state).toMatchObject({
      status: 'open',
    });
    // The committing resync stores it, so actions see the same value.
    const committed = await post('refresh-feed', '_sync', envelope(reference), {
      'x-nestvexa-resync': 'commit',
    });
    expect(committed.json()).toMatchObject({
      component: { revision: reference.revision + 1 },
      state: { status: 'closed' },
    });
    expect(store.peek(reference.snapshot, binding).state).toMatchObject({
      status: 'closed',
    });
    expect(runs).toBe(0);
  });

  it('keeps an unchanged child tree and stubs retained children', async () => {
    const { transactions, creates, mount, post } = await fixture();
    const reference = await mount(RefreshList);
    expect(creates).toHaveBeenCalledTimes(3);
    const reply = await post('refresh-list', '_sync', envelope(reference), {
      'x-nestvexa-resync': '1',
    });
    expect(reply.status).toBe(201);
    expect(String(reply.json()['html'])).toContain('data-nv-stub=""');
    expect(transactions).not.toHaveBeenCalled();
    expect(creates).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['a new child', () => (source.ids = ['a', 'b', 'c'])],
    ['a removed child', () => (source.ids = ['a'])],
    ['changed child props', () => (source.title = 'second')],
  ])(
    'refuses %s with REFRESH_CONFLICT and commits on request',
    async (_label, change) => {
      const { store, transactions, creates, mount, post } = await fixture();
      const reference = await mount(RefreshList);
      change();
      const refused = await post('refresh-list', '_sync', envelope(reference), {
        'x-nestvexa-resync': '1',
      });
      expect(refused.status).toBe(409);
      expect(refused.headers['x-nestvexa-recovery']).toBe('commit');
      expect(refused.json()).toEqual({
        statusCode: 409,
        code: 'REFRESH_CONFLICT',
      });
      expect(transactions).not.toHaveBeenCalled();
      expect(creates).toHaveBeenCalledTimes(3);
      // A refused refresh keeps the state usable: nothing was invalidated.
      expect(
        store.peek(reference.snapshot, 'live-fixture/session/principal')
          .revision,
      ).toBe(reference.revision);
      const committed = await post(
        'refresh-list',
        '_sync',
        envelope(reference),
        { 'x-nestvexa-resync': 'commit' },
      );
      expect(committed.status).toBe(201);
      expect(committed.json()).toMatchObject({
        component: { revision: reference.revision + 1 },
      });
      expect(transactions).toHaveBeenCalled();
    },
  );

  it('rejects refreshes that would write state, run an action or use another value', async () => {
    const { transactions, mount, post } = await fixture();
    const reference = await mount(RefreshFeed);
    const cases: [string, unknown, string][] = [
      ['_sync', envelope(reference, { updates: { note: 'x' } }), '1'],
      ['_sync', envelope(reference, { updates: { note: 'x' } }), 'commit'],
      ['increment', envelope(reference), '1'],
      ['increment', envelope(reference), 'commit'],
      ['_sync', envelope(reference), 'read'],
      ['_sync', envelope(reference), ''],
    ];
    for (const [action, body, value] of cases) {
      const rejected = await post('refresh-feed', action, body, {
        'x-nestvexa-resync': value,
      });
      expect(rejected.status, `${action} ${value}`).toBe(400);
      expect(rejected.json()).toMatchObject({ code: 'INVALID_REQUEST' });
    }
    // Input is refused like on any $sync.
    const input = await post(
      'refresh-feed',
      '_sync',
      envelope(reference, { input: { id: 1 } }),
      { 'x-nestvexa-resync': '1' },
    );
    expect(input.json()).toMatchObject({ code: 'UNEXPECTED_INPUT' });
    expect(transactions).not.toHaveBeenCalled();
    expect(runs).toBe(0);
  });

  it('still enforces CSRF, identity binding and the component route', async () => {
    const { mount, post } = await fixture();
    const reference = await mount(RefreshFeed);
    const forged = await post('refresh-feed', '_sync', envelope(reference), {
      'x-nestvexa-resync': '1',
      'x-nestvexa-csrf': 'wrong',
    });
    expect(forged.status).toBe(403);
    const other = await mount(RefreshList);
    const mismatch = await post('refresh-feed', '_sync', envelope(other), {
      'x-nestvexa-resync': '1',
    });
    expect(mismatch.json()).toMatchObject({ code: 'COMPONENT_MISMATCH' });
    const unknown = await post(
      'refresh-feed',
      '_sync',
      envelope({ snapshot: 'A'.repeat(43), revision: 0 }),
      { 'x-nestvexa-resync': '1' },
    );
    expect(unknown.status).toBe(410);
  });

  it('is catalogued', () => {
    expect(LIVE_ERROR_CODES.REFRESH_CONFLICT).toMatchObject({
      status: 409,
      recovery: 'resync',
    });
  });
});
