import 'reflect-metadata';
import {
  Controller,
  Get,
  Header,
  Inject,
  Logger,
  Module,
  Req,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { IslandRegistry, moduleIslandRenderers } from '@nestvexa/islands';
import {
  ViteAssets,
  createViteDevServer,
  cspNonce,
  cspNonceMiddleware,
  viteStaticMiddleware,
} from '@nestvexa/vite';
import type { ViteDevHandle } from '@nestvexa/vite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { islandDefinitions } from './island-definitions.js';

// Islands built and served through @nestvexa/vite.
//  production: dist/islands (island chunks + .vite/islands-manifest.json from
//  islandsVitePlugin), dist/ssr/ssr.js (`vite build --ssr`) and dist/client
//  (the loader, tagged from its own Vite manifest with the request nonce);
//  development (--dev): the Vite dev middleware serves source modules with
//  HMR on this server, and SSR goes through ssrLoadModule on every render.

const root = fileURLToPath(new URL('..', import.meta.url));
const dev = process.argv.includes('--dev');
const port = Number(process.env['PORT'] ?? 3479);
const logger = new Logger('IslandsViteExample');
const ISLANDS = Symbol('islands');
const ASSETS = Symbol('assets');
const ids = islandDefinitions.map((island) => island.id);

// Created after the Nest app so its HTTP server can carry the HMR socket.
let vite: ViteDevHandle | undefined;
const devSsrModule = (): Promise<Record<string, unknown>> => {
  if (!vite) throw new Error('Vite dev server is not ready');
  return vite.server.ssrLoadModule('/client/ssr.ts');
};
const onRenderError = (error: unknown, id: string): void =>
  logger.error(
    `Island ${id} SSR failed: ${error instanceof Error ? error.message : 'unknown error'}`,
  );

const islands = dev
  ? new IslandRegistry(islandDefinitions, {
      renderers: moduleIslandRenderers(ids, devSsrModule, { cache: false }),
      onRenderError,
    })
  : IslandRegistry.fromManifest(
      JSON.parse(
        readFileSync(
          join(root, 'dist/islands/.vite/islands-manifest.json'),
          'utf8',
        ),
      ),
      {
        renderers: moduleIslandRenderers(
          ids,
          () => import(pathToFileURL(join(root, 'dist/ssr/ssr.js')).href),
        ),
        onRenderError,
      },
    );

const assets = dev
  ? new ViteAssets({
      mode: 'development',
      apps: {
        islands: { entries: ['client/loader.dev.ts'], base: '/islands/' },
      },
    })
  : new ViteAssets({
      apps: {
        islands: {
          entries: ['client/loader.ts'],
          base: '/build/',
          manifest: join(root, 'dist/client/.vite/manifest.json'),
        },
      },
    });

@Controller()
class PagesController {
  constructor(
    @Inject(ISLANDS) private readonly registry: IslandRegistry,
    @Inject(ASSETS) private readonly viteAssets: ViteAssets,
  ) {}

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  async home(@Req() request: object): Promise<string> {
    const context = { locale: 'en', direction: 'ltr' } as const;
    const [react, vue, svelte] = await Promise.all([
      this.registry.renderSsr(
        'counter-react',
        { label: 'React clicks', start: 1 },
        { label: 'React counter', context },
      ),
      this.registry.renderSsr(
        'counter-vue',
        { label: 'Vue clicks', start: 2 },
        { label: 'Vue counter', context },
      ),
      this.registry.renderSsr(
        'counter-svelte',
        { label: 'Svelte clicks', start: 3 },
        { label: 'Svelte counter', context },
      ),
    ]);
    const tags = this.viteAssets.tags('islands', { nonce: cspNonce(request) });
    return (
      '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      `<title>Islands through Vite</title>${tags}` +
      `${this.registry.contextScript(context).value}</head><body><main>` +
      `<h1>Islands through Vite (${dev ? 'development' : 'production'})</h1>` +
      `${react.value}${vue.value}${svelte.value}</main></body></html>`
    );
  }
}

@Module({
  controllers: [PagesController],
  providers: [
    { provide: ISLANDS, useValue: islands },
    { provide: ASSETS, useValue: assets },
  ],
})
class AppModule {}

const app = await NestFactory.create<NestExpressApplication>(AppModule);
app.use(cspNonceMiddleware());
if (dev) {
  // HMR rides on the Nest HTTP server: no extra port is opened.
  vite = await createViteDevServer({
    root,
    configFile: join(root, 'vite.islands.config.ts'),
    hmrServer: app.getHttpServer(),
  });
  app.use(vite.middlewares);
} else {
  app.use(
    viteStaticMiddleware({
      root: join(root, 'dist/islands'),
      prefix: '/islands/',
    }),
  );
  app.use(
    viteStaticMiddleware({
      root: join(root, 'dist/client'),
      prefix: '/build/',
    }),
  );
}
app.enableShutdownHooks();
await app.listen(port, '127.0.0.1');
logger.log(
  `Islands example on http://127.0.0.1:${port} (${dev ? 'Vite dev' : 'production'})`,
);
