import 'reflect-metadata';
import { BadRequestException, Injectable } from '@nestjs/common';
import type { INestApplication, PipeTransform, Type } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import {
  Action,
  ActionInput,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  Modelable,
  OnEvent,
  Prop,
  Reactive,
  State,
  dispatchLiveEvent,
  redirectLive,
} from '../packages/live/dist/index.js';
import { definition } from '../packages/live/dist/metadata.js';

const origin = 'http://localhost:3100';
const csrf = 'nesting-host-csrf-0123456789012345678901';
const binding = 'tenant/session/alice';
const resources: {
  app: INestApplication;
  root: string;
  renderer: HbsEngine;
}[] = [];

afterEach(async () => {
  for (const { app, root, renderer } of resources.splice(0)) {
    await app.close();
    await renderer.dispose();
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep))
      throw new Error('Unexpected nesting fixture directory');
    await rm(root, { recursive: true, force: true });
  }
});

interface Reply {
  status: number;
  body: {
    code?: string;
    snapshot: string;
    component: { id: string; revision: number };
    state: Record<string, unknown>;
    html: string;
    events?: { name: string; payload: unknown; to?: string; self?: true }[];
    redirect?: string;
  };
}
function post(
  url: string,
  body: object,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return new Promise((done, reject) => {
    const request = httpRequest(
      url,
      {
        method: 'POST',
        headers: {
          origin,
          'content-type': 'application/json',
          'x-nestvexa-csrf': csrf,
          ...headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () =>
          done({
            status: response.statusCode ?? 500,
            body: JSON.parse(
              Buffer.concat(chunks).toString('utf8'),
            ) as Reply['body'],
          }),
        );
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}
function roots(html: string) {
  const found: {
    id: string;
    key: string | undefined;
    stub: boolean;
    refresh: boolean;
    snapshot: string | undefined;
    revision: string | undefined;
    listeners: string | undefined;
    model: string | undefined;
    lazy: string | undefined;
  }[] = [];
  for (const match of html.matchAll(
    /<div ([^>]*data-nv-component="[^"]+"[^>]*)>/g,
  )) {
    const attributes = match[1] ?? '';
    const read = (name: string) =>
      new RegExp(`${name}="([^"]*)"`).exec(attributes)?.[1];
    found.push({
      id: read('data-nv-component') ?? '',
      key: read('data-nv-key'),
      stub: attributes.includes('data-nv-stub'),
      refresh: attributes.includes('data-nv-refresh'),
      snapshot: read('data-nv-snapshot'),
      revision: read('data-nv-revision'),
      listeners: read('data-nv-listeners')?.replaceAll('&quot;', '"'),
      model: read('data-nv-model')?.replaceAll('&quot;', '"'),
      lazy: read('data-nv-lazy'),
    });
  }
  return found;
}

class NotePipe implements PipeTransform {
  transform(value: unknown): { id: string } {
    if (
      !value ||
      typeof value !== 'object' ||
      typeof Reflect.get(value, 'id') !== 'string'
    )
      throw new BadRequestException();
    return { id: String(Reflect.get(value, 'id')) };
  }
}

async function fixture(platform: 'express' | 'fastify') {
  const root = await mkdtemp(join(tmpdir(), 'nestvexa-nesting-'));
  await writeFile(
    join(root, 'list.hbs'),
    '<ul>{{#each items}}<li>{{nvChild "item" id title=title}}</li>{{/each}}</ul><p id="selected">{{selected}}</p>{{nvChild "picker" "main" model="selected"}}',
  );
  await writeFile(
    join(root, 'item.hbs'),
    '<span class="title">{{title}}</span><span class="done">{{done}}</span>{{nvChild "badge" "b" label=title}}',
  );
  await writeFile(join(root, 'badge.hbs'), '<em>{{label}}</em>');
  await writeFile(join(root, 'picker.hbs'), '<output>{{value}}</output>');
  await writeFile(join(root, 'lazy.hbs'), '<p id="lazy-body">{{greeting}}</p>');
  await writeFile(
    join(root, 'lazy-wait.hbs'),
    '<p id="wait">Waiting {{greeting}}</p>',
  );
  await writeFile(join(root, 'log.hbs'), '<p>{{seen}}</p>');
  const renderer = new HbsEngine({ root });
  await renderer.initialize();
  const settings = { denyChildMount: false };
  const mounts: string[] = [];

  @LiveComponent({ name: 'badge', view: 'badge' })
  class Badge {
    @Reactive() @State() label = '';
    mount(): void {
      mounts.push('badge');
    }
  }
  @LiveComponent({ name: 'item', view: 'item', children: { badge: Badge } })
  class Item {
    @Reactive() @State() title = '';
    @State() done = false;
    mount(): void {
      mounts.push(`item:${this.title}`);
    }
    @Action() toggle(): void {
      this.done = !this.done;
    }
    @Action() rename(): void {
      this.title = 'mutated by child';
    }
  }
  @LiveComponent({ name: 'picker', view: 'picker' })
  class Picker {
    @Modelable()
    @State({ writable: true, validate: (value) => typeof value === 'string' })
    value = '';
    @Action() choose(): void {
      this.value = 'picked';
    }
  }
  @LiveComponent({
    name: 'list',
    view: 'list',
    children: { item: Item, picker: Picker },
  })
  class List {
    @State() items = [
      { id: 'a', title: 'Alpha' },
      { id: 'b', title: 'Beta' },
    ];
    @State({ writable: true, validate: (value) => typeof value === 'string' })
    selected = 'none';
    @Action() touch(): void {
      // Changes no child prop: every child must be retained as a stub.
      this.selected = this.selected + '';
    }
    @Action() renameFirst(): void {
      this.items = this.items.map((item, index) =>
        index === 0 ? { ...item, title: 'Alpha 2' } : item,
      );
    }
    @Action() removeFirst(): void {
      this.items = this.items.slice(1);
    }
    @Action() add(): void {
      this.items = [...this.items, { id: 'c', title: 'Gamma' }];
    }
    @Action() select(): void {
      this.selected = 'from parent';
    }
    @Action() save(): void {
      dispatchLiveEvent(this, 'note.saved', { id: 'a' });
      dispatchLiveEvent(this, 'note.local', null, { self: true });
    }
    @Action() finish(): void {
      redirectLive(this, '/done?from=list');
    }
    @Action() escape(): void {
      redirectLive(this, '//evil.example/');
    }
  }
  @LiveComponent({ name: 'log', view: 'log' })
  class Log {
    @State() seen = '';
    @Action()
    @OnEvent('note.saved')
    noted(@ActionInput(NotePipe) input: { id: string }): void {
      this.seen = input.id;
    }
  }
  @LiveComponent({
    name: 'lazy',
    view: 'lazy',
    lazy: true,
    placeholder: 'lazy-wait',
  })
  class Lazy {
    @State() greeting = 'hello';
  }
  @Injectable()
  class Unused {}
  void Unused;

  const module = await Test.createTestingModule({
    imports: [
      LiveModule.register({
        components: [List, Item, Badge, Picker, Log, Lazy],
        renderer,
        origin,
        resolveIdentity: (request) => {
          const headers = Reflect.get(request, 'headers') as Record<
            string,
            string | undefined
          >;
          return {
            binding:
              headers['x-user'] === 'bob' ? 'tenant/session/bob' : binding,
            csrfToken: csrf,
          };
        },
        authorize: (_identity, component, action) =>
          !(
            settings.denyChildMount &&
            component === 'item' &&
            action === '$mount'
          ),
      }),
    ],
  }).compile();
  const app =
    platform === 'fastify'
      ? module.createNestApplication(new FastifyAdapter(), { logger: false })
      : module.createNestApplication({ logger: false });
  resources.push({ app, root, renderer });
  await app.listen(0, '127.0.0.1');
  const runtime = app.get(LiveRuntime);
  const base = await app.getUrl();
  async function mount(type: Type<object>) {
    const html = (await runtime.mount(type, { headers: {}, url: '/list' }))
      .value;
    const outer = roots(html)[0];
    if (!outer?.snapshot) throw new Error('Missing mounted root');
    return { html, snapshot: outer.snapshot, id: outer.id };
  }
  async function act(
    component: string,
    action: string,
    reference: { snapshot: string; revision: number },
    extra: {
      updates?: object;
      input?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) {
    return post(
      `${base}/_nestvexa/live/${component}/${action}`,
      {
        protocol: 'nestvexa-live/1',
        requestId: randomUUID(),
        snapshot: reference.snapshot,
        revision: reference.revision,
        updates: extra.updates ?? {},
        input: extra.input ?? null,
      },
      extra.headers,
    );
  }
  return { runtime, mount, act, settings, mounts, List, Lazy, Log };
}

describe('nested component metadata', () => {
  it('rejects unsafe child aliases, prop misuse and listeners without actions', () => {
    @LiveComponent({ name: 'leaf', view: 'leaf' })
    class Leaf {}
    expect(() =>
      LiveComponent({
        name: 'bad-alias',
        view: 'v',
        children: { 'bad alias': Leaf },
      }),
    ).toThrow(/Invalid live identifier/);
    expect(() =>
      LiveComponent({ name: 'bad-lazy', view: 'v', placeholder: 'wait' }),
    ).toThrow(/requires lazy/);
    @LiveComponent({ name: 'undeclared', view: 'v' })
    class Undeclared {
      @Prop() missing = '';
    }
    expect(() => definition(Undeclared)).toThrow(
      /must also be declared @State/,
    );
    @LiveComponent({ name: 'writable-reactive', view: 'v' })
    class WritableReactive {
      @Reactive() @State({ writable: true }) value = '';
    }
    expect(() => definition(WritableReactive)).toThrow(
      /cannot be client-writable/,
    );
    @LiveComponent({ name: 'two-models', view: 'v' })
    class TwoModels {
      @Modelable() @State({ writable: true }) first = '';
      @Modelable() @State({ writable: true }) second = '';
    }
    expect(() => definition(TwoModels)).toThrow(/more than one @Modelable/);
    @LiveComponent({ name: 'listener', view: 'v' })
    class Listener {
      @OnEvent('saved') heard(): void {}
    }
    expect(() => definition(Listener)).toThrow(/@OnEvent without @Action/);
    expect(() => OnEvent('Bad Name')).toThrow(/Event names/);
  });

  it('rejects a child type outside the same registration at startup', () => {
    @LiveComponent({ name: 'orphan', view: 'v' })
    class Orphan {}
    @LiveComponent({ name: 'holder', view: 'v', children: { orphan: Orphan } })
    class Holder {}
    expect(() =>
      LiveModule.register({
        components: [Holder],
        renderer: new HbsEngine({ root: tmpdir() }),
        origin,
        resolveIdentity: () => ({ binding, csrfToken: csrf }),
        authorize: () => true,
      }),
    ).toThrow(/same LiveModule components array/);
  });
});

describe.each(['express', 'fastify'] as const)(
  'nested Live components: %s',
  (platform) => {
    it('mounts keyed children with their own snapshots, props and grandchildren', async () => {
      const f = await fixture(platform);
      const mounted = await f.mount(f.List);
      const found = roots(mounted.html);
      // list, item a, badge, item b, badge, picker
      expect(found.map((root) => root.key)).toEqual([
        undefined,
        'nv-child:item:a',
        'nv-child:badge:b',
        'nv-child:item:b',
        'nv-child:badge:b',
        'nv-child:picker:main',
      ]);
      expect(new Set(found.map((root) => root.snapshot)).size).toBe(6);
      expect(found.every((root) => !root.stub && root.revision === '0')).toBe(
        true,
      );
      expect(mounted.html).toContain('<span class="title">Alpha</span>');
      expect(mounted.html).toContain('<em>Beta</em>');
      expect(found[5]?.model).toBe('{"parent":"selected","child":"value"}');
      expect(f.mounts).toEqual(['item:Alpha', 'badge', 'item:Beta', 'badge']);
      // Child state is stored independently and child actions use child routes.
      const item = found[1];
      if (!item?.snapshot) throw new Error('Missing item');
      expect(f.runtime.store.peek(item.snapshot, binding).state).toEqual({
        title: 'Alpha',
        done: false,
      });
      const toggled = await f.act('item', 'toggle', {
        snapshot: item.snapshot,
        revision: 0,
      });
      expect(toggled.status).toBe(201);
      expect(toggled.body.state).toEqual({ title: 'Alpha', done: true });
      // The grandchild is retained by the child render.
      expect(roots(toggled.body.html).map((root) => root.stub)).toEqual([true]);
    });

    it('retains unchanged children as stubs and refreshes only changed reactive props', async () => {
      const f = await fixture(platform);
      const mounted = await f.mount(f.List);
      const initial = roots(mounted.html);
      f.mounts.length = 0;
      const touched = await f.act('list', 'touch', {
        snapshot: mounted.snapshot,
        revision: 0,
      });
      expect(touched.status).toBe(201);
      const stubs = roots(touched.body.html);
      expect(stubs.map((root) => [root.key, root.stub])).toEqual([
        ['nv-child:item:a', true],
        ['nv-child:item:b', true],
        ['nv-child:picker:main', true],
      ]);
      expect(stubs.map((root) => root.id)).toEqual([
        initial[1]?.id,
        initial[3]?.id,
        initial[5]?.id,
      ]);
      expect(touched.body.html).not.toContain('class="title"');
      expect(touched.body.html).not.toContain('data-nv-snapshot');
      expect(f.mounts).toEqual([]);

      const renamed = await f.act('list', 'renameFirst', {
        snapshot: mounted.snapshot,
        revision: 1,
      });
      expect(renamed.status).toBe(201);
      const after = roots(renamed.body.html);
      expect(after[0]).toMatchObject({
        id: initial[1]?.id,
        key: 'nv-child:item:a',
        refresh: true,
        stub: false,
        revision: '1',
        snapshot: initial[1]?.snapshot,
      });
      // The refreshed child re-renders its grandchild with the new reactive label.
      expect(after[1]).toMatchObject({
        key: 'nv-child:badge:b',
        refresh: true,
      });
      expect(renamed.body.html).toContain('<em>Alpha 2</em>');
      expect(after[2]).toMatchObject({ key: 'nv-child:item:b', stub: true });
      expect(f.mounts).toEqual([]);
    });

    it('mounts added keys, revokes removed children and rejects child reactive mutation', async () => {
      const f = await fixture(platform);
      const mounted = await f.mount(f.List);
      const initial = roots(mounted.html);
      const removed = await f.act('list', 'removeFirst', {
        snapshot: mounted.snapshot,
        revision: 0,
      });
      expect(removed.status).toBe(201);
      expect(roots(removed.body.html).map((root) => root.key)).toEqual([
        'nv-child:item:b',
        'nv-child:picker:main',
      ]);
      const removedToken = initial[1]?.snapshot ?? '';
      expect(() => f.runtime.store.peek(removedToken, binding)).toThrow();
      const added = await f.act('list', 'add', {
        snapshot: mounted.snapshot,
        revision: 1,
      });
      const fresh = roots(added.body.html).find(
        (root) => root.key === 'nv-child:item:c',
      );
      expect(fresh).toMatchObject({ stub: false, revision: '0' });
      expect(added.body.html).toContain('<span class="title">Gamma</span>');
      const beta = initial[3];
      if (!beta?.snapshot) throw new Error('Missing beta');
      const mutated = await f.act('item', 'rename', {
        snapshot: beta.snapshot,
        revision: 0,
      });
      expect(mutated.status).toBe(409);
      expect(mutated.body.code).toBe('REACTIVE_PROP_MUTATED');
    });

    it('flows modelable values down from the parent and keeps child-proposed values', async () => {
      const f = await fixture(platform);
      const mounted = await f.mount(f.List);
      const picker = roots(mounted.html)[5];
      if (!picker?.snapshot) throw new Error('Missing picker');
      expect(f.runtime.store.peek(picker.snapshot, binding).state).toEqual({
        value: 'none',
      });
      const chosen = await f.act('picker', 'choose', {
        snapshot: picker.snapshot,
        revision: 0,
      });
      expect(chosen.body.state).toEqual({ value: 'picked' });
      // The browser proposes the child value to the writable parent field.
      const synced = await f.act(
        'list',
        '_sync',
        { snapshot: mounted.snapshot, revision: 0 },
        {
          updates: { selected: 'picked' },
        },
      );
      expect(synced.status).toBe(201);
      expect(roots(synced.body.html).at(-1)).toMatchObject({ stub: true });
      expect(synced.body.html).toContain('<p id="selected">picked</p>');
      const selected = await f.act('list', 'select', {
        snapshot: mounted.snapshot,
        revision: 1,
      });
      expect(roots(selected.body.html).at(-1)).toMatchObject({
        refresh: true,
        revision: '2',
      });
      expect(selected.body.html).toContain('<output>from parent</output>');
    });

    it('authorizes every child mount and cleans up partially mounted trees', async () => {
      const f = await fixture(platform);
      f.settings.denyChildMount = true;
      const sizeBefore = f.runtime.store.size;
      await expect(f.mount(f.List)).rejects.toMatchObject({ status: 403 });
      expect(f.runtime.store.size).toBe(sizeBefore);
    });

    it('returns bounded events and listener markers; payloads stay untrusted action input', async () => {
      const f = await fixture(platform);
      const mounted = await f.mount(f.List);
      const saved = await f.act('list', 'save', {
        snapshot: mounted.snapshot,
        revision: 0,
      });
      expect(saved.status).toBe(201);
      expect(saved.body.events).toEqual([
        { name: 'note.saved', payload: { id: 'a' } },
        { name: 'note.local', payload: null, self: true },
      ]);
      const log = await f.mount(f.Log);
      expect(roots(log.html)[0]?.listeners).toBe('{"note.saved":["noted"]}');
      const delivered = await f.act(
        'log',
        'noted',
        { snapshot: log.snapshot, revision: 0 },
        {
          input: { id: 'a' },
        },
      );
      expect(delivered.body.state).toEqual({ seen: 'a' });
      const forged = await f.act(
        'log',
        'noted',
        { snapshot: log.snapshot, revision: 1 },
        { input: { id: 7 } },
      );
      expect(forged.status).toBe(400);
    });

    it('returns only application-relative redirects', async () => {
      const f = await fixture(platform);
      const mounted = await f.mount(f.List);
      const finished = await f.act('list', 'finish', {
        snapshot: mounted.snapshot,
        revision: 0,
      });
      expect(finished.body.redirect).toBe('/done?from=list');
      const second = await f.mount(f.List);
      const escaped = await f.act('list', 'escape', {
        snapshot: second.snapshot,
        revision: 0,
      });
      expect(escaped.status).toBe(500);
      expect(JSON.stringify(escaped.body)).not.toContain('evil.example');
    });

    it('renders a lazy placeholder at mount and the body on the first refresh', async () => {
      const f = await fixture(platform);
      const mounted = await f.mount(f.Lazy);
      expect(roots(mounted.html)[0]?.lazy).toBe('load');
      expect(mounted.html).toContain('<p id="wait">Waiting hello</p>');
      expect(mounted.html).not.toContain('lazy-body');
      const loaded = await f.act('lazy', '_sync', {
        snapshot: mounted.snapshot,
        revision: 0,
      });
      expect(loaded.status).toBe(201);
      expect(loaded.body.html).toBe('<p id="lazy-body">hello</p>');
    });
  },
);
