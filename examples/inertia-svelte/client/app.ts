import { createInertiaApp } from '@inertiajs/svelte';
import { mountSvelteInertiaApp } from '@nestvexa/svelte';
import { layout, pages } from './setup';
import './styles.css';

// Svelte 5: hydrate() over the server-rendered markup, or mount() when SSR
// fell back, with the official @inertiajs/svelte client.
void mountSvelteInertiaApp({
  createInertiaApp,
  pages,
  layout,
  progress: { color: '#1d4ed8', showSpinner: false },
});
