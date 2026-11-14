import 'reflect-metadata';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  Injectable,
  Module,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Cache, MemoryCacheStore, RenderCache } from '@nestvexa/cache';
import type { CacheEvent, RenderCacheContext } from '@nestvexa/cache';
import {
  Action,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  State,
} from '@nestvexa/live';
import { SafeHtml } from '@nestvexa/views';
import session from 'express-session';
import { HbsEngine, NestvexaModule, configureNestvexa } from 'nestvexa';
import { NestvexaAssetsModule, NestvexaAssetsService } from 'nestvexa/assets';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SqliteLiveStore } from './sqlite-live-store.js';

declare module 'express-session' {
  interface SessionData {
    csrf?: string;
    user?: string;
  }
}
interface SessionRequest {
  session: session.Session & Partial<session.SessionData>;
  sessionID: string;
  headers: Record<string, string | string[] | undefined>;
}
interface Reply {
  setHeader(name: string, value: string): void;
}

/** Demo directory: the tenant and role come from here, never from the client. */
const directory: Readonly<
  Record<string, { tenant: string; role: 'admin' | 'viewer'; name: string }>
> = {
  alice: { tenant: 'tenant-a', role: 'admin', name: 'Alice' },
  bob: { tenant: 'tenant-a', role: 'viewer', name: 'Bob' },
  carol: { tenant: 'tenant-b', role: 'admin', name: 'Carol' },
};
const permissionsOf = (role: 'admin' | 'viewer') =>
  role === 'admin' ? ['products:read', 'products:write'] : ['products:read'];
const messages = {
  en: { catalog: 'Catalog', edit: 'Edit', footer: 'Prices include VAT.' },
  ar: { catalog: 'الكتالوج', edit: 'تعديل', footer: 'الأسعار تشمل الضريبة.' },
} as const;
/** Server-side negotiation between the two demo locales. */
function negotiate(request: SessionRequest): 'en' | 'ar' {
  const header = request.headers['accept-language'];
  const text = Array.isArray(header) ? header.join(',') : (header ?? '');
  return /^\s*ar\b/i.test(text) ? 'ar' : 'en';
}

const root = fileURLToPath(new URL('../views', import.meta.url));

@LiveComponent({ name: 'cart', view: 'cart' })
class Cart {
  @State() items = 0;
  @Action() add(): void {
    if (this.items < 99) this.items++;
  }
  @Action() clear(): void {
    this.items = 0;
  }
}

export interface DataCacheAppOptions {
  readonly port: number;
  /** SQLite file for Live state (`:memory:` for one process). */
  readonly databasePath: string;
  /** Deployed asset version entering every render cache key. */
  readonly assetVersion?: string;
}

/** Products per tenant, the caches and the last telemetry events. */
@Injectable()
export class CatalogService {
  readonly events: CacheEvent[] = [];
  readonly cache = new Cache({
    store: new MemoryCacheStore(500),
    onEvent: (event) => {
      this.events.push(event);
      if (this.events.length > 200) this.events.shift();
    },
  });
  readonly renders = new RenderCache(this.cache);
  /** Times each fragment really rendered (to show hits in the demo and tests). */
  readonly renderCounts = { catalog: 0, footer: 0, account: 0 };
  readonly #products = new Map<string, string[]>([
    ['tenant-a', ['Desk lamp', 'Notebook']],
    ['tenant-b', ['Kettle']],
  ]);
  products(tenant: string): readonly string[] {
    return this.#products.get(tenant) ?? [];
  }
  async addProduct(tenant: string, name: string): Promise<void> {
    this.#products.set(tenant, [...this.products(tenant), name]);
    // Every catalog fragment of this tenant (all locales and permission scopes).
    await this.cache.invalidate([`products:${tenant}`]);
  }
}

function user(request: SessionRequest) {
  const id = request.session.user;
  const found = id === undefined ? undefined : directory[id];
  return found && id ? { id, ...found } : undefined;
}
function sameToken(expected: string | undefined, actual: unknown): boolean {
  if (!expected || typeof actual !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function createDataCacheApp(
  options: DataCacheAppOptions,
): Promise<{ app: INestApplication; catalog: CatalogService }> {
  const renderer = new HbsEngine({ root });
  const assetVersion = options.assetVersion ?? 'dev';
  const store = new SqliteLiveStore({ path: options.databasePath });

  class RendererLifecycle {
    onModuleInit(): Promise<void> {
      return renderer.initialize();
    }
    onApplicationShutdown(): Promise<void> {
      return renderer.dispose();
    }
  }

  @Controller()
  class PageController {
    constructor(
      @Inject(LiveRuntime) private readonly live: LiveRuntime,
      @Inject(CatalogService) private readonly catalog: CatalogService,
      @Inject(NestvexaAssetsService)
      private readonly assets: NestvexaAssetsService,
    ) {}
    @Get()
    @Header('Cache-Control', 'private, no-store')
    @Header('Content-Type', 'text/html; charset=utf-8')
    @Header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    )
    async page(
      @Req() request: SessionRequest,
      @Res({ passthrough: true }) reply: Reply,
    ): Promise<string> {
      request.session.csrf ??= randomBytes(32).toString('base64url');
      const current = user(request);
      if (!current)
        return renderer.render('login', {
          csrf: request.session.csrf,
          users: Object.entries(directory).map(([id, entry]) => ({
            id,
            ...entry,
          })),
        });
      const locale = negotiate(request);
      const text = messages[locale];
      const permissions = permissionsOf(current.role);
      const context = (
        component: string,
        tenant: string | null,
      ): RenderCacheContext => ({
        component,
        revision: 'v1',
        renderer: 'hbs',
        locale,
        tenant,
        permissions,
        assetVersion,
      });
      // Shared by every user of the tenant with the same permission scope.
      const catalog = await this.catalog.renders.render(
        {
          ...context('catalog', current.tenant),
          audience: 'tenant',
          ttlMs: 60_000,
          staleWhileRevalidateMs: 30_000,
          tags: [`products:${current.tenant}`],
        },
        () => {
          this.catalog.renderCounts.catalog++;
          return renderer.render('catalog', {
            title: text.catalog,
            edit: text.edit,
            canEdit: permissions.includes('products:write'),
            products: this.catalog.products(current.tenant),
            renderedAt: new Date().toISOString(),
          });
        },
      );
      // Identical for everyone: no tenant, no permissions.
      const footer = await this.catalog.renders.render(
        {
          ...context('footer', null),
          permissions: [],
          audience: 'public',
          ttlMs: 300_000,
          staleWhileRevalidateMs: 60_000,
        },
        () => {
          this.catalog.renderCounts.footer++;
          return renderer.render('footer', { text: text.footer });
        },
      );
      // Personal HTML: rendered for every request, never stored (the default).
      const account = await this.catalog.renders.render(
        {
          ...context('account', current.tenant),
          audience: 'private',
          binding: `${current.tenant}/${request.sessionID}/${current.id}`,
          ttlMs: 10_000,
        },
        () => {
          this.catalog.renderCounts.account++;
          return renderer.render('account', {
            name: current.name,
            role: current.role,
            tenant: current.tenant,
          });
        },
      );
      reply.setHeader('X-Cache-Catalog', catalog.status);
      reply.setHeader('X-Cache-Account', account.status);
      return renderer.render('page', {
        locale,
        dir: locale === 'ar' ? 'rtl' : 'ltr',
        csrf: request.session.csrf,
        canEdit: permissions.includes('products:write'),
        catalog: SafeHtml.trusted(catalog.html),
        footer: SafeHtml.trusted(footer.html),
        account: SafeHtml.trusted(account.html),
        // Live components carry per-user signed snapshots: mounted per
        // request, outside every cached fragment.
        cart: await this.live.mount(Cart, request),
      });
    }
    @Post('session')
    @HttpCode(303)
    login(
      @Req() request: SessionRequest,
      @Body() body: Record<string, unknown>,
      @Res({ passthrough: true }) reply: Reply,
    ): void {
      if (!sameToken(request.session.csrf, body['_csrf']))
        throw new ForbiddenException();
      const id = body['user'];
      if (typeof id !== 'string' || !Object.hasOwn(directory, id))
        throw new UnauthorizedException();
      request.session.user = id;
      reply.setHeader('Location', '/');
    }
    @Post('products')
    @HttpCode(303)
    async addProduct(
      @Req() request: SessionRequest,
      @Body() body: Record<string, unknown>,
      @Res({ passthrough: true }) reply: Reply,
    ): Promise<void> {
      const current = user(request);
      if (!current) throw new UnauthorizedException();
      if (!sameToken(request.session.csrf, body['_csrf']))
        throw new ForbiddenException();
      // Re-checked server-side: the form only renders for admins.
      if (current.role !== 'admin') throw new ForbiddenException();
      const name = body['name'];
      if (typeof name !== 'string' || !/^[\p{L}\p{N} .,-]{1,60}$/u.test(name))
        throw new ForbiddenException();
      await this.catalog.addProduct(current.tenant, name);
      reply.setHeader('Location', '/');
    }
    @Get('api/cache')
    @Header('Cache-Control', 'no-store')
    metrics(@Req() request: SessionRequest) {
      if (user(request)?.role !== 'admin') throw new ForbiddenException();
      return {
        metrics: this.catalog.cache.metrics,
        renders: this.catalog.renderCounts,
        events: this.catalog.events.slice(-20),
      };
    }
    @Get('api/health') health() {
      return { status: 'ok' };
    }
    @Get('assets/boot.js')
    @Header('Cache-Control', 'no-store')
    @Header('Content-Type', 'text/javascript; charset=utf-8')
    boot() {
      const { entries } = this.assets.getManifest();
      return `import {createLiveClient} from ${JSON.stringify(entries.live)};
const client = createLiveClient();
client.mount();
window.addEventListener('pagehide', () => client.dispose());`;
    }
  }

  @Module({
    imports: [
      NestvexaModule.forRoot({ views: { root } }),
      NestvexaAssetsModule.register(),
      LiveModule.register({
        components: [Cart],
        renderer,
        store,
        origin: `http://127.0.0.1:${options.port}`,
        resolveIdentity(request: object) {
          const value = request as Partial<SessionRequest>;
          const current = value.session
            ? user(value as SessionRequest)
            : undefined;
          if (!value.session?.csrf || !value.sessionID || !current)
            throw new UnauthorizedException();
          return {
            binding: `${current.tenant}/${value.sessionID}/${current.id}`,
            csrfToken: value.session.csrf,
          };
        },
        authorize: (_identity, component, action) =>
          component === 'cart' &&
          ['$mount', '$sync', 'add', 'clear'].includes(action),
      }),
    ],
    controllers: [PageController],
    providers: [CatalogService, RendererLifecycle],
  })
  class AppModule {}

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn'],
  });
  // Local demonstration only: production needs a persistent session store and secret.
  app.use(
    session({
      secret: randomBytes(48).toString('base64url'),
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'strict', secure: false },
    }),
  );
  await configureNestvexa(app);
  app.enableShutdownHooks();
  return { app, catalog: app.get(CatalogService) };
}
