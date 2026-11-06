import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Action, LiveComponent, State } from 'nestvexa';
import {
  UploadError,
  UploadsService,
  parseUploadReferences,
  uploadReferenceField,
} from '@nestvexa/uploads';
import type { FinalizedUpload } from '@nestvexa/uploads';
import { randomBytes } from 'node:crypto';

export interface StoredDocument extends FinalizedUpload {
  readonly id: string;
}
export interface PublicDocument {
  readonly id: string;
  readonly name: string;
  readonly size: string;
  readonly contentType: string;
}

/**
 * Demonstration metadata store: per guest session, in process memory. The
 * bytes live in the S3 bucket; a real host keeps these rows (object key,
 * owner, tenant, digest) in its database and checks ownership on every read.
 */
@Injectable()
export class DocumentRepository {
  readonly #items = new Map<string, StoredDocument[]>();
  list(owner: string): readonly StoredDocument[] {
    return this.#items.get(owner) ?? [];
  }
  add(owner: string, file: FinalizedUpload): StoredDocument {
    if (!this.#items.has(owner) && this.#items.size >= 1000)
      this.#items.clear();
    const items = this.list(owner);
    if (items.length >= 20) throw new UploadError(429, 'QUOTA_EXCEEDED');
    const document = { ...file, id: randomBytes(9).toString('base64url') };
    this.#items.set(owner, [...items, document]);
    return document;
  }
  find(owner: string, id: string): StoredDocument | undefined {
    return this.list(owner).find((item) => item.id === id);
  }
  remove(owner: string, id: string): StoredDocument | undefined {
    const item = this.find(owner, id);
    if (item)
      this.#items.set(
        owner,
        this.list(owner).filter((entry) => entry.id !== id),
      );
    return item;
  }
}

export function ownerOf(request: object): string {
  const id: unknown = Reflect.get(request, 'sessionID');
  if (typeof id !== 'string' || !id) throw new UnauthorizedException();
  return `guest-session:${id}`;
}
export function publicView(items: readonly StoredDocument[]): PublicDocument[] {
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    size:
      item.size < 1024
        ? `${item.size} B`
        : `${(item.size / 1024).toFixed(1)} KiB`,
    contentType: item.contentType,
  }));
}
const messages: Record<string, string> = {
  UPLOAD_EXPIRED: 'An upload expired. Please choose the file again.',
  UPLOAD_NOT_FOUND:
    'An upload is no longer available. Please choose the file again.',
  UPLOAD_ALREADY_FINALIZED: 'That upload was already attached.',
  QUOTA_EXCEEDED: 'Document limit reached.',
  STORAGE_FAILED: 'Storage is unavailable. Please try again later.',
};
/** Map known upload errors to safe text; anything else is a server fault. */
export function uploadMessage(error: unknown): string {
  if (error instanceof UploadError)
    return messages[error.code] ?? `The upload was refused (${error.code}).`;
  throw error;
}

@LiveComponent({ name: 'documents', view: 'documents' })
export class Documents {
  /**
   * Temporary upload references set by `nv:upload="files"`. The purpose
   * `documents.files` is `direct: true`, so the browser PUTs each file
   * straight to the bucket through a presigned URL.
   */
  @State({ writable: true, validate: uploadReferenceField({ max: 3 }) })
  files = '';
  @State() items: PublicDocument[] = [];
  @State() message = '';
  @State() csrf = '';
  constructor(
    @Inject(REQUEST) private readonly request: object,
    @Inject(UploadsService) private readonly uploads: UploadsService,
    @Inject(DocumentRepository)
    private readonly repository: DocumentRepository,
  ) {}
  mount(): void {
    this.items = publicView(this.repository.list(ownerOf(this.request)));
    // Rendered into the plain delete forms; it equals the session CSRF token
    // the Live runtime already embeds for this identity.
    const session: unknown = Reflect.get(this.request, 'session');
    const csrf: unknown =
      session && typeof session === 'object'
        ? Reflect.get(session, 'csrf')
        : undefined;
    this.csrf = typeof csrf === 'string' ? csrf : '';
  }
  @Action() async attach(): Promise<void> {
    const owner = ownerOf(this.request);
    const tokens = parseUploadReferences(this.files, 3);
    if (!tokens.length) {
      this.message = 'Choose a file first.';
      return;
    }
    let attached = 0;
    try {
      for (const token of tokens) {
        // Finalize re-reads the object from the bucket: identity, purpose,
        // expiry, exact size, magic bytes and SHA-256 are checked again here.
        const file = await this.uploads.finalize(this.request, token, {
          purpose: 'documents.files',
        });
        this.repository.add(owner, file);
        attached++;
      }
      this.message = `Stored ${attached} file${attached === 1 ? '' : 's'} in the bucket.`;
    } catch (error) {
      this.message = uploadMessage(error);
    } finally {
      this.files = '';
      this.items = publicView(this.repository.list(owner));
    }
  }
}
