import { createInertiaApp } from '@inertiajs/svelte';
import { createSvelteSsrRender } from '@nestvexa/svelte/ssr';
import { layout, pages } from './setup';

export const render = createSvelteSsrRender({
  createInertiaApp,
  pages,
  layout,
});
