import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  cspViolations,
  exampleUrl,
  hydrated,
  observe,
} from './inertia-framework-suite.js';

// examples/inertia-react /kit: the @nestvexa/ui primitives through the React
// wrappers (@nestvexa/ui/react, ADR 0033) in a real Inertia root with SSR,
// hydration and the per-request CSP nonce. Parity with the HBS helpers is
// proven in tests/ui-adapters.test.ts; this proves the runnable SPA example.
const base = exampleUrl('REACT', 3106);
const wait = expect.configure({ timeout: 15000 });

const active = (page: Page) =>
  page.evaluate(
    () =>
      document.activeElement?.id || document.activeElement?.textContent?.trim(),
  );

test.describe('React UI kit wrappers in the Inertia example', () => {
  // Two axe passes are slow in Firefox and WebKit on loaded hosts.
  test.describe.configure({ timeout: 240000 });

  test('hydrates without axe or CSP violations and drives every primitive from the keyboard', async ({
    page,
  }) => {
    const observed = await observe(page);
    await page.goto(`${base}/kit`);
    await hydrated(page);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    // Dialog: trigger, focus moves in, Escape closes and focus returns.
    await page.locator('[data-nv-ui-open="kit-dialog"]').focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('#kit-dialog[open]');
    expect(await active(page)).toBe('kit-name');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#kit-dialog:not([open])', {
      state: 'attached',
    });
    expect(await active(page)).toBe('Open dialog');
    await wait(page.getByTestId('kit-log')).toHaveText('dialog:closed');

    // Tabs: roving focus and panels.
    await page.locator('#kit-tabs-overview-tab').focus();
    await page.keyboard.press('ArrowRight');
    expect(await active(page)).toBe('kit-tabs-details-tab');
    await expect(page.locator('#kit-tabs-details-panel')).toBeVisible();
    await expect(page.locator('#kit-tabs-overview-panel')).toBeHidden();

    // Menu: keyboard selection reported to React.
    await page.locator('#kit-menu-button').focus();
    await page.keyboard.press('Enter');
    expect(await active(page)).toBe('Copy id');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await wait(page.getByTestId('kit-log')).toHaveText(
      'dialog:closed,menu:archive',
    );
    expect(await active(page)).toBe('kit-menu-button');

    // Toast through the component handle.
    await page.getByRole('button', { name: 'Notify' }).click();
    const toast = page.locator('#kit-toasts [data-nv-ui-list] .nv-toast');
    await wait(toast.locator('.nv-toast__text')).toHaveText('Saved');

    // Date picker: UTC formatting and change callback.
    await expect(page.locator('#kit-due-formatted')).toHaveText(
      'March 4, 2026',
    );
    await page.locator('#kit-due').fill('2026-12-25');
    await wait(page.getByTestId('kit-due')).toHaveText('2026-12-25');
    await expect(page.locator('#kit-due-formatted')).toHaveText(
      'December 25, 2026',
    );

    // Data table: client search and filtered select-all.
    await page.locator('#kit-table-search').fill('books');
    await wait(page.locator('#kit-table-status')).toHaveText('2 results');
    await page.locator('#kit-table-search').fill('');
    await page.locator('#kit-table-category').selectOption('tools');
    await page.locator('[data-nv-ui-select-all="kit-table"]').check();
    await wait(page.locator('#kit-table-status')).toContainText('1 selected');
    await expect(page.getByLabel('Select Hammer')).toBeChecked();
    await expect(page.getByLabel('Select Atlas')).not.toBeChecked();

    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await cspViolations(page)).toEqual([]);
    expect(observed.errors).toEqual([]);
  });
});
