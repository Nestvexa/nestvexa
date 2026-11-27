// Copied next to the generated action bindings by consumer.ts, type-checked
// with the consumer's own compiler options against the packed tarballs, then
// run in Node against the packed ActionsModule route of a packed Inertia app:
// the Inertia page visit supplies the CSRF token, then React hooks, Vue
// composables, Svelte stores and the Live element helper each call the action.
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

const [baseUrl, hostCsrf, origin] = process.argv.slice(2);
assert.ok(
  baseUrl && hostCsrf && origin,
  'usage: check.js <baseUrl> <csrf> <origin>',
);

// Inertia adapter: the initial document and an X-Inertia visit of the packed
// app. The page props carry the CSRF token the page hands to its actions.
const initial = await fetch(`${baseUrl}/inertia-actions`);
assert.equal(initial.status, 200);
assert.match(
  await initial.text(),
  /<script data-page="app" type="application\/json">/,
);
const visit = await fetch(`${baseUrl}/inertia-actions`, {
  headers: { 'X-Inertia': 'true', 'X-Inertia-Version': 'packed-actions' },
});
assert.equal(visit.status, 200);
assert.equal(visit.headers.get('x-inertia'), 'true');
const page: unknown = await visit.json();
assert.ok(page && typeof page === 'object');
assert.equal(Reflect.get(page, 'component'), 'Packed/Actions');
const props: unknown = Reflect.get(page, 'props');
assert.ok(props && typeof props === 'object');
const csrf: unknown = Reflect.get(props, 'csrf');
assert.equal(csrf, hostCsrf);
const actions = createActions(
  createActionsClient({ baseUrl, csrf: String(csrf), headers: { origin } }),
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

// React: the hook's `run` calls the packed server and settles through the
// hook's own callbacks. Node has no DOM, so the component renders once on the
// server and the captured binding is invoked afterwards; re-rendering from the
// store subscription is not exercised here.
const rendered: { echo?: ReturnType<typeof hooks.usePackEcho> } = {};
const reactSettled: string[] = [];
function Caller() {
  const echo = hooks.usePackEcho({
    onSuccess: (data) => reactSettled.push(`${data.text}:${data.subject}`),
  });
  rendered.echo = echo;
  return createElement('output', null, echo.status);
}
assert.equal(renderToString(createElement(Caller)), '<output>idle</output>');
const reactEcho = rendered.echo;
assert.ok(reactEcho);
const reactResult = await reactEcho.run({ text: 'react' });
assert.ok(reactResult.ok);
assert.equal(reactResult.data.text, 'react');
assert.equal(reactResult.data.subject, 'packed-user');
assert.equal(reactResult.data.at, '1970-01-01T00:00:00.000Z');
assert.deepEqual(reactSettled, ['react:packed-user']);

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

/**
 * The DOM members the Live/HBS element helper uses, on Node's own
 * EventTarget/CustomEvent: listeners, attributes, `ownerDocument.defaultView`
 * for the `nv:action` event and field lookups (a button has no fields).
 */
class NodeButton extends EventTarget {
  readonly tagName = 'BUTTON';
  readonly attributes = new Map<string, string>();
  readonly ownerDocument = { defaultView: { CustomEvent } };
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  querySelectorAll(): never[] {
    return [];
  }
}
const button = new NodeButton();
const clicks: string[] = [];
// The helper is typed for the DOM; NodeButton implements the members it uses.
const element = button as unknown as HTMLElement;
const settled = new Promise<unknown>((resolve) =>
  button.addEventListener('nv:action', (event) =>
    resolve(event instanceof CustomEvent ? event.detail : undefined),
  ),
);
const unbind = createActionBindings(actions).bindPackEcho(element, {
  input: (target, event) => {
    assert.equal(target, element);
    clicks.push(event.type);
    return { text: 'live' };
  },
});
const click = new Event('click', { cancelable: true });
button.dispatchEvent(click);
assert.equal(click.defaultPrevented, true);
assert.equal(button.attributes.get('aria-busy'), 'true');
assert.equal(button.attributes.get('data-nv-action-state'), 'pending');
assert.deepEqual(await settled, {
  ok: true,
  data: {
    text: 'live',
    subject: 'packed-user',
    at: '1970-01-01T00:00:00.000Z',
  },
});
assert.deepEqual(clicks, ['click']);
assert.equal(button.attributes.get('aria-busy'), undefined);
assert.equal(button.attributes.get('data-nv-action-state'), 'success');
// Unbinding removes the listener: a later click starts no call.
unbind();
button.dispatchEvent(new Event('click', { cancelable: true }));
assert.deepEqual(clicks, ['click']);
console.log('inertia page, react, vue, svelte and live bindings passed');
