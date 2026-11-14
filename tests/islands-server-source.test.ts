import { describe, expect, it } from 'vitest';
import { reactIslandRenderer } from '../packages/islands/dist/react-server.js';
import { serverIslandContext } from '../packages/islands/dist/server-context.js';
import type { IslandContext } from '../packages/islands/dist/client.js';
import { vueIslandRenderer } from '../packages/islands/dist/vue-server.js';

// Island server rendering (measured at source by the coverage run): the inert `island` prop and the
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
    expect(island.reportMismatch('text mismatch')).toBeUndefined();
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
      return `${props.label} (${props.island.id})`;
    };
    const render = reactIslandRenderer(Counter, { services: 1 });
    expect(await render({ label: '<b>Count</b>' }, context)).toBe(
      '&lt;b&gt;Count&lt;/b&gt; (island-1)',
    );
    expect(seen[0]?.services).toBe(1);
    expect(seen[0]?.hydrate).toBe(true);
  });
});

describe('Vue island renderer', () => {
  it('renders a fresh SSR app per call with props and the island context', async () => {
    const Greeting = {
      props: ['name', 'island'],
      setup: (props: { name: string; island: IslandContext }) => () =>
        `Hi ${props.name} in ${String(props.island.shared.locale)}`,
    };
    const render = vueIslandRenderer(
      Greeting as unknown as Parameters<typeof vueIslandRenderer>[0],
    );
    expect(await render({ name: '<Ada>' }, context)).toBe(
      'Hi &lt;Ada&gt; in en',
    );
    expect(await render({ name: 'Grace' }, context)).toBe('Hi Grace in en');
  });
});
