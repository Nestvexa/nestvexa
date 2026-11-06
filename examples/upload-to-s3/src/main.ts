import 'reflect-metadata';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Inject,
  Module,
  NotFoundException,
  Param,
  Post,
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
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import session from 'express-session';
import { readS3Settings } from './config.js';
import {
  DocumentRepository,
  Documents,
  ownerOf,
  publicView,
  uploadMessage,
} from './documents.js';

declare module 'express-session' {
  interface SessionData {
    csrf?: string;
    notice?: string;
  }
}
interface SessionRequest {
  session: session.Session & Partial<session.SessionData>;
  sessionID: string;
  headers: Record<string, string | string[] | undefined>;
}
interface RedirectResponse {
  redirect(status: number, url: string): void;
}

// Fails fast, before Nest starts, when a storage variable is missing.
const s3 = readS3Settings();
const port = Number(process.env['PORT'] ?? 3117);
const origin = `http://127.0.0.1:${port}`;
const root = fileURLToPath(new URL('../views', import.meta.url));
// Temporary chunks of the no-JavaScript form are staged here before they are
// stored in the bucket. Private, never under a served directory.
const directory =
  process.env['UPLOADS_DIR'] ?? join(tmpdir(), `nestvexa-upload-to-s3-${port}`);
// The browser may talk to this origin and to the bucket origin only (the
// presigned PUT); nothing else.
const csp = `default-src 'self'; script-src 'self'; connect-src 'self' ${s3.origin}; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;

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
/** Plain-form mutation guard: exact Origin plus the session CSRF token. */
function assertFormPost(request: SessionRequest, token: unknown): void {
  const expected = request.session.csrf;
  if (
    request.headers['origin'] !== origin ||
    typeof token !== 'string' ||
    !expected ||
    token.length !== expected.length ||
    !timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  )
    throw new ForbiddenException();
}
const purposes = ['documents.files', 'classic.files'];

@Controller()
class Pages {
  constructor(
    @Inject(LiveRuntime) private readonly live: LiveRuntime,
    @Inject(UploadsService) private readonly uploads: UploadsService,
    @Inject(DocumentRepository)
    private readonly repository: DocumentRepository,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('home')
  async home(@Req() request: SessionRequest) {
    request.session.csrf ??= randomBytes(32).toString('base64url');
    const notice = request.session.notice;
    delete request.session.notice;
    return {
      title: 'Upload to S3',
      notice,
      bucket: s3.bucket,
      widget: await this.live.mount(Documents, request),
    };
  }
  /** No-JavaScript fallback: multipart through the server, then into the bucket. */
  @Get('classic')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Security-Policy', csp)
  @Render('classic')
  classic(@Req() request: SessionRequest) {
    request.session.csrf ??= randomBytes(32).toString('base64url');
    const notice = request.session.notice;
    delete request.session.notice;
    return {
      title: 'Upload to S3 without JavaScript',
      csrf: request.session.csrf,
      notice,
      items: publicView(this.repository.list(ownerOf(request))),
    };
  }
  @Post('classic')
  async classicUpload(
    @Req() request: SessionRequest,
    @Res() response: RedirectResponse,
  ) {
    let notice: string;
    try {
      // receiveForm checks origin and the `_csrf` field, streams with limits
      // and validates magic bytes; finalize then writes the object to S3.
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
        ? `Stored ${result.files.length} file${result.files.length === 1 ? '' : 's'} in the bucket.`
        : 'Choose a file first.';
    } catch (error) {
      notice = uploadMessage(error);
    }
    request.session.notice = notice;
    response.redirect(303, '/classic');
  }
  /** Owner-only download, streamed from the bucket through the server (Range aware). */
  @Get('files/:id/download')
  async download(
    @Req() request: SessionRequest,
    @Res() response: object,
    @Param('id') id: string,
  ) {
    const file = this.repository.find(ownerOf(request), String(id));
    if (!file) throw new NotFoundException();
    await this.uploads.download(request, response, file);
  }
  /**
   * Owner-only short-lived presigned GET: the browser fetches the bytes from
   * the bucket directly with a forced attachment disposition.
   */
  @Get('files/:id/link')
  @Header('Cache-Control', 'no-store')
  async link(
    @Req() request: SessionRequest,
    @Res() response: RedirectResponse,
    @Param('id') id: string,
  ) {
    const file = this.repository.find(ownerOf(request), String(id));
    if (!file) throw new NotFoundException();
    const url = await this.uploads.presignDownload(file, {
      expiresInSeconds: 60,
    });
    if (!url) throw new NotFoundException();
    response.redirect(303, url);
  }
  /** Plain POST + redirect: works with and without JavaScript. */
  @Post('files/:id/delete')
  async remove(
    @Req() request: SessionRequest,
    @Res() response: RedirectResponse,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    assertFormPost(request, body?.['_csrf']);
    const file = this.repository.remove(ownerOf(request), String(id));
    if (!file) throw new NotFoundException();
    await this.uploads.remove(file);
    request.session.notice = `Deleted ${file.name} from the bucket.`;
    const back = body?.['back'] === 'classic' ? '/classic' : '/';
    response.redirect(303, back);
  }
  @Get('api/health')
  health() {
    return { status: 'ok', storage: 's3' };
  }
}

@Module({
  providers: [DocumentRepository],
  exports: [DocumentRepository],
})
class DocumentsModule {}

@Module({
  imports: [
    DocumentsModule,
    UploadsModule.register({
      global: true,
      origin,
      directory,
      storage: s3.storage,
      resolveIdentity,
      authorize: (_identity, purpose) => purposes.includes(purpose),
      // Direct uploads and presigned GETs expire with the upload token.
      tokenTtlMs: 10 * 60_000,
      purposes: {
        'documents.files': {
          types: ['png', 'jpeg', 'pdf', 'txt'],
          maxFileSize: 1024 * 1024,
          maxFiles: 3,
          direct: true,
        },
        'classic.files': {
          types: ['png', 'jpeg', 'pdf', 'txt'],
          maxFileSize: 1024 * 1024,
          maxFiles: 3,
        },
      },
    }),
    NestvexaModule.forRoot(
      { views: { root, layout: 'layout' }, live: { enabled: true } },
      {
        browser: { uploads: { endpoint: '/_nestvexa/uploads' } },
        components: [Documents],
        imports: [DocumentsModule],
        useFactory: () => ({
          origin,
          resolveIdentity,
          authorize: (_identity, component, action) =>
            component === 'documents' &&
            ['$mount', '$sync', 'attach'].includes(action),
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
console.log(
  `Upload to S3 example: ${await app.getUrl()} (bucket ${s3.bucket} at ${s3.origin})`,
);
