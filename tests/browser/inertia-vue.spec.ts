import {
  defineClientOnlySuite,
  defineFeatureSmoke,
} from './inertia-feature-smoke.js';
import { defineFrameworkSuite, exampleUrl } from './inertia-framework-suite.js';
import { defineFormsUploadsSuite } from './inertia-forms-uploads.js';

// examples/inertia-vue: Vite production build, official @inertiajs/vue3 3.10.0
// client (createSSRApp hydration), SSR in-process from the built bundle
// dist/ssr/ssr.js via moduleSsrRenderer. A second instance (`start:csr`)
// serves the same build with SSR disabled.
const base = exampleUrl('VUE', 3107);
defineFrameworkSuite({ framework: 'Vue', base });
defineFormsUploadsSuite({ framework: 'Vue', base });
defineFeatureSmoke({ framework: 'Vue', base });
defineClientOnlySuite({ framework: 'Vue', base: exampleUrl('VUE_CSR', 3211) });
