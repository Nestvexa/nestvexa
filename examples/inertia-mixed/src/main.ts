import 'reflect-metadata';
import {
  Controller,
  Get,
  Header,
  Inject,
  Logger,
  Module,
  Render,
  Req,
  UnauthorizedException,
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
  viteViewHelpers,
} from '@nestvexa/vite';
import session from 'express-session';
import {
  Action,
  HbsEngine,
  LiveComponent,
  LiveRuntime,
  NestvexaModule,
  State,
  configureNestvexa,
} from 'nestvexa';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// One Nest backend, five rendering modes side by side: an HBS route, a Live
// route (HBS + Live component, assets from its own Vite manifest), React, Vue
// and Svelte Inertia roots on separate path prefixes, and a JSON API route. Each root has its own
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

declare module 'express-session' {
  interface SessionData {
    csrf?: string;
  }
}
interface SessionRequest {
  session: session.Session & Partial<session.SessionData>;
  sessionID: string;
}

const assets = new ViteAssets({
  apps: {
    ...Object.fromEntries(
      Object.entries(frameworks).map(([key, { entry }]) => [
        key,
        {
          entries: [entry],
          base: `/build/${key}/`,
          manifest: join(root, `dist/${key}/client/.vite/manifest.json`),
        },
      ]),
    ),
    // Framework-free assets of the HBS/Live page (vite.live.config.ts).
    live: {
      entries: ['client/live/app.ts', 'client/live/widgets.ts'],
      base: '/build/live/',
      manifest: join(root, 'dist/live/client/.vite/manifest.json'),
    },
  },
});

@LiveComponent({ name: 'mixed-counter', view: 'live-counter' })
class MixedCounter {
  @State() count = 0;
  @Action() increment(): void {
    this.count++;
  }
}

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
  constructor(@Inject(LiveRuntime) private readonly live: LiveRuntime) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Render('index')
  index() {
    return { title: 'Nestvexa mixed host (HBS)' };
  }

  /** HBS page with a Live component; its assets come through `viteTags`. */
  @Get('live')
  @Header('Cache-Control', 'no-store')
  @Render('live')
  async liveRoute(@Req() request: SessionRequest) {
    request.session.csrf ??= randomBytes(32).toString('base64url');
    return {
      title: 'Nestvexa mixed host (Live)',
      live: true,
      cspNonce: cspNonce(request),
      widget: await this.live.mount(MixedCounter, request),
    };
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

  /**
   * React page hosting an isolated Live element (VISION-017). The mount is a
   * lazy prop, so a partial reload of other props neither re-mounts nor
   * replaces the Live component the browser already owns.
   */
  @Get('react/live')
  @Header('Cache-Control', 'no-store')
  @InertiaPage('LiveHost')
  reactLive(@Req() request: SessionRequest) {
    request.session.csrf ??= randomBytes(32).toString('base64url');
    return {
      ...pageProps('react', 'live host'),
      live: async () => (await this.live.mount(MixedCounter, request)).value,
      stamp: () => Date.now(),
    };
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
    NestvexaModule.forRoot(
      {
        views: { root: join(root, 'views'), layout: 'layouts/main' },
        live: { enabled: true },
      },
      {
        components: [MixedCounter],
        useFactory: () => ({
          origin: `http://127.0.0.1:${port}`,
          resolveIdentity(request: object) {
            const value = request as Partial<SessionRequest>;
            if (!value.session?.csrf || !value.sessionID)
              throw new UnauthorizedException();
            return {
              binding: `guest-session:${value.sessionID}`,
              csrfToken: value.session.csrf,
            };
          },
          authorize: (_identity, component, action) =>
            component === 'mixed-counter' &&
            ['$mount', 'increment'].includes(action),
        }),
      },
    ),
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
// Local guest demonstration: production hosts supply authentication, a
// persistent session store, a deployment secret and HTTPS cookies.
app.use(
  session({
    secret: randomBytes(48).toString('base64url'),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'strict', secure: false },
  }),
);
// Optional helpers register before the shared HBS engine initializes.
app.get(HbsEngine).registerHelpers(viteViewHelpers(assets));
await configureNestvexa(app);
app.use(cspNonceMiddleware());
for (const key of [...Object.keys(frameworks), 'live'])
  app.use(
    viteStaticMiddleware({
      root: join(root, `dist/${key}/client`),
      prefix: `/build/${key}/`,
    }),
  );
app.enableShutdownHooks();
await app.listen(port, '127.0.0.1');
logger.log(`Mixed host on http://127.0.0.1:${port}`);
