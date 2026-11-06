declare module '*.vue' {
  import type { Component } from 'vue';
  const component: Component;
  export default component;
}
declare module '*.svelte' {
  import type { Component } from 'svelte';
  const component: Component<Record<string, unknown>>;
  export default component;
}
