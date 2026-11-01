import 'reflect-metadata';
import {
  Controller,
  Get,
  Header,
  Inject,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
  Render,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { LiveRuntime, NestvexaModule, configureNestvexa } from 'nestvexa';
import {
  UploadsModule,
  UploadsService,
  configureUploads,
} from '@nestvexa/uploads';
import type { UploadIdentity } from '@nestvexa/uploads';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import session from 'express-session';
import {
  AttachmentRepository,
  Attachments,
  ownerOf,
  publicView,
  uploadMessage,
} from './attachments.js';

declare module 'express-session' {
  interface SessionData {
    csrf?: string;
    notice?: string;
  }
}
interface SessionRequest {
  session: session.Session & Partial<session.SessionData>;
  sessionID: string;
}
const port = Number(process.env['PORT'] ?? 3105);
const origin = `http://127.0.0.1:${port}`;
const root = fileURLToPath(new URL('../views', import.meta.url));
// Private storage outside any served directory. Production: a persistent volume
// or S3Storage, never a folder under public/static assets.
const directory =
  process.env['UPLOADS_DIR'] ??
  join(tmpdir(), `nestvexa-uploads-example-${port}`);
const csp =
  "default-src 'self'; script-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** One host identity policy shared by Live and uploads: never from request bodies. */
function resolveIdentity(request: object): UploadIdentity {
  const value = request as Partial<SessionRequest>;
  if (!value.session?.csrf || !value.sessionID)
    throw new UnauthorizedException();
  return {
    binding: `guest-session:${value.sessionID}`,
    csrfToken: value.session.csrf,
  };
}
const purposes = ['attachments.files', 'attachments.archive', 'classic.files'];

@Controller()
class Pages {
  constructor(
    @Inject(LiveRuntime) private readonly live: LiveRuntime,
    @Inject(UploadsService) private readonly uploads: UploadsService,
    @Inject(AttachmentRepository)
    private readonly repository: AttachmentRepository,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('home')
  async home(@Req() request: SessionRequest) {
    request.session.csrf ??= randomBytes(32).toString('base64url');
    return {
      title: 'Attachments',
      widget: await this.live.mount(Attachments, request),
    };
  }
  /** No-JavaScript fallback: a plain multipart form through the same pipeline. */
  @Get('classic')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('classic')
  classic(@Req() request: SessionRequest) {
    request.session.csrf ??= randomBytes(32).toString('base64url');
    const notice = request.session.notice;
    delete request.session.notice;
    return {
      title: 'Attachments without JavaScript',
      csrf: request.session.csrf,
      notice,
      items: publicView(this.repository.list(ownerOf(request))),
    };
  }
  @Post('classic')
  async classicUpload(@Req() request: SessionRequest, @Res() response: object) {
    let notice: string;
    try {
      const result = await this.uploads.receiveForm(
        request,
        { purpose: 'classic.files' },
        response,
      );
      for (const file of result.files)
        this.repository.add(
          ownerOf(request),
          await this.uploads.finalize(request, file.token, {
            purpose: 'classic.files',
          }),
        );
      notice = result.files.length
        ? `Attached ${result.files.length} file${result.files.length === 1 ? '' : 's'}.`
        : 'Choose a file first.';
    } catch (error) {
      notice = uploadMessage(error);
    }
    request.session.notice = notice;
    // 303 See Other: the browser follows with GET (post/redirect/get).
    const reply = response as { redirect(status: number, url: string): void };
    reply.redirect(303, '/classic');
  }
  /** Authorized download: only the owning guest session can read its files. */
  @Get('attachments/:id/download')
  async download(
    @Req() request: SessionRequest,
    @Res() response: object,
    @Param('id') id: string,
    @Query('inline') inline?: string,
  ) {
    const file = this.repository.find(ownerOf(request), String(id));
    if (!file) throw new NotFoundException();
    await this.uploads.download(request, response, file, {
      disposition: inline === '1' ? 'inline' : 'attachment',
    });
  }
  @Get('api/health')
  health() {
    return { status: 'ok' };
  }
}

@Module({
  providers: [AttachmentRepository],
  exports: [AttachmentRepository],
})
class AttachmentsModule {}

@Module({
  imports: [
    AttachmentsModule,
    UploadsModule.register({
      global: true,
      origin,
      directory,
      resolveIdentity,
      authorize: (_identity, purpose) => purposes.includes(purpose),
      // Small chunks so the example shows several resumable chunks per file.
      chunkSize: 64 * 1024,
      tokenTtlMs: 15 * 60_000,
      purposes: {
        'attachments.files': {
          types: ['png', 'jpeg', 'gif', 'webp', 'pdf', 'txt', 'csv'],
          maxFileSize: 2 * 1024 * 1024,
          maxFiles: 5,
        },
        'attachments.archive': {
          types: ['pdf'],
          maxFileSize: 8 * 1024 * 1024,
          maxFiles: 1,
        },
        'classic.files': {
          types: ['png', 'jpeg', 'gif', 'webp', 'pdf', 'txt', 'csv'],
          maxFileSize: 2 * 1024 * 1024,
          maxFiles: 3,
        },
      },
    }),
    NestvexaModule.forRoot(
      { views: { root, layout: 'layout' }, live: { enabled: true } },
      {
        browser: { uploads: { endpoint: '/_nestvexa/uploads' } },
        components: [Attachments],
        imports: [AttachmentsModule],
        useFactory: () => ({
          origin,
          resolveIdentity,
          authorize: (_identity, component, action) =>
            component === 'attachments' &&
            ['$mount', '$sync', 'attach', 'clear'].includes(action),
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
await configureUploads(app);
app.enableShutdownHooks();
await app.listen(port, '127.0.0.1');
console.log(`Uploads example: ${await app.getUrl()}`);
