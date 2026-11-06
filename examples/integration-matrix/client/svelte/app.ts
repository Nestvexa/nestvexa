import { createInertiaApp } from '@inertiajs/svelte';
import { mountSvelteInertiaApp } from '@nestvexa/svelte';
import { layout, pages } from './setup';

void mountSvelteInertiaApp({
  createInertiaApp,
  pages,
  layout,
  progress: false,
});
