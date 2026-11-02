import '@vitejs/plugin-react/preamble';
import { mountReactInertiaApp } from '@nestvexa/react';
import { layout, pages, title } from './setup';
import './styles.css';

// Hydrates the server-rendered markup (or mounts when SSR fell back) with the
// official @inertiajs/react client.
void mountReactInertiaApp({
  pages,
  layout,
  title,
  progress: { color: '#1d4ed8', showSpinner: false },
});
