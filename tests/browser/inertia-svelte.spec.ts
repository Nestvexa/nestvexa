import { defineFrameworkSuite, exampleUrl } from './inertia-framework-suite.js';

// examples/inertia-svelte: Vite production build, official @inertiajs/svelte
// 3.10.0 client with Svelte 5 hydrate()/mount(), SSR in-process from the built
// bundle dist/ssr/ssr.js (svelte/server render) via moduleSsrRenderer.
defineFrameworkSuite({ framework: 'Svelte', base: exampleUrl('SVELTE', 3108) });
