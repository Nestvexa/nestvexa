// Copied next to the generated action bindings by consumer.ts, type-checked
// with the consumer's own compiler options against the packed tarballs, then
// run in Node: React hooks under react-dom/server, Vue composables in an
// effect scope and Svelte stores against the packed ActionsModule route.
// The `@ts-expect-error` lines must stay errors: an unused directive fails.
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { effectScope } from 'vue';
import { createActionsClient } from '@nestvexa/actions/client';
import { createActions } from './actions-client.js';
import { createActionHooks } from './actions-client.react.js';
import { createActionComposables } from './actions-client.vue.js';
import { createActionStores } from './actions-client.svelte.js';
import { createActionBindings } from './actions-client.live.js';

const [baseUrl, csrf, origin] = process.argv.slice(2);
assert.ok(
  baseUrl && csrf && origin,
  'usage: check.js <baseUrl> <csrf> <origin>',
);
const actions = createActions(
  createActionsClient({ baseUrl, csrf, headers: { origin } }),
);

// React: typed hook state, optimistic update type, server-signature input.
const hooks = createActionHooks(actions);
function Echo() {
  const echo = hooks.usePackEcho({
    initialData: { text: 'ssr', subject: 'nobody', at: '' },
    optimistic: (current, input) => ({
      text: input.text,
      subject: current?.subject ?? 'optimistic',
      at: current?.at ?? '',
    }),
  });
  const text: string | undefined = echo.data?.text;
  return createElement('output', null, `${echo.status}:${text ?? ''}`);
}
assert.equal(renderToString(createElement(Echo)), '<output>idle:ssr</output>');

/** Never called: compile-time contracts of the generated declarations. */
export function contracts(element: HTMLElement): void {
  const echo = hooks.usePackEcho();
  // @ts-expect-error the input type comes from the server method
  void echo.run({ text: 1 });
  // @ts-expect-error unknown input fields are rejected
  void echo.run({ text: 'a', extra: true });
  const field: 'text' | undefined = echo.error?.issues[0]?.path[0];
  // @ts-expect-error issue paths name the action's input fields only
  const other: 'other' | undefined = echo.error?.issues[0]?.path[0];
  // @ts-expect-error Date outputs arrive as JSON strings
  const at: Date | undefined = echo.data?.at;
  hooks.usePackEcho({
    // @ts-expect-error optimistic values must match the output type
    optimistic: () => ({ text: 1 }),
  });
  createActionBindings(actions).bindPackEcho(element, {
    input: () => ({ text: 'from the element' }),
  });
  createActionBindings(actions).bindPackEcho(element, {
    // @ts-expect-error element helpers build typed input too
    input: () => ({ text: false }),
  });
  void [field, other, at];
}

// Vue: composable state ref, settled result, scope disposal.
const composables = createActionComposables(actions);
const scope = effectScope();
const vueEcho = scope.run(() => composables.usePackEcho());
assert.ok(vueEcho);
const vueResult = await vueEcho.run({ text: 'vue' });
assert.ok(vueResult.ok);
assert.equal(vueEcho.state.value.data?.text, 'vue');
assert.equal(vueEcho.state.value.data?.subject, 'packed-user');
scope.stop();

// Svelte: store contract (subscribe) and settled run results.
const store = createActionStores(actions).packEcho();
const statuses: string[] = [];
const unsubscribe = store.subscribe((state) => statuses.push(state.status));
const svelteResult = await store.run({ text: 'svelte' });
unsubscribe();
assert.ok(svelteResult.ok);
assert.equal(svelteResult.data.text, 'svelte');
assert.equal(svelteResult.data.at, '1970-01-01T00:00:00.000Z');
assert.deepEqual(statuses, ['idle', 'pending', 'success']);

// Live/HBS element helpers need a DOM; Node checks the generated module shape.
assert.equal(typeof createActionBindings(actions).bindPackEcho, 'function');
console.log('react, vue, svelte and live bindings passed');
