import 'reflect-metadata';
import {
  Controller,
  Get,
  Header,
  Logger,
  Module,
  Render,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { InertiaModule, InertiaPage } from '@nestvexa/inertia';
import type { InertiaAppOptions } from '@nestvexa/inertia';
import {
  ViteAssets,
  cspNonce,
  cspNonceMiddleware,
  moduleSsrRenderer,
  viteInertiaRootView,
  viteStaticMiddleware,
} from '@nestvexa/vite';
import { NestvexaModule, configureNestvexa } from 'nestvexa';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// One Nest backend, five rendering modes side by side: an HBS route, and React,
// Vue and Svelte Inertia roots on separate path prefixes. Each root has its own
// Vite build, manifest, asset version and in-process SSR bundle, so a visit
// that crosses roots gets a 409 version conflict and a full page load.

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env['PORT'] ?? 3109);
const logger = new Logger('InertiaMixedExample');
// SSR bundles load lazily on first render; select production framework builds.
process.env['NODE_ENV'] ??= 'production';
const frameworks = {
  react: { entry: 'client/react/app.tsx', label: 'React' },
  vue: { entry: 'client/vue/app.ts', label: 'Vue' },
  svelte: { entry: 'client/svelte/app.ts', label: 'Svelte' },
} as const;
type Framework = keyof typeof frameworks;

const assets = new ViteAssets({
  apps: Object.fromEntries(
    Object.entries(frameworks).map(([key, { entry }]) => [
      key,
      {
        entries: [entry],
        base: `/build/${key}/`,
        manifest: join(root, `dist/${key}/client/.vite/manifest.json`),
      },
    ]),
  ),
});

function inertiaApp(key: Framework): InertiaAppOptions {
  return {
    paths: [`/${key}`],
    version: assets.version(key),
    rootView: viteInertiaRootView(assets, { app: key }),
    title: (page) => `${page.component} · ${frameworks[key].label} root`,
    ssr: {
      renderer: moduleSsrRenderer(join(root, `dist/${key}/ssr/ssr.js`)),
      mode: 'fallback',
      onError: (error) =>
        logger.warn(
          `${key} SSR failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        ),
    },
  };
}

function pageProps(key: Framework, page: string) {
  return {
    framework: frameworks[key].label,
    heading: `${frameworks[key].label} ${page}`,
  };
}

@Controller()
class MixedController {
  @Get()
  @Header('Cache-Control', 'no-store')
  @Render('index')
  index() {
    return { title: 'Nestvexa mixed host (HBS)' };
  }

  @Get('react')
  @InertiaPage('Home')
  reactHome() {
    return pageProps('react', 'home');
  }

  @Get('react/about')
  @InertiaPage('About')
  reactAbout() {
    return pageProps('react', 'about');
  }

  @Get('vue')
  @InertiaPage('Home')
  vueHome() {
    return pageProps('vue', 'home');
  }

  @Get('vue/about')
  @InertiaPage('About')
  vueAbout() {
    return pageProps('vue', 'about');
  }

  @Get('svelte')
  @InertiaPage('Home')
  svelteHome() {
    return pageProps('svelte', 'home');
  }

  @Get('svelte/about')
  @InertiaPage('About')
  svelteAbout() {
    return pageProps('svelte', 'about');
  }

  @Get('api/health')
  health() {
    return { status: 'ok', roots: Object.keys(frameworks) };
  }
}

@Module({
  imports: [
    NestvexaModule.forRoot({
      views: {
        root: join(root, 'views'),
        layout: 'layouts/main',
      },
    }),
    InertiaModule.forRoot({
      apps: {
        react: inertiaApp('react'),
        vue: inertiaApp('vue'),
        svelte: inertiaApp('svelte'),
      },
      defaultApp: 'react',
      nonce: (request) => cspNonce(request),
      share: () => ({ host: 'Nestvexa mixed host' }),
      session: false,
    }),
  ],
  controllers: [MixedController],
})
class AppModule {}

const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  logger: ['error', 'warn', 'log'],
});
await configureNestvexa(app);
app.use(cspNonceMiddleware());
for (const key of Object.keys(frameworks))
  app.use(
    viteStaticMiddleware({
      root: join(root, `dist/${key}/client`),
      prefix: `/build/${key}/`,
    }),
  );
app.enableShutdownHooks();
await app.listen(port, '127.0.0.1');
logger.log(`Mixed host on http://127.0.0.1:${port}`);
