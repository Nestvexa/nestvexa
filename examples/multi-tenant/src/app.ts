import 'reflect-metadata';
import { Controller, Get, Header, Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ActionsModule } from '@nestvexa/actions';
import { InertiaModule } from '@nestvexa/inertia';
import { RealtimeModule, RealtimeService } from '@nestvexa/realtime';
import { UploadsModule, configureUploads } from '@nestvexa/uploads';
import { NestvexaModule, configureNestvexa } from 'nestvexa';
import type { LiveIdentity } from 'nestvexa';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import session from 'express-session';
import { TenantBoard, TenantProject } from './board.js';
import { origin } from './config.js';
import {
  actionIdentity,
  authorizeChannel,
  currentMember,
  liveIdentity,
  realtimeIdentity,
  sharedProps,
  uploadIdentity,
} from './context.js';
import { ProjectEvents, SummaryCache } from './events.js';
import { Api, Pages } from './pages.js';
import { Directory, TenancyModule } from './tenancy.js';
import {
  ATTACHMENT_PURPOSE,
  AttachmentRepository,
  WorkspaceActions,
  WorkspacePages,
} from './workspace.js';

const root = fileURLToPath(new URL('../views', import.meta.url));

export interface AppOptions {
  /** Uploads storage (temporary and permanent files); default `<example>/data`. */
  readonly dataDirectory?: string;
  readonly logger?: false | ('error' | 'warn' | 'log')[];
}

const memberActions: Readonly<Record<string, readonly string[]>> = {
  'tenant-board': ['$mount', '$sync', 'create', 'changed'],
  'tenant-project': [
    '$mount',
    '$sync',
    'startEdit',
    'cancelEdit',
    'saveEdit',
    'toggleStatus',
  ],
};
/**
 * Live role policy per component action; guests may do nothing. The role is
 * re-checked against the directory, not only read from the binding.
 */
function authorizeLive(
  directory: Directory,
  identity: LiveIdentity,
  component: string,
  action: string,
): boolean {
  const member = currentMember(directory, identity.binding);
  if (!member) return false;
  if (component === 'tenant-project' && action === 'remove')
    return member.role === 'admin';
  return memberActions[component]?.includes(action) ?? false;
}

@Controller()
class Assets {
  @Get('app.css')
  @Header('Content-Type', 'text/css; charset=utf-8')
  styles() {
    return [
      'body{font-family:system-ui,sans-serif;max-width:48rem;margin:0 auto;padding:1rem;line-height:1.5;color:#1b1b1b;background:#fff}',
      'header nav{display:flex;gap:1rem;align-items:center;flex-wrap:wrap}',
      'header form,header form button{margin:0}',
      'label{display:block;font-weight:600;margin-top:.75rem}',
      'input{padding:.4rem;border:2px solid #555;border-radius:4px;font:inherit}',
      'button{padding:.4rem .8rem;font:inherit;margin:.25rem .25rem .25rem 0}',
      '[aria-invalid="true"]{border-color:#b00020}',
      '.error{color:#b00020}',
      '.flash{border-left:4px solid #26a269;padding:.25rem .75rem}',
      '.project{border:1px solid #ccc;border-radius:6px;padding:.5rem .75rem;margin:.5rem 0}',
      ':focus-visible{outline:3px solid #1a5fb4;outline-offset:2px}',
    ].join('');
  }
}

/** Shared domain services for pages, components and action groups. */
@Module({
  imports: [TenancyModule],
  providers: [SummaryCache, ProjectEvents, AttachmentRepository],
  exports: [TenancyModule, SummaryCache, ProjectEvents, AttachmentRepository],
})
class WorkspaceModule {}

function appModule(options: AppOptions): DynamicModule {
  const directory =
    options.dataDirectory ?? fileURLToPath(new URL('../data', import.meta.url));
  @Module({})
  class AppModule {}
  return {
    module: AppModule,
    imports: [
      WorkspaceModule,
      RealtimeModule.forRootAsync({
        imports: [TenancyModule],
        inject: [Directory],
        useFactory: (tenants: Directory) => ({
          // Replicas share a stable secret; a random one suits one process.
          secrets: [randomBytes(32).toString('base64url')],
          origin,
          resolveIdentity: (request: object) =>
            realtimeIdentity(tenants, request),
          authorizeChannel: (identity: { binding: string }, channel: string) =>
            authorizeChannel(tenants, identity, channel),
        }),
      }),
      UploadsModule.registerAsync({
        global: true,
        imports: [TenancyModule],
        inject: [Directory],
        useFactory: (tenants: Directory) => ({
          origin,
          directory: join(directory, 'uploads'),
          resolveIdentity: (request: object) =>
            uploadIdentity(tenants, request),
          // Members of the active tenant only; the tenant is the quota bucket.
          authorize: (identity: { binding: string }, purpose: string) =>
            purpose === ATTACHMENT_PURPOSE &&
            currentMember(tenants, identity.binding) !== undefined,
          purposes: {
            [ATTACHMENT_PURPOSE]: {
              types: ['png', 'pdf', 'txt'],
              maxFileSize: 256 * 1024,
              maxFiles: 1,
            },
          },
        }),
      }),
      ActionsModule.registerAsync({
        groups: [WorkspaceActions],
        imports: [WorkspaceModule],
        inject: [Directory],
        useFactory: (tenants: Directory) => ({
          origin,
          resolveIdentity: (request: object) =>
            actionIdentity(tenants, request),
          // Signed-in members of the active tenant; handlers scope by identity.tenant.
          authorize: (identity, action) =>
            action.group === 'workspace' && identity.tenant !== undefined,
        }),
      }),
      InertiaModule.forRootAsync({
        imports: [TenancyModule],
        inject: [Directory],
        useFactory: (tenants: Directory) => ({
          version: 'multi-tenant-1',
          title: (page) => `${page.component} · Nestvexa workspaces`,
          share: (request: object) => sharedProps(tenants, request),
        }),
      }),
      NestvexaModule.forRoot(
        { views: { root, layout: 'layout' }, live: { enabled: true } },
        {
          browser: {
            uploads: { endpoint: '/_nestvexa/uploads' },
            realtime: { endpoint: '/_nestvexa/realtime', transport: 'sse' },
          },
          components: [TenantBoard, TenantProject],
          imports: [WorkspaceModule],
          inject: [Directory, RealtimeService],
          useFactory: (tenants: Directory, realtime: RealtimeService) => ({
            origin,
            realtime,
            maxRequestsPerMinute: 600,
            resolveIdentity: (request: object) =>
              liveIdentity(tenants, request),
            authorize: (
              identity: LiveIdentity,
              component: string,
              action: string,
            ) => authorizeLive(tenants, identity, component, action),
          }),
        },
      ),
    ],
    controllers: [Pages, Api, WorkspacePages, Assets],
  };
}

/** Builds the configured application without listening (tests and main.ts). */
export async function createApp(
  options: AppOptions = {},
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    appModule(options),
    { logger: options.logger ?? ['error', 'warn'] },
  );
  // Flat urlencoded keys: @nestvexa/forms parses brackets itself.
  app.useBodyParser('urlencoded', { extended: false, limit: '16kb' });
  // Local demonstration: production hosts supply a persistent session store, a
  // deployment secret, HTTPS-only cookies and trusted proxy configuration.
  app.use(
    session({
      name: 'nvtenant.sid',
      secret: randomBytes(48).toString('base64url'),
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
        maxAge: 30 * 60_000,
      },
    }),
  );
  await configureNestvexa(app);
  await configureUploads(app);
  app.enableShutdownHooks();
  return app;
}
