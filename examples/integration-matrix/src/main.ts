import 'reflect-metadata';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ActionsModule } from '@nestvexa/actions';
import { InertiaModule } from '@nestvexa/inertia';
import type { InertiaAppOptions } from '@nestvexa/inertia';
import { RealtimeModule, RealtimeService } from '@nestvexa/realtime';
import { UploadsModule, configureUploads } from '@nestvexa/uploads';
import {
  ViteAssets,
  cspNonce,
  cspNonceMiddleware,
  moduleSsrRenderer,
  viteInertiaRootView,
  viteStaticMiddleware,
} from '@nestvexa/vite';
import { HbsEngine, NestvexaModule, configureNestvexa } from 'nestvexa';
import session from 'express-session';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdminController, frameworks } from './admin.js';
import type { Framework } from './admin.js';
import { Counter } from './counter.js';
import { HealthController } from './health.js';
import { Notifications, ScoreboardActions } from './hybrid.js';
import type { SessionRequest } from './identity.js';
import {
  bindingOf,
  isOperatorBinding,
  liveIdentity,
  origin,
  port,
} from './identity.js';
import { PagesController } from './pages.js';
import { ProductTable, ProductsModule, formatPrice } from './products.js';
import {
  RealtimePanel,
  RealtimeStoreModule,
  authorizeChannel,
} from './realtime.js';

// One Nest (Express) server, every rendering mode side by side: HBS MVC, Live
// components, three Inertia roots with SSR, framework islands, a universal
// server action, realtime SSE and a native REST controller.

const root = fileURLToPath(new URL('..', import.meta.url));
const logger = new Logger('IntegrationMatrix');
// SSR bundles load lazily on first render; select production framework builds.
process.env['NODE_ENV'] ??= 'production';
// Private upload storage outside any served directory.
const uploadsDirectory =
  process.env['UPLOADS_DIR'] ??
  join(tmpdir(), `nestvexa-integration-matrix-${port}`);

const assets = new ViteAssets({
  apps: Object.fromEntries(
    (Object.keys(frameworks) as Framework[]).map((key) => [
      key,
      {
        entries: [
          key === 'react' ? 'client/react/app.tsx' : `client/${key}/app.ts`,
        ],
        base: `/build/${key}/`,
        manifest: join(root, `dist/${key}/client/.vite/manifest.json`),
      },
    ]),
  ),
});

function inertiaApp(key: Framework): InertiaAppOptions {
  return {
    paths: [`/admin/${key}`],
    version: assets.version(key),
    rootView: viteInertiaRootView(assets, { app: key }),
    title: (page) => `${page.component} · ${frameworks[key]} admin`,
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

/** Live actions each component may run; everything else is refused. */
const liveActions: Readonly<Record<string, readonly string[]>> = {
  counter: ['$mount', '$sync', 'increment', 'decrement', 'reset'],
  'product-table': ['$mount', '$sync', 'search', 'sortBy', 'create'],
  notifications: ['$mount', 'notify'],
  'realtime-panel': ['$mount', '$sync', 'post', 'raiseAlert'],
};

@Module({
  imports: [
    ProductsModule,
    RealtimeModule.forRoot({
      secrets: [randomBytes(48).toString('base64url')],
      origin,
      resolveIdentity: (request) => ({ binding: bindingOf(request) }),
      authorizeChannel,
    }),
    UploadsModule.register({
      global: true,
      origin,
      directory: uploadsDirectory,
      resolveIdentity: liveIdentity,
      authorize: (_identity, purpose) => purpose === 'product-table.image',
      tokenTtlMs: 15 * 60_000,
      purposes: {
        'product-table.image': {
          types: ['png', 'jpeg'],
          maxFileSize: 512 * 1024,
          maxFiles: 1,
        },
      },
    }),
    ActionsModule.register({
      groups: [ScoreboardActions],
      origin,
      resolveIdentity(request) {
        const value = request as Partial<SessionRequest>;
        if (!value.session?.csrf || !value.sessionID) return null;
        return {
          subject: bindingOf(request),
          csrfToken: value.session.csrf,
        };
      },
      authorize: (_identity, action) => action.group === 'scoreboard',
    }),
    NestvexaModule.forRoot(
      {
        views: { root: join(root, 'views'), layout: 'layout' },
        live: { enabled: true },
      },
      {
        browser: {
          uploads: { endpoint: '/_nestvexa/uploads' },
          realtime: { endpoint: '/_nestvexa/realtime' },
        },
        components: [Counter, ProductTable, Notifications, RealtimePanel],
        imports: [ProductsModule, RealtimeStoreModule],
        inject: [RealtimeService],
        useFactory: (realtime: RealtimeService) => ({
          origin,
          realtime,
          resolveIdentity: liveIdentity,
          authorize: (identity, component, action) =>
            (liveActions[component]?.includes(action) ?? false) &&
            // Only operator sessions may raise alerts.
            (action !== 'raiseAlert' || isOperatorBinding(identity.binding)),
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
      share: (request) => {
        const path = String(Reflect.get(request, 'path') ?? '');
        const key =
          (Object.keys(frameworks) as Framework[]).find((name) =>
            path.startsWith(`/admin/${name}`),
          ) ?? 'react';
        return {
          appName: 'Nestvexa integration matrix',
          framework: frameworks[key],
          root: `/admin/${key}`,
        };
      },
    }),
  ],
  controllers: [PagesController, AdminController, HealthController],
})
class AppModule {}

const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  logger: ['error', 'warn'],
});
// Local demonstration only: production hosts supply authentication, a
// persistent session store, a deployment secret, HTTPS cookies and policies.
app.use(
  session({
    secret: randomBytes(48).toString('base64url'),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      secure: false,
      maxAge: 900_000,
    },
  }),
);
// Nonce-based CSP for the Vite-built Inertia documents only; HBS routes set
// their own `script-src 'self'` policy.
app.use('/admin', cspNonceMiddleware());
for (const key of Object.keys(frameworks))
  app.use(
    viteStaticMiddleware({
      root: join(root, `dist/${key}/client`),
      prefix: `/build/${key}/`,
    }),
  );
// Trusted application helpers register before the engine initializes.
app.get(HbsEngine).registerHelpers({
  price: (cents: unknown) =>
    typeof cents === 'number' ? formatPrice(cents) : '',
  year: () => String(new Date().getUTCFullYear()),
});
await configureNestvexa(app);
await configureUploads(app);
app.enableShutdownHooks();
await app.listen(port, '127.0.0.1');
console.log(`Integration matrix on ${origin}`);
