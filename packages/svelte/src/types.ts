/**
 * Public, upstream-independent type for the injected `createInertiaApp` from
 * `@inertiajs/svelte`. Any function is accepted at the type level; the
 * runtime contract is the official 3.x API.
 */
export type SvelteCreateInertiaApp = (options: never) => Promise<unknown>;
