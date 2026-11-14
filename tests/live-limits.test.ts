/**
 * Live structural bounds (QA-006): component nesting depth (8 levels below
 * the root), children per render tree (200), and the per-request batch of
 * state updates. Each limit is exercised exactly at the bound (accepted) and
 * one step over it (refused), through the real runtime and HTTP endpoint on
 * Express and Fastify. A refused render or batch never runs component code,
 * never commits state and leaks no internal detail.
 */
import 'reflect-metadata';
import type { Type } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Action,
  LIVE_LIMITS,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  Reactive,
  State,
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
// Fails the test on any server-side unhandled promise rejection (QA-073).
import './support/no-unhandled-rejections.js';

afterEach(cleanup);

/** Nesting depth below the root that is accepted (packages/live runtime). */
const maxDepth = 8;
/** Children mounted in one render tree that are accepted. */
const maxChildren = 200;

/**
 * A chain of `levels` components: `limit-chain-0` (the root) mounts
 * `limit-chain-1`, and so on. The deepest level is a leaf.
 */
function chain(prefix: string, levels: number): Type<object>[] {
  const classes: Type<object>[] = [];
  let child: Type<object> | undefined;
  for (let level = levels - 1; level >= 0; level--) {
    const Level = class {
      depth = level;
    };
    State()(Level.prototype, 'depth');
    LiveComponent({
      name: `${prefix}-${level}`,
      view: child ? 'limit-branch' : 'limit-leaf',
      ...(child ? { children: { next: child } } : {}),
    })(Level);
    classes.unshift(Level);
    child = Level;
  }
  return classes;
}

let actionRuns = 0;
/** Items a grid mounts with (mount hooks take no input). */
let mountSize = 0;
const range = (size: number) =>
  Array.from({ length: size }, (_, index) => index);

@LiveComponent({ name: 'limit-cell', view: 'limit-cell' })
class Cell {
  @Reactive() @State() label = '';
}

/** Renders one child per item; `grow` adds items through an action. */
@LiveComponent({
  name: 'limit-grid',
  view: 'limit-grid',
  children: { cell: Cell },
})
class Grid {
  @State() items: number[] = [];
  @State({ writable: true, validate: (value) => typeof value === 'string' })
  title = '';
  @State({ writable: true, validate: (value) => typeof value === 'string' })
  note = '';
  mount(): void {
    this.items = range(mountSize);
  }
  @Action() grow(): void {
    actionRuns++;
    this.items = [...this.items, this.items.length];
  }
  @Action() touch(): void {
    actionRuns++;
  }
}

/** Each cell of this grid mounts one nested cell: two children per item. */
@LiveComponent({ name: 'limit-pair', view: 'limit-pair' })
class Pair {
  @Reactive() @State() label = '';
}
@LiveComponent({
  name: 'limit-pair-row',
  view: 'limit-pair-row',
  children: { pair: Pair },
})
class PairRow {
  @Reactive() @State() label = '';
}
@LiveComponent({
  name: 'limit-pairs',
  view: 'limit-pairs',
  children: { row: PairRow },
})
class Pairs {
  @State() items: number[] = [];
  mount(): void {
    this.items = range(mountSize);
  }
}

const accepted = chain('limit-chain', maxDepth + 1);
const refused = chain('limit-deep', maxDepth + 2);

describe.each(platforms)(
  'Live structural limits: %s',
  // Hundreds of child mounts per test are slow on loaded CI hosts.
  { timeout: 120_000 },
  (platform) => {
    async function fixture() {
      actionRuns = 0;
      const { engine, module, resource } = await renderer({
        'limit-branch': '<p>level {{depth}}</p>{{nvChild "next" "n"}}',
        'limit-leaf': '<p>leaf {{depth}}</p>',
        'limit-cell': '<span>{{label}}</span>',
        'limit-grid':
          '<h2>{{title}}</h2><ul>{{#each items}}<li>{{nvChild "cell" this label=this}}</li>{{/each}}</ul>',
        'limit-pair': '<em>{{label}}</em>',
        'limit-pair-row': '<b>{{label}}</b>{{nvChild "pair" "p" label=label}}',
        'limit-pairs':
          '<ol>{{#each items}}<li>{{nvChild "row" this label=this}}</li>{{/each}}</ol>',
      });
      const app = await application(
        platform,
        [
          LiveModule.registerAsync({
            components: [
              ...accepted,
              ...refused,
              Grid,
              Cell,
              Pairs,
              PairRow,
              Pair,
            ],
            imports: [module],
            useFactory: () => policies(engine),
          }),
        ],
        [],
        resource,
      );
      const runtime = app.get(LiveRuntime);
      const mountWith = (type: Type<object>, size: number) => {
        mountSize = size;
        return runtime.mount(type, { headers: {} });
      };
      const post = (name: string, action: string, body: unknown) =>
        send(app, `/_nestvexa/live/${name}/${action}`, body);
      return { runtime, mountWith, post };
    }
    /** Child roots (rendered or retained stubs) of one alias in a reply. */
    const count = (html: string, alias: string) =>
      html.match(new RegExp(`data-nv-key="nv-child:${alias}:`, 'g'))?.length ??
      0;

    it(`mounts ${maxDepth} nested levels and refuses one more`, async () => {
      const { runtime } = await fixture();
      const [root] = accepted;
      const [deepRoot] = refused;
      if (!root || !deepRoot) throw new Error('Missing chain');
      const html = (await runtime.mount(root, { headers: {} })).value;
      for (let level = 0; level < maxDepth; level++)
        expect(html).toContain(`level ${level}`);
      expect(html).toContain(`leaf ${maxDepth}`);
      expect(count(html, 'next')).toBe(maxDepth);
      await expect(runtime.mount(deepRoot, { headers: {} })).rejects.toThrow(
        /depth limit/,
      );
    });

    it(`mounts ${maxChildren} children in one render and refuses ${maxChildren + 1}`, async () => {
      const { mountWith } = await fixture();
      const html = (await mountWith(Grid, maxChildren)).value;
      expect(count(html, 'cell')).toBe(maxChildren);
      await expect(mountWith(Grid, maxChildren + 1)).rejects.toThrow(
        /Too many|Unable to render view: limit-grid/,
      );
    });

    it('counts grandchildren against the same tree budget', async () => {
      const { mountWith } = await fixture();
      // 100 rows with one nested pair each: exactly 200 children in the tree.
      const html = (await mountWith(Pairs, maxChildren / 2)).value;
      expect(count(html, 'row') + count(html, 'pair')).toBe(maxChildren);
      await expect(mountWith(Pairs, maxChildren / 2 + 1)).rejects.toThrow(
        /Too many Live children/,
      );
    });

    it('refuses an action whose render would exceed the child budget without committing it', async () => {
      const { mountWith, post } = await fixture();
      const reference = marker(
        (await mountWith(Grid, maxChildren - 1)).value,
        'limit-grid',
      );
      const atLimit = await post('limit-grid', 'grow', envelope(reference));
      expect(atLimit.status).toBe(201);
      const body = atLimit.json();
      expect(count(String(body['html']), 'cell')).toBe(maxChildren);
      const next = {
        snapshot: String(body['snapshot']),
        revision: Number(Reflect.get(Object(body['component']), 'revision')),
      };
      const over = await post('limit-grid', 'grow', envelope(next));
      expect(over.status).toBeGreaterThanOrEqual(500);
      // No render detail, limit text or state leaks into the reply.
      expect(over.body).not.toMatch(/nvChild|Too many|items|limit-cell/);
      // Nothing is committed. Following the store contract, a failed
      // transaction invalidates the state rather than permitting a retry,
      // so the browser gets 410 and reloads instead of replaying.
      const again = await post('limit-grid', 'touch', envelope(next));
      expect(again.status).toBe(410);
      expect(again.json()).toEqual({
        statusCode: 410,
        code: 'INVALID_SNAPSHOT',
      });
      expect(actionRuns).toBe(2);
      // A fresh mount at the limit still works.
      expect(count((await mountWith(Grid, maxChildren)).value, 'cell')).toBe(
        maxChildren,
      );
    });

    it('bounds the batch of state updates in one request before any action runs', async () => {
      const { mountWith, post } = await fixture();
      const reference = marker((await mountWith(Grid, 1)).value, 'limit-grid');
      // Every declared writable field in one batch is accepted.
      const batch = await post(
        'limit-grid',
        'touch',
        envelope(reference, { updates: { title: 'T', note: 'N' } }),
      );
      expect(batch.status).toBe(201);
      expect(actionRuns).toBe(1);
      const body = batch.json();
      const next = {
        snapshot: String(body['snapshot']),
        revision: Number(Reflect.get(Object(body['component']), 'revision')),
      };
      // A batch naming any undeclared or read-only field is refused whole.
      for (const updates of [
        { title: 'T2', items: [9] },
        { title: 'T2', unknown: 'x' },
      ]) {
        const refusedBatch = await post(
          'limit-grid',
          'touch',
          envelope(next, { updates }),
        );
        expect(refusedBatch.status).toBe(422);
        expect(refusedBatch.json()).toMatchObject({ code: 'STATE_LOCKED' });
      }
      // More update entries than the structural node budget: 413 before parsing state.
      const flood = Object.fromEntries(
        Array.from({ length: LIVE_LIMITS.maxNodes + 1 }, (_, index) => [
          `f${index}`,
          0,
        ]),
      );
      const oversized = await post(
        'limit-grid',
        'touch',
        envelope(next, { updates: flood }),
      );
      expect(oversized.status).toBe(413);
      expect(actionRuns).toBe(1);
      // The refused batches changed nothing: the next request still succeeds
      // at the same revision with the accepted values.
      const after = await post('limit-grid', 'touch', envelope(next));
      expect(after.status).toBe(201);
      expect(String(after.json()['html'])).toContain('<h2>T</h2>');
    });
  },
);
