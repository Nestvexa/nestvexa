import type { INestApplication } from '@nestjs/common';
import type {
  InertiaAppOptions,
  InertiaModuleOptions,
} from '@nestvexa/inertia';
import {
  ViteAssets,
  moduleSsrRenderer,
  viteInertiaRootView,
  viteStaticMiddleware,
} from '@nestvexa/vite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface InertiaFramework {
  /** Vite input of the browser entry. */
  readonly entry: string;
  /** SSR entry (`vite build --ssr`); production renders pages on the server with it. */
  readonly ssr?: string;
  /** Port of this root's Vite dev server (`npm run dev:<key>`). */
  readonly devPort: number;
}
/**
 * One Inertia root per frontend framework, each with its own Vite build,
 * manifest and asset version. `nestvexa add react|vue|svelte` appends here.
 */
export const inertiaFrameworks: Record<string, InertiaFramework> = {
  react: {
    entry: 'client/react/app.tsx',
    ssr: 'client/react/ssr.tsx',
    devPort: 5173,
  },
  vue: { entry: 'client/vue/app.ts', ssr: 'client/vue/ssr.ts', devPort: 5174 },
  svelte: {
    entry: 'client/svelte/app.ts',
    ssr: 'client/svelte/ssr.ts',
    devPort: 5175,
  },
  // nestvexa:inertia-apps
};

const root = process.cwd();
/**
 * Built assets (manifests, SSR bundles) in production, or in development with
 * NESTVEXA_ASSETS=build (end-to-end tests without Vite dev servers).
 */
const built =
  process.env['NODE_ENV'] === 'production' ||
  process.env['NESTVEXA_ASSETS'] === 'build';

function inertiaApp(
  key: string,
  framework: InertiaFramework,
): InertiaAppOptions {
  // Production reads dist/<key>/client/.vite/manifest.json at startup and fails
  // fast when the build is missing; development points at the Vite dev server.
  const assets = new ViteAssets({
    mode: built ? 'production' : 'development',
    ...(built ? {} : { devOrigin: `http://localhost:${framework.devPort}` }),
    apps: {
      [key]: {
        entries: [framework.entry],
        base: `/build/${key}/`,
        manifest: join(root, `dist/${key}/client/.vite/manifest.json`),
      },
    },
  });
  return {
    version: assets.version(key),
    rootView: viteInertiaRootView(assets, { app: key }),
    ...(built && framework.ssr ? { ssr: ssrOptions(key) } : {}),
  };
}

/**
 * Production SSR from the built bundle (dist/<key>/ssr/ssr.mjs), imported once
 * in-process. A failed render falls back to the client-rendered root view.
 * Development renders in the browser through the Vite dev server.
 */
function ssrOptions(key: string): NonNullable<InertiaAppOptions['ssr']> {
  const bundle = join(root, `dist/${key}/ssr/ssr.mjs`);
  if (!existsSync(bundle))
    throw new Error(
      `${bundle} is missing; run the ${key} build before starting`,
    );
  return {
    renderer: moduleSsrRenderer(bundle, { timeoutMs: 3000 }),
    mode: 'fallback',
    onError: (error) =>
      console.warn(
        `${key} SSR failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      ),
  };
}

/** Options for `InertiaModule.forRoot`. Pages select their root with `@InertiaPage(name, { app })`. */
export function inertiaOptions(): InertiaModuleOptions {
  const apps = Object.fromEntries(
    Object.entries(inertiaFrameworks).map(([key, framework]) => [
      key,
      inertiaApp(key, framework),
    ]),
  );
  const [first] = Object.keys(apps);
  return {
    ...(first === undefined ? {} : { apps, defaultApp: first }),
  };
}

/** Serves each root's built assets; Vite dev servers serve them in development. */
export function configureInertia(app: INestApplication): void {
  if (!built) return;
  for (const key of Object.keys(inertiaFrameworks))
    app.use(
      viteStaticMiddleware({
        root: join(root, `dist/${key}/client`),
        prefix: `/build/${key}/`,
      }),
    );
}
