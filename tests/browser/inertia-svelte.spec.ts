import {
  defineClientOnlySuite,
  defineFeatureSmoke,
} from './inertia-feature-smoke.js';
import {
  defineFeatureTour,
  defineScrollAndProgress,
  defineTypedActionsSuite,
} from './inertia-feature-tour.js';
import { defineFrameworkSuite, exampleUrl } from './inertia-framework-suite.js';
import { defineFormsUploadsSuite } from './inertia-forms-uploads.js';
import { defineHostilePropsSuite } from './inertia-hostile-props.js';

// examples/inertia-svelte: Vite production build, official @inertiajs/svelte
// 3.10.0 client with Svelte 5 hydrate()/mount(), SSR in-process from the built
// bundle dist/ssr/ssr.js (svelte/server render) via moduleSsrRenderer. A
// second instance (`start:csr`) serves the same build with SSR disabled.
const base = exampleUrl('SVELTE', 3108);
defineFrameworkSuite({ framework: 'Svelte', base });
defineFormsUploadsSuite({ framework: 'Svelte', base });
defineFeatureSmoke({ framework: 'Svelte', base });
defineFeatureTour({ framework: 'Svelte', base });
defineScrollAndProgress({ framework: 'Svelte', base, home: '/features/tour' });
defineTypedActionsSuite({ framework: 'Svelte', base });
defineClientOnlySuite({
  framework: 'Svelte',
  base: exampleUrl('SVELTE_CSR', 3212),
});
defineHostilePropsSuite({
  framework: 'Svelte',
  base,
  clientOnlyBase: exampleUrl('SVELTE_CSR', 3212),
});
