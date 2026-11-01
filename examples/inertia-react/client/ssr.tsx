import {
  createReactSsrRender,
  isMainModule,
  startReactSsrServer,
} from '@nestvexa/react/ssr';
import { layout, pages, title } from './setup';

/** `render(page)` → `{ head, body }` (also usable in-process). */
export const render = createReactSsrRender({ pages, layout, title });

// `node dist/ssr/ssr.js` runs the official Inertia SSR HTTP server, which the
// Nest host reaches through HttpSsrGateway (loopback only).
if (isMainModule(import.meta.url))
  startReactSsrServer(render, {
    port: Number(process.env['SSR_PORT'] ?? 13716),
  });
