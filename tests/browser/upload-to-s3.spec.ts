import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { exampleUrl } from './example-url.js';

// examples/upload-to-s3 against the fake S3 test double (tests/support/fake-s3-server.ts).
const base = exampleUrl('upload-to-s3', 3117);
const fakeS3 = process.env['NV_E2E_FAKE_S3_URL'] ?? 'http://127.0.0.1:3118';
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from(`s3-browser-test-${Date.now()}-${Math.random()}`),
]);
const pdf = Buffer.concat([
  Buffer.from('%PDF-1.7\n'),
  Buffer.from(`direct upload ${Date.now()}-${Math.random()}\n`),
]);
const sha256 = (value: Buffer) =>
  createHash('sha256').update(value).digest('hex');

interface StoredObject {
  readonly key: string;
  readonly size: number;
  readonly sha256: string;
  readonly contentType: string;
}
async function objects(request: APIRequestContext): Promise<StoredObject[]> {
  const response = await request.get(`${fakeS3}/__fake/objects`);
  expect(response.status()).toBe(200);
  return (await response.json()) as StoredObject[];
}
async function open(page: Page, path = '/') {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + path);
  return errors;
}

test('uploads straight to the bucket, verifies the object, downloads it and deletes it', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const errors = await open(page);
  await expect(page.locator('#document-empty')).toBeVisible();
  const traffic: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === new URL(fakeS3).origin)
      traffic.push(`${request.method()} storage`);
    else if (url.pathname.startsWith('/_nestvexa/uploads/'))
      traffic.push(`${request.method()} ${url.pathname.split('/')[3] ?? ''}`);
  });
  await page.setInputFiles('#document-files', [
    { name: 'scan.pdf', mimeType: 'application/pdf', buffer: pdf },
    { name: 'logo.png', mimeType: 'image/png', buffer: png },
  ]);
  await expect(page.locator('#document-files-status')).toHaveText(
    'Uploaded 2 files',
    { timeout: 20_000 },
  );
  // Bytes went to storage with a presigned PUT, never as server chunks.
  expect(traffic.filter((entry) => entry === 'PUT storage')).toHaveLength(2);
  expect(traffic.some((entry) => entry.startsWith('PUT sessions'))).toBe(false);
  await page.getByRole('button', { name: 'Store uploaded files' }).click();
  await expect(page.locator('#documents-message')).toHaveText(
    'Stored 2 files in the bucket.',
  );
  await expect(page.locator('#document-list li')).toHaveCount(2);

  const stored = await objects(page.request);
  const pdfObject = stored.find((item) => item.sha256 === sha256(pdf));
  const pngObject = stored.find((item) => item.sha256 === sha256(png));
  expect(pdfObject).toMatchObject({
    size: pdf.byteLength,
    contentType: 'application/pdf',
  });
  expect(pngObject).toMatchObject({ contentType: 'image/png' });
  // Generated keys only: the user's file name never becomes an object key.
  expect(pdfObject?.key).not.toContain('scan');

  // Streamed, owner-only download through the server.
  const download = await page.request.get(
    base +
      ((await page
        .getByRole('link', { name: 'Download scan.pdf' })
        .getAttribute('href')) ?? ''),
  );
  expect(download.status()).toBe(200);
  expect(Buffer.from(await download.body()).equals(pdf)).toBe(true);
  expect(download.headers()['content-disposition']).toContain('attachment');
  expect(download.headers()['x-content-type-options']).toBe('nosniff');

  // Presigned GET: a short-lived bucket URL with a forced attachment.
  const linkPath =
    (await page
      .getByRole('link', { name: 'Presigned link for logo.png' })
      .getAttribute('href')) ?? '';
  const redirect = await page.request.get(base + linkPath, {
    maxRedirects: 0,
  });
  expect(redirect.status()).toBe(303);
  const presigned = redirect.headers()['location'] ?? '';
  expect(presigned.startsWith(`${fakeS3}/`)).toBe(true);
  expect(presigned).toContain('X-Amz-Signature=');
  expect(presigned).not.toContain('nestvexa-example-secret');
  const fromBucket = await page.request.get(presigned);
  expect(Buffer.from(await fromBucket.body()).equals(png)).toBe(true);

  // Delete is a plain POST + redirect and removes the bucket object.
  await page.getByRole('button', { name: 'Delete scan.pdf' }).click();
  await expect(page.locator('#page-notice')).toHaveText(
    'Deleted scan.pdf from the bucket.',
  );
  await expect(page.locator('#document-list li')).toHaveCount(1);
  expect(
    (await objects(page.request)).some((item) => item.sha256 === sha256(pdf)),
  ).toBe(false);
  expect(errors).toEqual([]);
});

test('another session cannot download, link or delete a stored file', async ({
  page,
  browser,
}) => {
  test.setTimeout(60_000);
  await open(page);
  await page.setInputFiles('#document-files', {
    name: 'private.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(`owner only ${Math.random()}`),
  });
  await expect(page.locator('#document-files-status')).toHaveText(
    'Uploaded 1 file',
    { timeout: 20_000 },
  );
  await page.getByRole('button', { name: 'Store uploaded files' }).click();
  await expect(page.locator('#document-list li')).toHaveCount(1);
  const href =
    (await page
      .getByRole('link', { name: 'Download private.txt' })
      .getAttribute('href')) ?? '';
  const id = href.split('/')[2] ?? '';
  expect(id).not.toBe('');
  const csrf = await page
    .locator('#document-list input[name="_csrf"]')
    .inputValue();

  const other = await browser.newContext();
  try {
    const intruder = await other.newPage();
    await intruder.goto(base + '/');
    for (const path of [`/files/${id}/download`, `/files/${id}/link`])
      expect(
        (await intruder.request.get(base + path, { maxRedirects: 0 })).status(),
      ).toBe(404);
    // Even with the owner's CSRF token, the other session's delete fails.
    const forged = await intruder.request.post(`${base}/files/${id}/delete`, {
      form: { _csrf: csrf },
      headers: { origin: base },
      maxRedirects: 0,
    });
    expect(forged.status()).toBe(403);
  } finally {
    await other.close();
  }
  // A cross-origin delete from the owner's session is refused too.
  const crossOrigin = await page.request.post(`${base}/files/${id}/delete`, {
    form: { _csrf: csrf },
    headers: { origin: 'https://attacker.example' },
    maxRedirects: 0,
  });
  expect(crossOrigin.status()).toBe(403);
  await page.reload();
  await expect(page.locator('#document-list li')).toHaveCount(1);
});

test('refuses oversized files, disallowed types and mislabelled bytes', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await open(page);
  const mislabelled = Buffer.concat([
    Buffer.from('%PDF-1.7\n'),
    Buffer.from(`mislabelled ${Date.now()}-${Math.random()}\n`),
  ]);
  await page.setInputFiles('#document-files', {
    name: 'huge.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(1100_000)]),
  });
  await expect(page.locator('#document-files-status')).toHaveText(
    'Upload failed: The file is too large.',
  );
  await page.setInputFiles('#document-files', {
    name: 'page.html',
    mimeType: 'text/html',
    buffer: Buffer.from('<script>alert(1)</script>'),
  });
  await expect(page.locator('#document-files-status')).toHaveText(
    'Upload failed: This file type is not allowed.',
  );
  // PDF bytes declared as PNG reach the bucket, fail verification on
  // completion and are deleted again.
  await page.setInputFiles('#document-files', {
    name: 'fake.png',
    mimeType: 'image/png',
    buffer: mislabelled,
  });
  await expect(page.locator('#document-files-status')).toHaveText(
    'Upload failed: This file type is not allowed.',
    { timeout: 20_000 },
  );
  await expect(page.locator('#document-files')).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await expect
    .poll(async () =>
      (await objects(page.request)).some(
        (item) => item.sha256 === sha256(mislabelled),
      ),
    )
    .toBe(false);
  await expect(page.locator('#document-empty')).toBeVisible();
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });
  test('the classic form stores a file in the bucket through the server', async ({
    page,
  }) => {
    await page.goto(base + '/classic');
    const body = Buffer.from(`classic ${Math.random()}`);
    await page.setInputFiles('#classic-files', {
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: body,
    });
    await page.getByRole('button', { name: 'Upload and store' }).click();
    await expect(page).toHaveURL(base + '/classic');
    await expect(page.locator('#classic-notice')).toHaveText(
      'Stored 1 file in the bucket.',
    );
    expect(
      (await objects(page.request)).some(
        (item) => item.sha256 === sha256(body),
      ),
    ).toBe(true);
    await page.getByRole('button', { name: 'Delete notes.txt' }).click();
    await expect(page.locator('#classic-notice')).toHaveText(
      'Deleted notes.txt from the bucket.',
    );
  });
});

test('upload page passes an accessibility scan @accessibility', async ({
  page,
}) => {
  // Two full axe scans: allow for slow shared CI hosts (WebKit especially).
  test.setTimeout(90_000);
  await open(page);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
  await page.goto(base + '/classic');
  const classic = await new AxeBuilder({ page }).analyze();
  expect(classic.violations).toEqual([]);
});
