import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const base = 'http://127.0.0.1:3105';
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('browser-test-image'),
]);
function pdf(size: number): Buffer {
  const head = Buffer.from('%PDF-1.7\n');
  return Buffer.concat([
    head,
    Buffer.alloc(Math.max(0, size - head.byteLength), 0x20),
  ]);
}
async function open(page: Page, path = '/') {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + path);
  return errors;
}

test('uploads several files with progress, finalizes them and downloads with a byte range', async ({
  page,
}) => {
  // Three uploads, finalization and three downloads: allow for slow shared CI hosts.
  test.setTimeout(90_000);
  const errors = await open(page);
  await expect(page.locator('#attachment-empty')).toBeVisible();
  const uploads: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/_nestvexa/uploads/'))
      uploads.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  await page.setInputFiles('#attachment-files', [
    { name: 'logo.png', mimeType: 'image/png', buffer: png },
    {
      name: 'notes — مرحبا.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Meeting notes\nمرحبا\n'),
    },
    {
      name: 'report.pdf',
      mimeType: 'application/pdf',
      buffer: pdf(150 * 1024),
    },
  ]);
  await expect(page.locator('#attachment-files-status')).toHaveText(
    'Uploaded 3 files',
    { timeout: 20_000 },
  );
  const progress = page.locator('#attachment-files-progress');
  expect(
    await progress.evaluate(
      (element: HTMLProgressElement) =>
        element.value === element.max && element.max > 150 * 1024,
    ),
  ).toBe(true);
  // The 150 KiB PDF crossed several 64 KiB resumable chunks.
  expect(
    uploads.filter((entry) => entry.startsWith('PUT')).length,
  ).toBeGreaterThanOrEqual(5);
  await page.getByRole('button', { name: 'Attach uploaded files' }).click();
  await expect(page.locator('#attachments-message')).toHaveText(
    'Attached 3 files.',
    { timeout: 20_000 },
  );
  await expect(page.locator('#attachment-list > li')).toHaveCount(3);
  const link = page.getByRole('link', { name: 'Download report.pdf' });
  const href = await link.getAttribute('href');
  expect(href).toMatch(/^\/attachments\/[A-Za-z0-9_-]+\/download$/);
  const download = await page.request.get(base + String(href), {
    headers: { range: 'bytes=0-7' },
  });
  expect(download.status()).toBe(206);
  expect(download.headers()['content-range']).toBe(`bytes 0-7/${150 * 1024}`);
  expect((await download.body()).toString()).toBe('%PDF-1.7');
  expect(download.headers()['x-content-type-options']).toBe('nosniff');
  const notes = page.getByRole('link', { name: 'Download notes — مرحبا.txt' });
  const headers = (
    await page.request.get(base + String(await notes.getAttribute('href')))
  ).headers();
  expect(headers['content-disposition']).toBe(
    `attachment; filename="notes _ _____.txt"; filename*=UTF-8''${encodeURIComponent('notes — مرحبا.txt')}`,
  );
  expect(headers['content-type']).toBe('text/plain; charset=utf-8');
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    notes.click(),
  ]);
  // Browsers use the RFC 5987 UTF-8 name; some platforms fall back to the ASCII name.
  expect(['notes — مرحبا.txt', 'notes _ _____.txt']).toContain(
    file.suggestedFilename(),
  );
  // Another browser session cannot fetch the file even with the URL.
  const stranger = await page.context().browser()?.newContext();
  if (stranger) {
    const response = await stranger.request.get(base + String(href));
    expect(response.status()).toBe(404);
    await stranger.close();
  }
  expect(errors).toEqual([]);
});

test('cancels an in-flight chunked upload and announces server rejections', async ({
  page,
}) => {
  const errors = await open(page);
  // Hold the second chunk so the cancel button is pressed mid-upload.
  let held = false;
  await page.route(
    '**/_nestvexa/uploads/sessions/*/chunks/1',
    async (route) => {
      held = true;
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.continue().catch(() => undefined);
    },
  );
  const discarded = page.waitForRequest(
    (request) =>
      request.method() === 'DELETE' &&
      request.url().includes('/_nestvexa/uploads/sessions/'),
  );
  await page.setInputFiles('#attachment-archive', {
    name: 'big.pdf',
    mimeType: 'application/pdf',
    buffer: pdf(300 * 1024),
  });
  await expect.poll(() => held).toBe(true);
  await expect(page.locator('#attachment-archive-status')).toContainText(
    'Uploading',
  );
  await page.getByRole('button', { name: 'Cancel or clear large PDF' }).click();
  await expect(page.locator('#attachment-archive-status')).toHaveText(
    'Upload cancelled',
  );
  await discarded;
  await page.unroute('**/_nestvexa/uploads/sessions/*/chunks/1');
  await page.getByRole('button', { name: 'Attach uploaded files' }).click();
  await expect(page.locator('#attachments-message')).toHaveText(
    'Choose a file first.',
  );
  // Spoofed content: PDF bytes named .png are refused by magic-byte checks.
  await page.setInputFiles('#attachment-files', {
    name: 'fake.png',
    mimeType: 'image/png',
    buffer: pdf(1000),
  });
  await expect(page.locator('#attachment-files-status')).toHaveText(
    'Upload failed: This file type is not allowed.',
  );
  await expect(page.locator('#attachment-files')).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await page.setInputFiles('#attachment-files', {
    name: 'script.html',
    mimeType: 'text/html',
    buffer: Buffer.from('<script>x</script>'),
  });
  await expect(page.locator('#attachment-files-status')).toHaveText(
    'Upload failed: This file type is not allowed.',
  );
  expect(errors).toEqual([]);
});

test('no-JavaScript form uploads through the same pipeline with CSRF and redirect', async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`${base}/classic`);
  await page.setInputFiles('#classic-files', [
    { name: 'scan.pdf', mimeType: 'application/pdf', buffer: pdf(2048) },
    {
      name: 'data.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('a,b\n1,2\n'),
    },
  ]);
  await page.getByRole('button', { name: 'Upload and attach' }).click();
  await expect(page).toHaveURL(`${base}/classic`);
  await expect(page.locator('#classic-notice')).toHaveText('Attached 2 files.');
  await expect(page.locator('#classic-list > li')).toHaveCount(2);
  await page.setInputFiles('#classic-files', {
    name: 'evil.png',
    mimeType: 'image/png',
    buffer: Buffer.from('MZ-not-an-image'),
  });
  await page.getByRole('button', { name: 'Upload and attach' }).click();
  await expect(page.locator('#classic-notice')).toHaveText(
    'The upload was refused (DANGEROUS_CONTENT).',
  );
  await expect(page.locator('#classic-list > li')).toHaveCount(2);
  // A cross-site form post without the session's token is refused.
  const forged = await context.request.post(`${base}/classic`, {
    headers: { origin: 'https://attacker.example' },
    multipart: {
      _csrf: 'forged',
      files: { name: 'x.pdf', mimeType: 'application/pdf', buffer: pdf(100) },
    },
    maxRedirects: 0,
  });
  expect(forged.status()).toBe(303);
  await page.goto(`${base}/classic`);
  await expect(page.locator('#classic-notice')).toHaveText(
    'The upload was refused (ORIGIN_REJECTED).',
  );
  await expect(page.locator('#classic-list > li')).toHaveCount(2);
  await context.close();
});

test('upload pages pass automated accessibility checks', async ({ page }) => {
  await open(page);
  await page.setInputFiles('#attachment-files', {
    name: 'a.png',
    mimeType: 'image/png',
    buffer: png,
  });
  await expect(page.locator('#attachment-files-status')).toHaveText(
    'Uploaded 1 file',
  );
  const live = await new AxeBuilder({ page }).analyze();
  expect(live.violations).toEqual([]);
  await page.goto(`${base}/classic`);
  const classic = await new AxeBuilder({ page }).analyze();
  expect(classic.violations).toEqual([]);
});
