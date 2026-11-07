import { expect, test } from '@playwright/test';
import { defineClientOnlySuite } from './inertia-feature-smoke.js';
import {
  defineFrameworkSuite,
  exampleUrl,
  hydrated,
  markDocument,
  sameDocument,
} from './inertia-framework-suite.js';
import { defineFormsUploadsSuite } from './inertia-forms-uploads.js';

// examples/inertia-react: Vite production build, official @inertiajs/react
// 3.10.0 client, SSR through the official Inertia SSR server process
// (dist/ssr/ssr.js on 127.0.0.1:13716) reached via HttpSsrGateway. A second
// instance (`start:csr`) serves the same build with SSR disabled.
const base = exampleUrl('REACT', 3106);

defineFrameworkSuite({ framework: 'React', base });
defineFormsUploadsSuite({ framework: 'React', base });
defineClientOnlySuite({
  framework: 'React',
  base: exampleUrl('REACT_CSR', 3210),
});

test.describe('Inertia React example extras', () => {
  test.describe.configure({ timeout: 90000 });

  test('uploads a file with useForm FormData and validates it on the server', async ({
    page,
    browserName,
  }) => {
    await page.goto(`${base}/uploads`);
    await hydrated(page);
    await markDocument(page);
    await page.getByRole('button', { name: 'Upload' }).click();
    await expect(page.getByRole('alert')).toHaveText('Choose a file.');
    await page.getByLabel(/Document/).setInputFiles({
      name: 'evil.html',
      mimeType: 'text/html',
      buffer: Buffer.from('<script>alert(1)</script>'),
    });
    await page.getByRole('button', { name: 'Upload' }).click();
    await expect(page.getByRole('alert')).toHaveText(
      'Only plain text and PNG files are accepted.',
    );
    const name = `notes-${browserName}-${Date.now()}.txt`;
    const upload = page.waitForRequest(
      (request) =>
        request.method() === 'POST' && request.url().endsWith('/uploads'),
    );
    await page.getByLabel(/Document/).setInputFiles({
      name,
      mimeType: 'text/plain',
      buffer: Buffer.from('hello from playwright'),
    });
    await page.getByRole('button', { name: 'Upload' }).click();
    expect((await upload).headers()['content-type']).toContain(
      'multipart/form-data',
    );
    await expect(page.getByTestId('flash')).toHaveText(`Uploaded ${name}`);
    await expect(
      page
        .getByRole('list', { name: 'Uploaded files' })
        .getByText(`${name} (21 bytes, text/plain)`),
    ).toBeVisible();
    expect(await sameDocument(page)).toBe(true);
  });
  test('validateFiles() sends multipart Precognition requests that the FileInterceptor parses', async ({
    page,
  }) => {
    await page.goto(`${base}/uploads`);
    await hydrated(page);
    await markDocument(page);
    const stored = page
      .getByRole('list', { name: 'Uploaded files' })
      .getByRole('listitem');
    const before = await stored.count();
    const validation = () =>
      page.waitForResponse(
        (response) =>
          response.request().headers()['precognition'] === 'true' &&
          new URL(response.url()).pathname === '/uploads',
      );
    let reply = validation();
    await page.getByLabel(/Document/).setInputFiles({
      name: 'evil.html',
      mimeType: 'text/html',
      buffer: Buffer.from('<script>alert(1)</script>'),
    });
    let response = await reply;
    expect(response.status()).toBe(422);
    expect(response.headers()['precognition']).toBe('true');
    const sent = response.request().headers();
    expect(sent['content-type']).toContain('multipart/form-data');
    expect(sent['precognition-validate-only']).toBe('document');
    expect(sent['x-xsrf-token']).toBeTruthy();
    await expect(page.getByRole('alert')).toHaveText(
      'Only plain text and PNG files are accepted.',
    );
    reply = validation();
    await page.getByLabel(/Document/).setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('validated, not stored'),
    });
    response = await reply;
    expect(response.status()).toBe(204);
    expect(response.headers()['precognition-success']).toBe('true');
    await expect(page.getByTestId('document-valid')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    // Validation-only requests never reached the handler.
    await expect(stored).toHaveCount(before);
    expect(await sameDocument(page)).toBe(true);
  });
});
