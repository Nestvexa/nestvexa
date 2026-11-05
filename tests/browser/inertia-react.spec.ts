import { expect, test } from '@playwright/test';
import { defineClientOnlySuite } from './inertia-feature-smoke.js';
import {
  defineFrameworkSuite,
  exampleUrl,
  hydrated,
  markDocument,
  sameDocument,
} from './inertia-framework-suite.js';

// examples/inertia-react: Vite production build, official @inertiajs/react
// 3.10.0 client, SSR through the official Inertia SSR server process
// (dist/ssr/ssr.js on 127.0.0.1:13716) reached via HttpSsrGateway. A second
// instance (`start:csr`) serves the same build with SSR disabled.
const base = exampleUrl('REACT', 3106);

defineFrameworkSuite({ framework: 'React', base });
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
});
