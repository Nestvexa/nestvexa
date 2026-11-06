import 'reflect-metadata';
import {
  Controller,
  Inject,
  Module,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import fc from 'fast-check';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  UploadError,
  UploadsModule,
  UploadsService,
  configureUploads,
  parseClientFilename,
} from '../packages/uploads/dist/index.js';
import {
  ORIGIN,
  PDF,
  PNG,
  csrfFor,
  rawUpload,
  send,
} from './support/uploads-http.js';

/**
 * HTTP-level fuzzing of the multipart (no-JavaScript) and raw upload routes
 * over a real Express server: hostile part headers, filenames, field names,
 * boundaries and truncated bodies. Invariants: no 5xx, files are accepted
 * only with valid client filenames, and temporary files never leak.
 */
const runs = { numRuns: 60 };
const filename = fc.oneof(
  fc.constantFrom(
    'report.pdf',
    'logo.png',
    '../../evil.pdf',
    '..\\..\\evil.pdf',
    'C:\\evil.pdf',
    '/etc/passwd.pdf',
    'a"b.pdf',
    'name.exe.pdf',
    '.hidden.pdf',
    'x.pdf\r\nX-Injected: 1',
    '\u202egnp.pdf',
    'file.PDF',
    '',
  ),
  fc.string({ unit: 'binary', maxLength: 30 }),
  fc.string({ maxLength: 12 }).map((stem) => `${stem}.pdf`),
);
const fieldName = fc.oneof(
  fc.constantFrom(
    'files',
    '_csrf',
    'title',
    '__proto__',
    'constructor',
    'a.b',
    'x'.repeat(120),
    '',
  ),
  fc.string({ maxLength: 10 }),
);
const part = fc.oneof(
  fc.record({
    kind: fc.constant('field' as const),
    name: fieldName,
    value: fc.string({ maxLength: 40 }),
  }),
  fc.record({
    kind: fc.constant('file' as const),
    name: fieldName,
    filename,
    extended: fc.boolean(),
    type: fc.constantFrom(
      'application/pdf',
      'image/png',
      'text/html',
      'application/octet-stream',
      '',
    ),
    data: fc.oneof(
      fc.constant(PDF),
      fc.constant(PNG),
      fc.uint8Array({ maxLength: 64 }).map((bytes) => Buffer.from(bytes)),
    ),
  }),
);
type Part = typeof part extends fc.Arbitrary<infer T> ? T : never;

function quoted(value: string): string {
  return value.replace(/["\\]/g, (character) => `\\${character}`);
}
function body(
  parts: readonly Part[],
  boundary: string,
  truncate: number | null,
): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of parts) {
    if (entry.kind === 'field')
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${quoted(entry.name)}"\r\n\r\n${entry.value}\r\n`,
        ),
      );
    else {
      const disposition = entry.extended
        ? `filename*=UTF-8''${encodeURIComponent(entry.filename.replace(/[\ud800-\udfff]/g, ''))}`
        : `filename="${quoted(entry.filename)}"`;
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${quoted(entry.name)}"; ${disposition}\r\n${entry.type ? `Content-Type: ${entry.type}\r\n` : ''}\r\n`,
        ),
        entry.data,
        Buffer.from('\r\n'),
      );
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const full = Buffer.concat(chunks);
  return truncate === null
    ? full
    : full.subarray(0, truncate % (full.byteLength + 1));
}
function validName(value: string): boolean {
  try {
    parseClientFilename(value);
    return true;
  } catch (error) {
    if (error instanceof UploadError) return false;
    throw error;
  }
}

describe('upload routes under HTTP fuzzing (express)', () => {
  let app: INestApplication;
  let base: string;
  let directory: string;
  let service: InstanceType<typeof UploadsService>;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nestvexa-upload-fuzz-'));
    @Controller('host')
    class HostController {
      constructor(
        @Inject(UploadsService) private readonly uploads: UploadsService,
      ) {}
      @Post('form')
      async form(
        @Req() request: object,
        @Res({ passthrough: true }) response: object,
      ) {
        const result = await this.uploads.receiveForm(
          request,
          { purpose: 'docs' },
          response,
        );
        return {
          fields: result.fields,
          files: result.files.map((file) => file.name),
        };
      }
    }
    @Module({
      imports: [
        UploadsModule.register({
          origin: ORIGIN,
          directory,
          idleTimeoutMs: 400,
          sweepIntervalMs: 60_000,
          quotas: {
            identityBytes: 64 * 1024 * 1024,
            identityFiles: 10_000,
            totalFiles: 10_000,
            requestsPerMinute: 100_000,
          },
          resolveIdentity(request: object) {
            const headers = Reflect.get(request, 'headers') as Record<
              string,
              unknown
            >;
            const user = headers['x-test-user'];
            if (typeof user !== 'string') throw new UnauthorizedException();
            return {
              binding: `fuzz-user:${user}:binding`,
              csrfToken: csrfFor(user),
            };
          },
          authorize: () => true,
          purposes: {
            docs: { types: ['pdf', 'png'], maxFileSize: 4096, maxFiles: 3 },
          },
        }),
      ],
      controllers: [HostController],
    })
    class AppModule {}
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await configureUploads(app);
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    service = app.get(UploadsService);
  });
  afterAll(async () => {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function noLeaks(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      let parts: string[];
      try {
        parts = (await readdir(service.temporaryDirectory)).filter((name) =>
          name.endsWith('.part'),
        );
      } catch {
        parts = [];
      }
      if (parts.length === service.pendingCount) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Temporary upload files leaked');
  }

  it('never answers 5xx and accepts files only with valid names', async () => {
    let user = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(part, { minLength: 1, maxLength: 4 }),
        fc.boolean(),
        fc.option(fc.nat(), { nil: null }),
        fc.constantFrom('nvfuzz', 'a', '----x"y', 'b'.repeat(70)),
        async (parts, csrfFirst, truncate, boundary) => {
          const id = `u${user++}`;
          const ordered: Part[] = csrfFirst
            ? [{ kind: 'field', name: '_csrf', value: csrfFor(id) }, ...parts]
            : parts;
          const payload = body(ordered, boundary, truncate);
          const reply = await send(base, 'POST', '/host/form', {
            headers: {
              'x-test-user': id,
              origin: ORIGIN,
              'content-type': `multipart/form-data; boundary=${boundary.includes('"') ? `"${quoted(boundary)}"` : boundary}`,
              'content-length': String(payload.byteLength),
            },
            body: payload,
          });
          // -1: the server deliberately closed an over-limit stream.
          expect(
            reply.status === -1 || reply.status < 500,
            `status ${reply.status}`,
          ).toBe(true);
          if (reply.status === 201) {
            const result = reply.json() as { files: string[] };
            for (const name of result.files) {
              expect(validName(name)).toBe(true);
              expect(name).not.toMatch(/[/\\\r\n]/);
            }
            expect(csrfFirst).toBe(true);
          }
          await noLeaks();
        },
      ),
      runs,
    );
  }, 300_000);

  it('raw upload name headers never cause 5xx or accept invalid names', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          filename.map((name) => {
            try {
              return encodeURIComponent(name);
            } catch {
              return name;
            }
          }),
          fc
            .string({ maxLength: 40 })
            .map((value) => value.replace(/[^\x20-\x7e]/g, '%')),
          fc.constantFrom(
            '%',
            '%E0%A4%A',
            '%00evil.pdf',
            '%2e%2e%2fx.pdf',
            '%F4%8F%BF%BF.pdf',
            'x'.repeat(4000),
          ),
        ),
        async (header) => {
          const reply = await rawUpload(
            base,
            'raw-user',
            'docs',
            'placeholder.pdf',
            PDF,
            {
              'x-nestvexa-upload-name': header,
            },
          );
          expect(
            reply.status === -1 || reply.status < 500,
            `status ${reply.status}`,
          ).toBe(true);
          if (reply.status === 201) {
            const receipt = reply.json();
            expect(validName(String(receipt['name']))).toBe(true);
          }
          await noLeaks();
        },
      ),
      runs,
    );
  }, 300_000);
});
