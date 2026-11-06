import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { customAdapter, defineForm, finalizeFileField } from '@nestvexa/forms';
import {
  InertiaPage,
  InertiaService,
  InertiaValidationException,
  Precognitive,
  inertiaValidate,
  redirect,
} from '@nestvexa/inertia';
import {
  UploadsModule,
  UploadsService,
  isUploadToken,
} from '@nestvexa/uploads';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// @nestvexa/forms + @nestvexa/uploads with the official Inertia client: the
// browser uploads the file through @nestvexa/uploads/browser (progress from
// the upload routes, an opaque nvu_… token as the result), the form submits
// JSON with that token, Precognition validates title and token shape with the
// same schema, and the handler finalizes the token through the forms file
// field. Validation and upload failures become InertiaValidationException
// errors that the official useForm shows per field (`_form` for form-level).

export interface StoredDocument {
  readonly title: string;
  readonly name: string;
  readonly size: number;
  readonly type: string;
}

interface DocumentRequest {
  readonly session: { readonly id?: string; readonly xsrf?: string };
}

export const DOCUMENT_PURPOSE = 'documents';
const documents: StoredDocument[] = [];

/** Rules shared by Precognition and the real submission. */
export const documentSchema = customAdapter<{
  title: string;
  attachment: string;
}>((input, issues) => {
  const title = typeof input['title'] === 'string' ? input['title'].trim() : '';
  const attachment =
    typeof input['attachment'] === 'string' ? input['attachment'] : '';
  if (!title) issues.issue('title', 'required', 'The title field is required.');
  else if (title.length > 60)
    issues.issue(
      'title',
      'max',
      'The title may not be greater than 60 characters.',
    );
  else if (documents.some((document) => document.title === title))
    issues.issue('', 'unique', 'A document with this title already exists.');
  if (!attachment)
    issues.issue('attachment', 'required', 'Upload a file first.');
  else if (!isUploadToken(attachment))
    issues.issue('attachment', 'token', 'Upload the file again.');
  return { title, attachment };
});

const documentForm = defineForm<{ title: string; attachment: string }>({
  fields: { title: '' },
  files: { attachment: { max: 1 } },
});

/**
 * Upload routes for the documents page. Identity is the host session; the
 * CSRF token is the session's XSRF token that the official client already
 * sends, so @nestvexa/uploads/browser reads the same `XSRF-TOKEN` cookie.
 */
export function documentUploads(origin: string): DynamicModule {
  return UploadsModule.register({
    origin,
    directory: join(tmpdir(), `nestvexa-inertia-uploads-${process.pid}`),
    resolveIdentity: (request) => {
      const { session } = request as DocumentRequest;
      if (!session?.id || !session.xsrf) throw new UnauthorizedException();
      return {
        binding: `inertia-example:session:${session.id}`,
        csrfToken: session.xsrf,
      };
    },
    authorize: (_identity, purpose) => purpose === DOCUMENT_PURPOSE,
    purposes: {
      [DOCUMENT_PURPOSE]: {
        types: ['txt', 'png'],
        maxFileSize: 64 * 1024,
        maxFiles: 3,
      },
    },
  });
}

@Controller('documents')
export class DocumentsController {
  constructor(
    @Inject(InertiaService) private readonly inertia: InertiaService,
    @Inject(UploadsService) private readonly uploads: UploadsService,
  ) {}

  @Get()
  @InertiaPage('Files/Documents')
  index() {
    return {
      documents: () => documents.map((document) => ({ ...document })),
    };
  }

  /** Precognition answers validation-only requests; submissions run below. */
  @Post()
  @Precognitive(documentSchema)
  async store(@Req() request: object, @Body() body: unknown) {
    const value = await inertiaValidate(documentSchema, body);
    const state = documentForm.update(documentForm.create(), value);
    const finalized = await finalizeFileField(
      documentForm,
      state,
      'attachment',
      (token) =>
        this.uploads.finalize(request, token, { purpose: DOCUMENT_PURPOSE }),
    );
    if (!finalized.ok) throw new InertiaValidationException(finalized.errors);
    for (const file of finalized.files)
      documents.unshift({
        title: value.title,
        name: file.name,
        size: file.size,
        type: file.contentType,
      });
    this.inertia.flash(request, 'success', `Stored ${value.title}`);
    return redirect('/documents');
  }
}
