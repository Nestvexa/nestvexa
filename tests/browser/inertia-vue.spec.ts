import { defineFrameworkSuite, exampleUrl } from './inertia-framework-suite.js';

// examples/inertia-vue: Vite production build, official @inertiajs/vue3 3.10.0
// client (createSSRApp hydration), SSR in-process from the built bundle
// dist/ssr/ssr.js via moduleSsrRenderer.
defineFrameworkSuite({ framework: 'Vue', base: exampleUrl('VUE', 3107) });
