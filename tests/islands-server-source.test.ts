import { createElement } from '../packages/islands/node_modules/react/index.js';
import {
  defineComponent,
  h,
} from '../packages/islands/node_modules/vue/index.mjs';
import { describe, expect, it } from 'vitest';
import { reactIslandRenderer } from '../packages/islands/src/react-server.js';
import { serverIslandContext } from '../packages/islands/src/server-context.js';
import type { IslandContext } from '../packages/islands/src/client.js';
import { vueIslandRenderer } from '../packages/islands/src/vue-server.js';

// Island server rendering at source level: the inert `island` prop and the
// React and Vue renderers (`@nestvexa/islands/react-server`, `/vue-server`).
// The hybrid browser suites hydrate the output of these renderers.

const context = {
  id: 'island-1',
  shared: { locale: 'en', direction: 'ltr' as const },
};

describe('serverIslandContext', () => {
  it('is frozen, hydrating and free of side effects', () => {
    const services = { actions: 'stub' };
    const island = serverIslandContext(context, { services });
    expect(Object.isFrozen(island)).toBe(true);
    expect(island).toMatchObject({
      id: 'island-1',
      shared: context.shared,
      services,
      hydrate: true,
      signed: undefined,
    });
    expect(island.signal.aborted).toBe(false);
    expect(island.emit('x', 1)).toBeUndefined();
    expect(island.reportMismatch(new Error('m'))).toBeUndefined();
    const off = island.on('x', () => undefined);
    expect(off()).toBeUndefined();
  });

  it('defaults services to undefined', () => {
    expect(serverIslandContext(context).services).toBeUndefined();
  });
});

describe('React island renderer', () => {
  it('renders escaped props with the island context', async () => {
    const seen: IslandContext[] = [];
    const Counter = (props: { label: string; island: IslandContext }) => {
      seen.push(props.island);
      return createElement(
        'button',
        null,
        `${props.label} (${props.island.id})`,
      );
    };
    const render = reactIslandRenderer(Counter, { services: 1 });
    expect(await render({ label: '<b>Count</b>' }, context)).toBe(
      '<button>&lt;b&gt;Count&lt;/b&gt; (island-1)</button>',
    );
    expect(seen[0]?.services).toBe(1);
    expect(seen[0]?.hydrate).toBe(true);
  });
});

describe('Vue island renderer', () => {
  it('renders a fresh SSR app per call with props and the island context', async () => {
    const Greeting = defineComponent({
      props: { name: { type: String, required: true }, island: Object },
      setup: (props) => () =>
        h(
          'p',
          null,
          `Hi ${props.name} in ${String((props.island as IslandContext | undefined)?.shared.locale)}`,
        ),
    });
    const render = vueIslandRenderer(Greeting);
    expect(await render({ name: '<Ada>' }, context)).toBe(
      '<p>Hi &lt;Ada&gt; in en</p>',
    );
    expect(await render({ name: 'Grace' }, context)).toBe(
      '<p>Hi Grace in en</p>',
    );
  });
});
