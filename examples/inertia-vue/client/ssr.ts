import {
  createVueSsrRender,
  isMainModule,
  startVueSsrServer,
} from '@nestvexa/vue/ssr';
import { layout, pages, title } from './setup';

/** `render(page)` → `{ head, body }`, imported in-process by the Nest host. */
export const render = createVueSsrRender({ pages, layout, title });

// Optional: `node dist/ssr/ssr.js` serves the same render function through the
// official Inertia SSR HTTP server for HttpSsrGateway deployments.
if (isMainModule(import.meta.url))
  startVueSsrServer(render, {
    port: Number(process.env['SSR_PORT'] ?? 13717),
  });
