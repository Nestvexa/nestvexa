/**
 * Parent/child scope rules (LIVE-021) and the @Reactive write guard: stable
 * keys, prop modes, class inheritance, per-component authorization, DOM change
 * scope, and parent-owned values rejected at the write before later effects.
 */
import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Action,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  Prop,
  Reactive,
  State,
} from '../packages/live/dist/index.js';
import {
  application,
  cleanup,
  envelope,
  platforms,
  policies,
  renderer,
  send,
} from './support/live-fixture.js';
import type { Platform } from './support/live-fixture.js';

afterEach(cleanup);

const effects: string[] = [];

@LiveComponent({ name: 'scope-item', view: 'scope-item' })
class ScopeItem {
  @Reactive() @State() label = '';
  @Reactive() @State() tags: string[] = [];
  @Prop() @State() note = '';
  @State() clicks = 0;
  @Action() rename(): void {
    this.label = 'child-chosen';
    effects.push('rename');
  }
  @Action() tag(): void {
    this.tags.push('extra');
    effects.push('tag');
  }
  @Action() relabelSame(): void {
    // Writing the value the parent already sent is not a change.
    this.label = `${this.label}`;
    effects.push('same');
  }
  @Action() click(): void {
    this.clicks++;
  }
  @Action() annotate(): void {
    this.note = 'child-owned';
  }
}

/** Decorated members of a base class are inherited by the registered subclass. */
class BaseList {
  @State() items = [
    { key: 'a', label: 'Alpha', tags: ['x'], note: 'from parent' },
    { key: 'b', label: 'Beta', tags: [], note: 'from parent' },
  ];
  @State() version = 0;
  @Action() touch(): void {
    this.version++;
  }
}
@LiveComponent({
  name: 'scope-list',
  view: 'scope-list',
  children: { item: ScopeItem },
})
class ScopeList extends BaseList {
  @Action() relabelFirst(): void {
    this.items = this.items.map((item, index) =>
      index === 0 ? { ...item, label: 'Alpha 2', note: 'parent again' } : item,
    );
  }
  @Action() rekeyFirst(): void {
    this.items = this.items.map((item, index) =>
      index === 0 ? { ...item, key: 'z' } : item,
    );
  }
}

const templates = {
  'scope-list':
    '<ul>{{#each items}}<li>{{nvChild "item" key label=label tags=tags note=note}}</li>{{/each}}</ul><p class="version">v{{version}}</p>',
  'scope-item':
    '<span class="label">{{label}}</span><span class="clicks">{{clicks}}</span><span class="note">{{note}}</span>',
};

interface Root {
  readonly id: string;
  readonly key: string | undefined;
  readonly snapshot: string | undefined;
  readonly stub: boolean;
  readonly refresh: boolean;
}
function roots(html: string): Root[] {
  return [...html.matchAll(/<div ([^>]*data-nv-component="[^"]+"[^>]*)>/g)].map(
    (match) => {
      const attributes = match[1] ?? '';
      const read = (name: string) =>
        new RegExp(`${name}="([^"]*)"`).exec(attributes)?.[1];
      return {
        id: read('data-nv-component') ?? '',
        key: read('data-nv-key'),
        snapshot: read('data-nv-snapshot'),
        stub: attributes.includes('data-nv-stub'),
        refresh: attributes.includes('data-nv-refresh'),
      };
    },
  );
}

async function fixture(
  platform: Platform,
  allow: (component: string, action: string) => boolean = () => true,
) {
  effects.length = 0;
  const authorized: string[] = [];
  const { engine, module, resource } = await renderer(templates);
  const base = policies(engine, (component, action) => {
    authorized.push(`${component}:${action}`);
    return allow(component, action);
  });
  const app = await application(
    platform,
    [
      LiveModule.registerAsync({
        components: [ScopeList, ScopeItem],
        imports: [module],
        useFactory: () => base,
      }),
    ],
    [],
    resource,
  );
  const runtime = app.get(LiveRuntime);
  const act = (
    component: string,
    action: string,
    reference: { snapshot: string; revision: number },
  ) => send(app, `/_nestvexa/live/${component}/${action}`, envelope(reference));
  return { app, runtime, act, authorized };
}

describe.each(platforms)('@Reactive write guard: %s', (platform) => {
  it('rejects a parent-owned assignment or nested mutation at the write, before later effects', async () => {
    const f = await fixture(platform);
    const html = (await f.runtime.mount(ScopeList, { headers: {} })).value;
    const alpha = roots(html)[1];
    if (!alpha?.snapshot) throw new Error('Missing child');
    const renamed = await f.act('scope-item', 'rename', {
      snapshot: alpha.snapshot,
      revision: 0,
    });
    expect(renamed.status).toBe(409);
    expect(renamed.json()).toMatchObject({ code: 'REACTIVE_PROP_MUTATED' });
    // The statement after the write never ran.
    expect(effects).toEqual([]);

    const fresh = (await f.runtime.mount(ScopeList, { headers: {} })).value;
    const beta = roots(fresh)[1];
    if (!beta?.snapshot) throw new Error('Missing child');
    const tagged = await f.act('scope-item', 'tag', {
      snapshot: beta.snapshot,
      revision: 0,
    });
    expect(tagged.status).toBe(409);
    expect(tagged.json()).toMatchObject({ code: 'REACTIVE_PROP_MUTATED' });
    expect(effects).toEqual([]);
    // The rejected request leaked nothing about the state.
    expect(tagged.body).not.toContain('Alpha');

    const third = roots(
      (await f.runtime.mount(ScopeList, { headers: {} })).value,
    )[1];
    if (!third?.snapshot) throw new Error('Missing child');
    const same = await f.act('scope-item', 'relabelSame', {
      snapshot: third.snapshot,
      revision: 0,
    });
    expect(same.status).toBe(201);
    expect(effects).toEqual(['same']);
  });
});

describe.each(platforms)('parent/child scope rules: %s', (platform) => {
  it('keeps child state, keys and DOM scope independent of the parent', async () => {
    const f = await fixture(platform);
    const html = (await f.runtime.mount(ScopeList, { headers: {} })).value;
    const [parent, alpha, beta] = roots(html);
    if (!parent?.snapshot || !alpha?.snapshot || !beta?.snapshot)
      throw new Error('Missing roots');
    expect([alpha.key, beta.key]).toEqual([
      'nv-child:item:a',
      'nv-child:item:b',
    ]);
    // A child action changes only the child: its response is the child root
    // content, and the parent's stored revision does not move.
    const clicked = await f.act('scope-item', 'click', {
      snapshot: alpha.snapshot,
      revision: 0,
    });
    expect(clicked.status).toBe(201);
    expect(clicked.json()['html']).toContain('<span class="clicks">1</span>');
    expect(clicked.json()['html']).not.toContain('Beta');
    expect(
      (
        await f.runtime.store.peek(
          parent.snapshot,
          'live-fixture/session/principal',
        )
      ).revision,
    ).toBe(0);
    // A @Prop is mount-only: the child's own change survives parent renders.
    const annotated = await f.act('scope-item', 'annotate', {
      snapshot: alpha.snapshot,
      revision: 1,
    });
    expect(annotated.status).toBe(201);
    // Inherited @Action from the base class; children with unchanged parent
    // values come back as stubs with the same stable identity.
    const touched = await f.act('scope-list', 'touch', {
      snapshot: parent.snapshot,
      revision: 0,
    });
    expect(touched.status).toBe(201);
    expect(touched.json()['state']).toMatchObject({ version: 1 });
    expect(
      roots(String(touched.json()['html'])).map((root) => [root.id, root.stub]),
    ).toEqual([
      [alpha.id, true],
      [beta.id, true],
    ]);
    // A changed @Reactive value refreshes that child only; the @Prop value
    // the parent sends again is ignored, and child-owned state is kept.
    const relabeled = await f.act('scope-list', 'relabelFirst', {
      snapshot: parent.snapshot,
      revision: 1,
    });
    const after = roots(String(relabeled.json()['html']));
    expect(after.map((root) => [root.id, root.refresh, root.stub])).toEqual([
      [alpha.id, true, false],
      [beta.id, false, true],
    ]);
    const childState = (
      await f.runtime.store.peek(
        alpha.snapshot,
        'live-fixture/session/principal',
      )
    ).state;
    expect(childState).toMatchObject({
      label: 'Alpha 2',
      note: 'child-owned',
      clicks: 1,
    });
    // Changing a key mounts a new child and revokes the old one.
    const rekeyed = await f.act('scope-list', 'rekeyFirst', {
      snapshot: parent.snapshot,
      revision: 2,
    });
    const keyed = roots(String(rekeyed.json()['html']));
    expect(keyed[0]?.key).toBe('nv-child:item:z');
    expect(keyed[0]?.id).not.toBe(alpha.id);
    expect(keyed[0]?.stub).toBe(false);
    await expect(
      Promise.resolve().then(() =>
        f.runtime.store.peek(
          alpha.snapshot ?? '',
          'live-fixture/session/principal',
        ),
      ),
    ).rejects.toMatchObject({ status: 410 });
    expect(
      (
        await f.act('scope-item', 'click', {
          snapshot: alpha.snapshot,
          revision: 2,
        })
      ).status,
    ).toBe(410);
  });

  it('authorizes every child by its own name; a parent grant is not inherited', async () => {
    const denied = await fixture(
      platform,
      (component, action) =>
        !(component === 'scope-item' && action === '$mount'),
    );
    await expect(
      denied.runtime.mount(ScopeList, { headers: {} }),
    ).rejects.toMatchObject({ status: 403 });
    expect(denied.authorized).toContain('scope-list:$mount');
    expect(denied.authorized).toContain('scope-item:$mount');

    const f = await fixture(
      platform,
      (component, action) =>
        !(component === 'scope-item' && action === 'click'),
    );
    const html = (await f.runtime.mount(ScopeList, { headers: {} })).value;
    const alpha = roots(html)[1];
    if (!alpha?.snapshot) throw new Error('Missing child');
    const forbidden = await f.act('scope-item', 'click', {
      snapshot: alpha.snapshot,
      revision: 0,
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: 'ACTION_FORBIDDEN' });
    expect(f.authorized).toContain('scope-item:click');
  });
});
