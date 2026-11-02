import { mountVueInertiaApp } from '@nestvexa/vue';
import { layout, pages, title } from './setup';
import './styles.css';

// Hydrates the server-rendered markup (createSSRApp) or mounts when SSR fell
// back, with the official @inertiajs/vue3 client and plugin.
void mountVueInertiaApp({
  pages,
  layout,
  title,
  progress: { color: '#1d4ed8', showSpinner: false },
});
