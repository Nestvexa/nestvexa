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

export interface Attachment extends FinalizedUpload {
  readonly id: string;
}
export interface PublicAttachment {
  readonly id: string;
  readonly name: string;
  readonly size: string;
  readonly contentType: string;
  readonly inline: boolean;
}

/**
 * Demonstration repository: metadata per guest session in process memory. A
 * real host stores FinalizedUpload rows in its database with ownership/tenant
 * columns and checks them on every download.
 */
@Injectable()
export class AttachmentRepository {
  readonly #items = new Map<string, Attachment[]>();
  list(owner: string): readonly Attachment[] {
    return this.#items.get(owner) ?? [];
  }
  add(owner: string, file: FinalizedUpload): Attachment {
    if (!this.#items.has(owner) && this.#items.size >= 1000)
      this.#items.clear();
    const items = [...this.list(owner)];
    if (items.length >= 50) throw new UploadError(429, 'QUOTA_EXCEEDED');
    const attachment = { ...file, id: randomBytes(9).toString('base64url') };
    this.#items.set(owner, [...items, attachment]);
    return attachment;
  }
  find(owner: string, id: string): Attachment | undefined {
    return this.list(owner).find((item) => item.id === id);
  }
  clear(owner: string): readonly Attachment[] {
    const items = this.list(owner);
    this.#items.delete(owner);
    return items;
  }
}

export function ownerOf(request: object): string {
  const id: unknown = Reflect.get(request, 'sessionID');
  if (typeof id !== 'string' || !id) throw new UnauthorizedException();
  return `guest-session:${id}`;
}
export function publicView(items: readonly Attachment[]): PublicAttachment[] {
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    size:
      item.size < 1024
        ? `${item.size} B`
        : `${(item.size / 1024).toFixed(1)} KiB`,
    contentType: item.contentType,
    inline: item.inline,
  }));
}
const messages: Record<string, string> = {
  UPLOAD_EXPIRED: 'An upload expired. Please choose the file again.',
  UPLOAD_NOT_FOUND:
    'An upload is no longer available. Please choose the file again.',
  UPLOAD_ALREADY_FINALIZED: 'That upload was already attached.',
  QUOTA_EXCEEDED: 'Attachment limit reached.',
};
export function uploadMessage(error: unknown): string {
  if (error instanceof UploadError)
    return messages[error.code] ?? `The upload was refused (${error.code}).`;
  throw error;
}

@LiveComponent({ name: 'attachments', view: 'attachments' })
export class Attachments {
  /** Server-validated temporary upload references set by `nv:upload="files"`. */
  @State({ writable: true, validate: uploadReferenceField({ max: 5 }) })
  files = '';
  /** One large file sent in resumable chunks by `nv:upload="archive"`. */
  @State({ writable: true, validate: uploadReferenceField({ max: 1 }) })
  archive = '';
  @State() items: PublicAttachment[] = [];
  @State() message = '';
  constructor(
    @Inject(REQUEST) private readonly request: object,
    @Inject(UploadsService) private readonly uploads: UploadsService,
    @Inject(AttachmentRepository)
    private readonly repository: AttachmentRepository,
  ) {}
  mount(): void {
    this.items = publicView(this.repository.list(ownerOf(this.request)));
  }
  @Action() async attach(): Promise<void> {
    const owner = ownerOf(this.request);
    const pending = [
      ...parseUploadReferences(this.files, 5).map((token) => ({
        token,
        purpose: 'attachments.files',
      })),
      ...parseUploadReferences(this.archive, 1).map((token) => ({
        token,
        purpose: 'attachments.archive',
      })),
    ];
    if (!pending.length) {
      this.message = 'Choose a file first.';
      return;
    }
    let attached = 0;
    try {
      for (const entry of pending) {
        // Re-checks identity, purpose, expiry, size, hash, content and scan.
        const file = await this.uploads.finalize(this.request, entry.token, {
          purpose: entry.purpose,
        });
        this.repository.add(owner, file);
        attached++;
      }
      this.message = `Attached ${attached} file${attached === 1 ? '' : 's'}.`;
    } catch (error) {
      this.message = uploadMessage(error);
    } finally {
      this.files = '';
      this.archive = '';
      this.items = publicView(this.repository.list(owner));
    }
  }
  @Action() async clear(): Promise<void> {
    const owner = ownerOf(this.request);
    for (const item of this.repository.clear(owner))
      await this.uploads.remove(item);
    this.items = [];
    this.message = 'All attachments removed.';
  }
}
