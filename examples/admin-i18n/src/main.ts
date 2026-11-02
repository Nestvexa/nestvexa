import 'reflect-metadata';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
  Redirect,
  Render,
  Req,
  Res,
  StreamableFile,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AiAssistant, AiModule } from '@nestvexa/ai';
import {
  FlagGuard,
  FlagRequestContext,
  FlagService,
  FlagsModule,
  RequireFlag,
  StaticFlagProvider,
  flagHelpers,
  liveFlagPolicy,
} from '@nestvexa/flags';
import {
  I18n,
  I18nModule,
  LocaleViewInterceptor,
  loadCatalogs,
} from '@nestvexa/i18n';
import { clearSiteDataHeader, draftScope } from '@nestvexa/offline/server';
import { uiHelpers } from '@nestvexa/ui';
import {
  HbsEngine,
  LiveRuntime,
  NestvexaModule,
  SafeHtml,
  configureNestvexa,
  createTextStreamResponse,
  parseTextStreamRequest,
} from 'nestvexa';
import session from 'express-session';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AssistantPanel, assistantOptions } from './assistant.js';
import { Catalog, CatalogModule, validateProduct } from './catalog.js';
import { assertFormCsrf, binding, ensureCsrf, field } from './identity.js';
import type { SessionRequest } from './identity.js';
import { ProductForm, ProductTable } from './products.js';

const port = Number(process.env['PORT'] ?? 3110);
const origin = `http://127.0.0.1:${port}`;
const root = fileURLToPath(new URL('../views', import.meta.url));
const locales = fileURLToPath(new URL('../locales', import.meta.url));
// Demonstration secret: drafts are orphaned on restart. Production loads a
// stable ≥32-byte secret from its secret store.
const draftSecret = randomBytes(48);
const csp =
  "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const knownFlags = ['ai-assistant', 'bulk-export'] as const;

/** Optional browser modules are served from trusted package paths only. */
function packageFile(specifier: string): string {
  return readFileSync(fileURLToPath(import.meta.resolve(specifier)), 'utf8');
}
const assets = new Map<
  string,
  { readonly type: string; readonly body: string }
>([
  [
    'ui.js',
    { type: 'text/javascript', body: packageFile('@nestvexa/ui/browser') },
  ],
  ['ui.css', { type: 'text/css', body: packageFile('@nestvexa/ui/theme.css') }],
  [
    'offline.js',
    { type: 'text/javascript', body: packageFile('@nestvexa/offline') },
  ],
  [
    'ai.js',
    { type: 'text/javascript', body: packageFile('@nestvexa/ai/browser') },
  ],
  [
    'admin.js',
    {
      type: 'text/javascript',
      body: readFileSync(
        new URL('../public/admin.js', import.meta.url),
        'utf8',
      ),
    },
  ],
  [
    'admin.css',
    {
      type: 'text/css',
      body: readFileSync(
        new URL('../public/admin.css', import.meta.url),
        'utf8',
      ),
    },
  ],
]);

const catalogs = await loadCatalogs(locales, { locales: ['en', 'ar'] });
const i18nModule = I18nModule.forRoot(
  {
    locales: ['en', { code: 'ar', dir: 'rtl', label: 'العربية' }],
    defaultLocale: 'en',
    // Explicit policy: every date renders in UTC unless a call passes a zone.
    timeZone: 'UTC',
    catalogs,
  },
  { global: true },
);
const flagsModule = FlagsModule.forRoot({
  flags: knownFlags,
  provider: new StaticFlagProvider({
    'ai-assistant': true,
    'bulk-export': false,
  }),
  // Flags come from the server-side identity, never from query or body input.
  context: (request) => ({ identity: binding(request) }),
});
const aiModule = AiModule.forRootAsync({
  imports: [CatalogModule],
  inject: [Catalog],
  useFactory: (catalog: Catalog) => assistantOptions(catalog),
});

const liveActions: Readonly<Record<string, readonly string[]>> = {
  'product-table': [
    '$mount',
    '$sync',
    'sortByName',
    'sortByPrice',
    'sortByUpdated',
    'search',
    'changed',
  ],
  'product-form': ['$mount', '$sync', 'save'],
  'assistant-panel': [
    '$mount',
    '$sync',
    'ask',
    'collect',
    'approve',
    'reject',
    '$stream:assistant',
  ],
};

function safeReturn(value: string): string {
  return /^\/admin(?:\/[a-z0-9/-]*)?(?:\?[A-Za-z0-9=&_%.-]*)?$/.test(value)
    ? value
    : '/admin';
}

@Controller()
class AdminController {
  constructor(
    @Inject(LiveRuntime) private readonly live: LiveRuntime,
    @Inject(I18n) private readonly i18n: I18n,
    @Inject(FlagRequestContext) private readonly flags: FlagRequestContext,
    @Inject(Catalog) private readonly catalog: Catalog,
    @Inject(AiAssistant) private readonly assistant: AiAssistant,
    @Inject(HbsEngine) private readonly engine: HbsEngine,
  ) {}

  private async shell(request: SessionRequest, returnTo: string) {
    const csrf = ensureCsrf(request);
    const context = this.i18n.forRequest(request);
    const flags = await this.flags.forRequest(request);
    return {
      csrf,
      returnTo,
      flags,
      draftScope: draftScope(draftSecret, binding(request)),
      locales: this.i18n.definitions().map((definition) => ({
        code: definition.code,
        label: definition.label,
        dir: definition.dir,
        pressed: definition.code === context.locale ? 'true' : 'false',
      })),
      title: context.t('common:title'),
    };
  }
  private async activity(request: SessionRequest): Promise<string> {
    const context = this.i18n.forRequest(request);
    return this.engine.render(
      'activity',
      {
        i18n: context.view,
        items: this.catalog.activity(binding(request)).map((entry) => ({
          text: context.t(
            entry.kind === 'created' ? 'products:created' : 'products:archived',
            { name: entry.name },
          ),
          at: entry.at,
        })),
      },
      { layout: false },
    );
  }

  @Get()
  @Redirect('/admin', 302)
  home(): void {}

  @Get('api/health')
  health() {
    return { status: 'ok' };
  }

  @Get('assets/:file')
  asset(@Param('file') file: string): StreamableFile {
    const asset = assets.get(file);
    if (!asset) throw new NotFoundException();
    return new StreamableFile(Buffer.from(asset.body, 'utf8'), {
      type: `${asset.type}; charset=utf-8`,
    });
  }

  @Get('admin')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @UseInterceptors(LocaleViewInterceptor)
  @Render('admin')
  async admin(@Req() request: SessionRequest) {
    const shell = await this.shell(request, '/admin');
    const context = this.i18n.forRequest(request);
    const products = this.catalog.list(binding(request));
    const active = products.filter((item) => item.status === 'active').length;
    const notice = request.session.notice;
    delete request.session.notice;
    return {
      ...shell,
      flagList: knownFlags.map((name) => ({
        name,
        label: context.t(`common:flags.${name}`),
        state: context.t(
          shell.flags[name] ? 'common:flags.on' : 'common:flags.off',
        ),
      })),
      completeness: {
        active,
        total: products.length,
        text: context.t('common:completenessValue', {
          active,
          total: products.length,
        }),
      },
      flash: notice ? [notice] : [],
      table: await this.live.mount(ProductTable, request),
      form: await this.live.mount(ProductForm, request),
      assistant: shell.flags['ai-assistant']
        ? await this.live.mount(AssistantPanel, request)
        : null,
      activity: SafeHtml.trusted(await this.activity(request)),
    };
  }

  /** Full-page fallback for the dialog (users without JavaScript). */
  @Get('admin/products/new')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @UseInterceptors(LocaleViewInterceptor)
  @Render('new-product')
  async newProduct(
    @Req() request: SessionRequest,
    @Query('error') error?: string,
  ) {
    return {
      ...(await this.shell(request, '/admin/products/new')),
      error: error === '1',
      form: await this.live.mount(ProductForm, request),
    };
  }

  /** Native POST used when JavaScript is unavailable; Live forms never reach it. */
  @Post('admin/products')
  @Redirect('/admin', 303)
  createProduct(@Req() request: SessionRequest, @Body() body: unknown) {
    assertFormCsrf(request, body);
    const owner = binding(request);
    const input = {
      name: field(body, 'name', 80),
      // The combobox needs JavaScript; its <noscript> select posts this field.
      category:
        field(body, 'category', 16) || field(body, 'categoryFallback', 16),
      price: field(body, 'price', 16),
    };
    if (Object.keys(validateProduct(input, this.catalog.list(owner))).length)
      return { url: '/admin/products/new?error=1', statusCode: 303 };
    const product = this.catalog.add(owner, input);
    request.session.notice = this.i18n
      .forRequest(request)
      .t('products:created', { name: product.name });
    return { url: '/admin', statusCode: 303 };
  }

  @Get('admin/activity')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async activityFragment(@Req() request: SessionRequest): Promise<string> {
    return this.activity(request);
  }

  /** Disabled by the `bulk-export` flag: the guard answers 404 server-side. */
  @Get('admin/export.csv')
  @UseGuards(FlagGuard)
  @RequireFlag('bulk-export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  exportCsv(@Req() request: SessionRequest): string {
    const cell = (value: string) =>
      /^[=+\-@]/.test(value) ? `'${value}` : value.replaceAll('"', '""');
    return (
      ['"id","name","price","status"']
        .concat(
          this.catalog
            .list(binding(request))
            .map(
              (item) =>
                `"${item.id}","${cell(item.name)}","${item.price}","${item.status}"`,
            ),
        )
        .join('\r\n') + '\r\n'
    );
  }

  @Post('admin/assistant-stream')
  @HttpCode(200)
  async assistantStream(
    @Req() request: SessionRequest,
    @Res({ passthrough: true }) response: object,
  ) {
    const input = parseTextStreamRequest(request.body);
    const authorization = await this.live.authorizeStream(
      request,
      AssistantPanel,
      'assistant',
      { snapshot: input.snapshot, revision: input.revision },
    );
    const context = this.i18n.forRequest(request);
    const owner = binding(request);
    return createTextStreamResponse({
      request,
      response,
      authorization,
      produce: ({ signal, state }) =>
        this.assistant.stream(owner, String(state['conversationId']), {
          signal,
          approvalNotice: (summary) =>
            `\n${context.t('assistant:approvalNotice', { summary })}`,
        }),
    });
  }

  @Post('locale')
  @Redirect('/admin', 303)
  setLocale(
    @Req() request: SessionRequest,
    @Res({ passthrough: true })
    response: { setHeader(name: string, value: string): unknown },
    @Body() body: unknown,
  ) {
    assertFormCsrf(request, body);
    const locale = this.i18n.match(field(body, 'locale', 35));
    if (!locale) throw new BadRequestException('Unsupported locale');
    response.setHeader('Set-Cookie', this.i18n.localeCookie(locale));
    return { url: safeReturn(field(body, 'return', 200)), statusCode: 303 };
  }

  @Post('logout')
  @Redirect('/admin', 303)
  async logout(
    @Req() request: SessionRequest,
    @Res({ passthrough: true })
    response: { setHeader(name: string, value: string): unknown },
    @Body() body: unknown,
  ) {
    assertFormCsrf(request, body);
    const owner = binding(request);
    this.assistant.clear(owner);
    this.catalog.clear(owner);
    // Defense in depth only; the page clears drafts through @nestvexa/offline.
    response.setHeader(clearSiteDataHeader.name, clearSiteDataHeader.value);
    await new Promise<void>((resolve, reject) =>
      request.session.destroy((error: unknown) =>
        error ? reject(new UnauthorizedException()) : resolve(),
      ),
    );
    return { url: '/admin', statusCode: 303 };
  }
}

@Module({
  imports: [
    i18nModule,
    flagsModule,
    aiModule,
    CatalogModule,
    NestvexaModule.forRoot(
      { views: { root, layout: 'layout' }, live: { enabled: true } },
      {
        browser: {
          streams: { assistant: { endpoint: '/admin/assistant-stream' } },
        },
        components: [ProductTable, ProductForm, AssistantPanel],
        imports: [CatalogModule, aiModule, flagsModule],
        inject: [FlagService],
        useFactory: (flags: FlagService) => ({
          origin,
          resolveIdentity(request: object) {
            const value = request as Partial<SessionRequest>;
            if (!value.session?.csrf || !value.sessionID)
              throw new UnauthorizedException();
            return {
              binding: binding(request),
              csrfToken: value.session.csrf,
            };
          },
          // The flag is enforced before the action allowlist on every Live
          // request, including $mount and the assistant stream.
          authorize: liveFlagPolicy(
            flags,
            { 'assistant-panel': 'ai-assistant' },
            (_identity, component, action) =>
              liveActions[component]?.includes(action) ?? false,
          ),
        }),
      },
    ),
  ],
  controllers: [AdminController],
})
class AppModule {}

const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
// Local guest demonstration: production hosts supply authentication, a
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
// Optional packages register their helpers before the engine initializes.
const engine = app.get(HbsEngine);
engine.registerHelpers(app.get(I18n).helpers());
engine.registerHelpers(uiHelpers());
engine.registerHelpers(flagHelpers());
await configureNestvexa(app);
app.enableShutdownHooks();
await app.listen(port, '127.0.0.1');
console.log(`Admin i18n example: ${await app.getUrl()}`);
