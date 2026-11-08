import type { Page } from '@playwright/test';
import { exampleUrl } from './example-url.js';

/** The browser-lab example: real Nest server, default boot module, CSP Alpine. */
export const labUrl = exampleUrl('browser-lab', 3860);

/** Resolves once the page's default boot module (Live mount + Alpine start) has run. */
export async function booted(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await import('/_nestvexa/boot.js' as string);
  });
}

/** Open a lab page, collect page errors and mark the document to detect reloads. */
export async function openLab(page: Page, path = '/'): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(labUrl + path);
  await booted(page);
  await page.evaluate(() => Reflect.set(window, 'nvSameDocument', true));
  return errors;
}

/** Per-session counts of full HTML renders by page. */
export async function served(page: Page): Promise<Record<string, number>> {
  const response = await page.request.get(labUrl + '/api/served');
  return (await response.json()) as Record<string, number>;
}

/** True while the document that `openLab` marked is still loaded. */
export function sameDocument(page: Page): Promise<boolean> {
  return page.evaluate(() => Reflect.get(window, 'nvSameDocument') === true);
}
