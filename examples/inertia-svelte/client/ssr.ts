import { createInertiaApp } from '@inertiajs/svelte';
import createServer from '@inertiajs/svelte/server';
import {
  createSvelteSsrRender,
  isMainModule,
  startOfficialSsrServer,
} from '@nestvexa/svelte/ssr';
import { layout, pages } from './setup';

/** `render(page)` → `{ head, body }`, imported in-process by the Nest host. */
export const render = createSvelteSsrRender({
  createInertiaApp,
  pages,
  layout,
});

// Optional: `node dist/ssr/ssr.js` serves the same render function through the
// official Inertia SSR HTTP server for HttpSsrGateway deployments.
if (isMainModule(import.meta.url))
  startOfficialSsrServer(createServer, render, {
    port: Number(process.env['SSR_PORT'] ?? 13718),
  });
