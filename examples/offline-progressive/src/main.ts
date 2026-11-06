import 'reflect-metadata';
import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  Inject,
  Module,
  NotFoundException,
  Param,
  Post,
  Redirect,
  Render,
  Req,
  Res,
  StreamableFile,
  UnauthorizedException,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  HbsEngine,
  LiveRuntime,
  NestvexaModule,
  SafeHtml,
  configureNestvexa,
} from 'nestvexa';
import {
  consumeFlash,
  csrfToken,
  submitForm,
  verifyCsrf,
} from '@nestvexa/forms';
import { clearSiteDataHeader, draftScope } from '@nestvexa/offline/server';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import session from 'express-session';
import {
  TicketForm,
  TicketRepository,
  ownerOf,
  ticketAdapter,
} from './tickets.js';

interface SessionRequest {
  session: session.Session & Record<string, unknown>;
  sessionID: string;
}
const port = Number(process.env['PORT'] ?? 3122);
const origin = `http://127.0.0.1:${port}`;
const allowedOrigins = [origin];
const root = fileURLToPath(new URL('../views', import.meta.url));
// Demonstration secret: drafts are orphaned on restart. Production loads a
// stable secret of at least 32 bytes from its secret store.
const draftSecret = randomBytes(48);
const csp =
  "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** Browser modules come from trusted, fixed paths only: never from the request. */
const assets = new Map<string, string>([
  [
    'offline.js',
    readFileSync(
      fileURLToPath(import.meta.resolve('@nestvexa/offline')),
      'utf8',
    ),
  ],
  [
    'app.js',
    readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'),
  ],
]);
const styles = readFileSync(
  new URL('../public/app.css', import.meta.url),
  'utf8',
);

@Controller()
class Pages {
  constructor(
    @Inject(LiveRuntime) private readonly live: LiveRuntime,
    @Inject(HbsEngine) private readonly engine: HbsEngine,
    @Inject(TicketRepository) private readonly tickets: TicketRepository,
  ) {}
  private async recent(request: SessionRequest): Promise<string> {
    return this.engine.render(
      'recent',
      {
        tickets: this.tickets.list(ownerOf(request)).map((ticket) => ({
          ...ticket,
        })),
        renderedAt: new Date().toISOString(),
      },
      { layout: false },
    );
  }
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('home')
  async home(@Req() request: SessionRequest) {
    const csrf = csrfToken(request);
    return {
      title: 'Support tickets',
      csrf,
      // Opaque per-identity namespace for local drafts and snapshots.
      draftScope: draftScope(draftSecret, ownerOf(request)),
      flash: consumeFlash(request),
      form: await this.live.mount(TicketForm, request),
      recent: SafeHtml.trusted(await this.recent(request)),
    };
  }
  /** Fragment for the read-only snapshot region (`loadRegion`). */
  @Get('tickets/recent')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async recentFragment(@Req() request: SessionRequest): Promise<string> {
    return this.recent(request);
  }
  /** Native POST used when JavaScript is unavailable; Live forms never reach it. */
  @Post('tickets')
  @Redirect()
  create(@Req() request: SessionRequest) {
    return submitForm(request, {
      form: 'ticket',
      adapter: ticketAdapter,
      back: '/',
      allowedOrigins,
      remember: ['subject', 'details', 'priority', 'contact'],
      handle: (value) => {
        const ticket = this.tickets.add(ownerOf(request), value);
        return { redirect: '/', flash: `Ticket #${ticket.id} created.` };
      },
    });
  }
  @Post('logout')
  @Redirect('/', 303)
  async logout(
    @Req() request: SessionRequest,
    @Res({ passthrough: true })
    response: { setHeader(name: string, value: string): unknown },
  ) {
    if (!verifyCsrf(request)) throw new ForbiddenException();
    this.tickets.clear(ownerOf(request));
    // Defense in depth only; the page clears drafts through data-nv-logout.
    response.setHeader(clearSiteDataHeader.name, clearSiteDataHeader.value);
    await new Promise<void>((resolve, reject) =>
      request.session.destroy((error: unknown) =>
        error ? reject(new UnauthorizedException()) : resolve(),
      ),
    );
  }
  @Get('assets/app.css')
  @Header('Content-Type', 'text/css; charset=utf-8')
  stylesheet(): string {
    return styles;
  }
  @Get('assets/:file')
  @Header('Cache-Control', 'no-cache')
  asset(@Param('file') file: string): StreamableFile {
    const body = assets.get(file);
    if (body === undefined) throw new NotFoundException();
    return new StreamableFile(Buffer.from(body, 'utf8'), {
      type: 'text/javascript; charset=utf-8',
    });
  }
  @Get('api/health')
  health() {
    return { status: 'ok' };
  }
}

@Module({ providers: [TicketRepository], exports: [TicketRepository] })
class TicketsModule {}

@Module({
  imports: [
    TicketsModule,
    NestvexaModule.forRoot(
      { views: { root, layout: 'layout' }, live: { enabled: true } },
      {
        components: [TicketForm],
        imports: [TicketsModule],
        useFactory: () => ({
          origin,
          resolveIdentity(request: object) {
            const value = request as Partial<SessionRequest>;
            const csrf = value.session?.['csrf'];
            if (typeof csrf !== 'string' || !value.sessionID)
              throw new UnauthorizedException();
            return {
              binding: `guest-session:${value.sessionID}`,
              csrfToken: csrf,
            };
          },
          authorize: (_identity, component, action) =>
            component === 'ticket-form' &&
            ['$mount', '$sync', 'create'].includes(action),
        }),
      },
    ),
  ],
  controllers: [Pages],
})
class AppModule {}

const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
// Local guest demonstration: production hosts supply authentication, a persistent
// session store, a deployment secret, HTTPS cookies, and resource-level policies.
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
await configureNestvexa(app);
app.enableShutdownHooks();
await app.listen(port, '127.0.0.1');
console.log(`Offline progressive example: ${await app.getUrl()}`);
