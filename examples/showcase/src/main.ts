import 'reflect-metadata';
import { Controller, Get, Header, Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { InertiaModule } from '@nestvexa/inertia';
import {
  ConsoleMailTransport,
  MailModule,
  MemoryMailTransport,
} from '@nestvexa/mail';
import {
  MemoryRealtimeBroker,
  RealtimeModule,
  RealtimeService,
} from '@nestvexa/realtime';
import { RedisRealtimeBroker } from '@nestvexa/realtime-redis/realtime';
import { S3Storage, UploadsModule, configureUploads } from '@nestvexa/uploads';
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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiController } from './api.js';
import {
  dataDirectory,
  exampleRoot,
  host,
  instance,
  mailMode,
  origin,
  port,
  redis,
  s3,
  secret,
} from './config.js';
import { ShowcaseData } from './data.js';
import {
  IdentityModule,
  authorizeChannel,
  authorizeLive,
  bindingOf,
  directory,
  liveIdentity,
  parseBinding,
} from './identity.js';
import { InsightsController } from './insights.js';
import { MetricsPanel, SharedState } from './metrics.js';
import { Notifier } from './notify.js';
import { ASSETS, MAIL_OUTBOX, PagesController } from './pages.js';
import type { MailOutbox } from './pages.js';
import {
  DraftsModule,
  ProfileService,
  ProfileWizard,
  avatarPurpose,
} from './profile.js';
import { TaskBoard, TaskEditor, TaskRow, attachmentPurpose } from './tasks.js';

/*
 * The Nestvexa showcase: one Nest (Express) application for two fictional
 * product teams. HBS pages with Live components (dashboard, task board,
 * profile wizard), a Vue island, a Vue Inertia section with SSR, uploads,
 * realtime over SSE, mail notifications and a native REST API, all sharing
 * one host-owned identity (src/identity.ts).
 */

const logger = new Logger('Showcase');
const views = join(exampleRoot, 'views');

const assets = new ViteAssets({
  apps: {
    insights: {
      entries: ['client/inertia/app.ts'],
      base: '/build/',
      manifest: join(exampleRoot, 'dist/client/.vite/manifest.json'),
    },
    islands: {
      entries: ['client/islands/loader.ts'],
      base: '/build/',
      manifest: join(exampleRoot, 'dist/client/.vite/manifest.json'),
    },
  },
});

/** Test transport by default (captured for the outbox page); console logs instead. */
const memoryMail =
  mailMode === 'memory'
    ? new MemoryMailTransport({ maxMessages: 500 })
    : undefined;
const outbox: MailOutbox = { memory: memoryMail };
const mailViews = new HbsEngine({ root: views });

/** Local storage in the data directory, or an S3-compatible bucket from the environment. */
const storage = s3
  ? new S3Storage({
      endpoint: s3.endpoint,
      region: s3.region,
      bucket: s3.bucket,
      credentials: {
        accessKeyId: s3.accessKeyId,
        secretAccessKey: s3.secretAccessKey,
      },
    })
  : undefined;

@Module({
  imports: [IdentityModule, DraftsModule],
  providers: [ShowcaseData, SharedState, Notifier, ProfileService],
  exports: [
    IdentityModule,
    DraftsModule,
    ShowcaseData,
    SharedState,
    Notifier,
    ProfileService,
  ],
})
class DomainModule {}

@Controller('assets')
class AssetsController {
  readonly #css = readFileSync(join(exampleRoot, 'public/app.css'), 'utf8');
  readonly #dialog = readFileSync(
    join(exampleRoot, 'public/dialog.js'),
    'utf8',
  );
  @Get('app.css')
  @Header('Content-Type', 'text/css; charset=utf-8')
  @Header('Cache-Control', 'no-cache')
  css(): string {
    return this.#css;
  }
  @Get('dialog.js')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  @Header('Cache-Control', 'no-cache')
  dialog(): string {
    return this.#dialog;
  }
}

@Module({
  imports: [
    DomainModule,
    MailModule.forRoot({
      global: true,
      transport: memoryMail ?? new ConsoleMailTransport(),
      from: { address: 'noreply@showcase.test', name: 'Nestvexa Showcase' },
      templates: { renderer: mailViews, layout: 'emails/layout' },
    }),
    RealtimeModule.forRoot({
      // Replicas behind one load balancer must share this secret.
      secrets: [secret('REALTIME_SECRET')],
      origin,
      broker: redis
        ? new RedisRealtimeBroker({
            host: redis.host,
            port: redis.port,
            ...(redis.password ? { password: redis.password } : {}),
            prefix: `${redis.prefix}rt:`,
          })
        : new MemoryRealtimeBroker(),
      resolveIdentity: (request) => ({
        binding: bindingOf(directory, request),
      }),
      authorizeChannel,
      describePresence: (identity) => {
        const access = parseBinding(identity.binding);
        const user = access ? directory.account(access.userId) : undefined;
        return user ? { id: user.id, label: user.name } : undefined;
      },
    }),
    UploadsModule.register({
      global: true,
      origin,
      directory: join(dataDirectory, 'uploads'),
      ...(storage ? { storage } : {}),
      resolveIdentity: (request) => liveIdentity(directory, request),
      // Signed-in workspace members only, for the two purposes below.
      authorize: (identity, purpose) =>
        parseBinding(identity.binding) !== undefined &&
        (purpose === attachmentPurpose || purpose === avatarPurpose),
      tokenTtlMs: 15 * 60_000,
      purposes: {
        [attachmentPurpose]: {
          types: ['png', 'jpeg', 'pdf', 'txt'],
          maxFileSize: 1024 * 1024,
          maxFiles: 1,
        },
        [avatarPurpose]: {
          types: ['png', 'jpeg'],
          maxFileSize: 512 * 1024,
          maxFiles: 1,
        },
      },
    }),
    NestvexaModule.forRoot(
      { views: { root: views, layout: 'layout' }, live: { enabled: true } },
      {
        browser: {
          uploads: { endpoint: '/_nestvexa/uploads' },
          realtime: { endpoint: '/_nestvexa/realtime', transport: 'sse' },
        },
        components: [
          MetricsPanel,
          TaskBoard,
          TaskRow,
          TaskEditor,
          ProfileWizard,
        ],
        imports: [DomainModule],
        inject: [RealtimeService],
        useFactory: (realtime: RealtimeService) => ({
          origin,
          realtime,
          maxRequestsPerMinute: 600,
          resolveIdentity: (request: object) =>
            liveIdentity(directory, request),
          authorize: authorizeLive,
        }),
      },
    ),
    InertiaModule.forRoot({
      apps: {
        insights: {
          paths: ['/insights'],
          version: assets.version('insights'),
          rootView: viteInertiaRootView(assets, {
            app: 'insights',
            head: '<link rel="stylesheet" href="/assets/app.css">',
          }),
          title: (page) => `${page.component} · Nestvexa Showcase`,
          ssr: {
            renderer: moduleSsrRenderer(join(exampleRoot, 'dist/ssr/ssr.js')),
            mode: 'fallback',
            onError: (error) =>
              logger.warn(
                `Inertia SSR failed: ${error instanceof Error ? error.message : 'unknown error'}`,
              ),
          },
        },
      },
      defaultApp: 'insights',
      nonce: (request) => cspNonce(request),
      share: (request) => {
        const access = directory.access(request);
        return {
          appName: 'Nestvexa Showcase',
          userName: access?.user.name ?? '',
          role: access?.role ?? 'member',
          workspace: access?.workspace.name ?? '',
        };
      },
    }),
  ],
  controllers: [
    PagesController,
    InsightsController,
    ApiController,
    AssetsController,
  ],
  providers: [
    { provide: ASSETS, useValue: assets },
    { provide: MAIL_OUTBOX, useValue: outbox },
  ],
})
class AppModule {}

const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  logger: ['error', 'warn'],
});
// Flat urlencoded keys: @nestvexa/forms parses brackets itself.
app.useBodyParser('urlencoded', { extended: false, limit: '16kb' });
// Demonstration sessions: in-memory and per process. Production hosts use a
// shared session store, a stable SESSION_SECRET and Secure cookies over HTTPS.
app.use(
  session({
    name: 'showcase.sid',
    secret: secret('SESSION_SECRET'),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: origin.startsWith('https:'),
      maxAge: 60 * 60_000,
    },
  }),
);
// Nonce-based CSP for the Vite-built Inertia documents; HBS pages set their own.
app.use('/insights', cspNonceMiddleware());
app.use(
  viteStaticMiddleware({
    root: join(exampleRoot, 'dist/client'),
    prefix: '/build/',
  }),
);
await configureNestvexa(app);
await configureUploads(app);
app.enableShutdownHooks();
await app.listen(port, host);
console.log(
  `Nestvexa showcase (${instance}) on ${origin} — realtime ${redis ? 'redis' : 'memory'}, storage ${s3 ? 's3' : 'local'}, mail ${mailMode}`,
);
