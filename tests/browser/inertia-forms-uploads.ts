import { expect, test } from '@playwright/test';
import type { Page, Request } from '@playwright/test';
import {
  assertInertia,
  inertiaHeaders,
} from '../../packages/inertia/dist/testing.js';
import { hydrated, observe } from './inertia-framework-suite.js';
import type { FrameworkSuite } from './inertia-framework-suite.js';

// @nestvexa/forms + @nestvexa/uploads with the official Inertia clients
// (examples/inertia-{react,vue,svelte} /documents, src/documents.ts): the file
// is uploaded through @nestvexa/uploads/browser with progress, the form
// submits JSON carrying the nvu_… token, Precognition validates with the same
// forms schema, and failures land in useForm errors (field and `_form`).

const wait = expect.configure({ timeout: 15000 });
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-png-body-for-tests'),
]);

function precognition(page: Page, field: string) {
  return page.waitForResponse(
    (response) =>
      response.request().headers()['precognition'] === 'true' &&
      (response.request().headers()['precognition-validate-only'] ?? '')
        .split(',')
        .includes(field),
  );
}

async function upload(
  page: Page,
  name: string,
  mimeType: string,
  buffer: Buffer,
): Promise<void> {
  await page
    .getByLabel('File (plain text or PNG, up to 64 KB)')
    .setInputFiles({ name, mimeType, buffer });
}

export function defineFormsUploadsSuite({ framework, base }: FrameworkSuite) {
  test.describe(`${framework} forms + uploads through the official client`, () => {
    test.describe.configure({ timeout: 90000 });
    const unique = () =>
      `${framework} report ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

    test('uploads with progress, validates with Precognition and submits the token', async ({
      page,
    }) => {
      const observed = await observe(page);
      await page.goto(`${base}/documents`);
      await hydrated(page);
      const title = page.getByLabel('Title');

      // The client only validates changed values: an over-long title first.
      let reply = precognition(page, 'title');
      await title.fill('x'.repeat(61));
      await title.blur();
      let response = await reply;
      expect(response.status()).toBe(422);
      await wait(page.locator('#document-title-error')).toHaveText(
        'The title may not be greater than 60 characters.',
      );
      await expect(title).toHaveAttribute('aria-invalid', 'true');

      const name = unique();
      reply = precognition(page, 'title');
      await title.fill(name);
      await title.blur();
      response = await reply;
      expect(response.status()).toBe(204);
      await wait(page.locator('#document-title-error')).toHaveCount(0);

      const uploadRequests: Request[] = [];
      page.on('request', (request) => {
        if (request.url().includes('/_nestvexa/uploads/'))
          uploadRequests.push(request);
      });
      const text = 'nestvexa '.repeat(4000);
      reply = precognition(page, 'attachment');
      await upload(page, 'notes.txt', 'text/plain', Buffer.from(text));
      await wait(page.locator('#document-file-status')).toHaveText(
        'Uploaded notes.txt',
      );
      await expect(page.getByLabel('Upload progress')).toHaveJSProperty(
        'value',
        100,
      );
      response = await reply;
      expect(response.status()).toBe(204);
      const session = uploadRequests.find(
        (request) =>
          request.method() === 'POST' && request.url().endsWith('/sessions'),
      );
      expect(session?.headers()['x-nestvexa-csrf']).toBeTruthy();
      expect(uploadRequests.some((request) => request.method() === 'PUT')).toBe(
        true,
      );

      const submitted = page.waitForRequest(
        (request) =>
          request.method() === 'POST' &&
          new URL(request.url()).pathname === '/documents' &&
          request.headers()['precognition'] !== 'true',
      );
      await page.getByRole('button', { name: 'Save document' }).click();
      const submit = await submitted;
      // The form carries the opaque token as JSON, never the file bytes.
      expect(submit.headers()['content-type']).toContain('application/json');
      const body = submit.postDataJSON() as Record<string, unknown>;
      expect(body['title']).toBe(name);
      expect(String(body['attachment'])).toMatch(/^nvu_[A-Za-z0-9_-]{43}$/);
      expect(submit.postData() ?? '').not.toContain('nestvexa nestvexa');
      await wait(page.getByTestId('flash')).toHaveText(`Stored ${name}`);
      await expect(
        page.getByRole('list', { name: 'Stored documents' }),
      ).toContainText(`${name}: notes.txt (${text.length} bytes, text/plain`);
      expect(observed.errors).toEqual([]);
    });

    test('maps upload, field and form-level failures to useForm errors', async ({
      page,
    }) => {
      await page.goto(`${base}/documents`);
      await hydrated(page);
      // A refused file type never produces a token.
      await upload(
        page,
        'report.pdf',
        'application/pdf',
        Buffer.from('%PDF-1.7'),
      );
      await wait(page.locator('#document-file-status')).toHaveText(
        'Upload failed: This file type is not allowed.',
      );
      // Submitting without a token: the server-side schema rejects it and the
      // validation filter redirects back with the error.
      const name = unique();
      await page.getByLabel('Title').fill(name);
      await page.getByRole('button', { name: 'Save document' }).click();
      await wait(page.getByTestId('attachment-error')).toHaveText(
        'Upload a file first.',
      );
      // Store one document, then reuse its title: a form-level (`_form`) error.
      await upload(page, 'pixel.png', 'image/png', PNG);
      await wait(page.locator('#document-file-status')).toHaveText(
        'Uploaded pixel.png',
      );
      await page.getByRole('button', { name: 'Save document' }).click();
      await wait(page.getByTestId('flash')).toHaveText(`Stored ${name}`);
      await page.getByLabel('Title').fill(name);
      // A different file, so the input's selection always changes.
      await upload(page, 'pixel-2.png', 'image/png', PNG);
      await wait(page.locator('#document-file-status')).toHaveText(
        'Uploaded pixel-2.png',
      );
      await page.getByRole('button', { name: 'Save document' }).click();
      await wait(page.getByTestId('form-error')).toHaveText(
        'A document with this title already exists.',
      );
    });

    test('a forged token is refused by finalization and shown on the field', async ({
      page,
    }) => {
      await page.goto(`${base}/documents`);
      await hydrated(page);
      const cookies = await page.context().cookies(base);
      const xsrf = cookies.find((cookie) => cookie.name === 'XSRF-TOKEN');
      expect(xsrf).toBeDefined();
      const forged = `nvu_${'A'.repeat(43)}`;
      const reply = await page.request.post(`${base}/documents`, {
        headers: {
          ...inertiaHeaders(),
          'x-xsrf-token': decodeURIComponent(xsrf?.value ?? ''),
          referer: `${base}/documents`,
        },
        data: { title: unique(), attachment: forged },
        maxRedirects: 0,
      });
      expect(reply.status()).toBe(302);
      expect(reply.headers()['location']).toBe('/documents');
      // The follow-up document render carries the flashed errors.
      const document = await page.request.get(`${base}/documents`);
      assertInertia(
        { headers: document.headers(), text: await document.text() },
        'Files/Documents',
      )
        .hasErrors('attachment')
        .where('errors.attachment', 'Upload the file again.')
        .missing('errors.title');
    });
  });
}
