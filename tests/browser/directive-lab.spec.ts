import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.use({ baseURL: 'http://127.0.0.1:3360' });
// WebKit on loaded Windows hosts can exceed the default 30s for dialog flows.
test.describe.configure({ timeout: 60_000 });

declare global {
  interface Window {
    nvViolations: string[];
  }
}

async function open(page: Page): Promise<void> {
  await page.goto('/');
  // Cloaking is not used here; the first successful binding pass marks readiness.
  await page.waitForFunction(() => Array.isArray(window.nvViolations));
  await expect(page.locator('[data-nv-component]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
}
async function noViolations(page: Page): Promise<void> {
  expect(await page.evaluate(() => window.nvViolations)).toEqual([]);
}

test('event modifiers, optimistic updates and global hotkeys against a real Nest server', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: 'Increment', exact: true }).click();
  await expect(page.locator('#count')).toHaveText('1');
  await page.getByRole('button', { name: 'Increment once' }).dblclick();
  await page.getByRole('button', { name: 'Increment once' }).click();
  await expect(page.locator('#count')).toHaveText('2');
  await page
    .getByRole('button', { name: 'Debounced increment' })
    .evaluate((element) => {
      (element as HTMLButtonElement).click();
      (element as HTMLButtonElement).click();
      (element as HTMLButtonElement).click();
    });
  await expect(page.locator('#count')).toHaveText('3');
  await page.getByRole('button', { name: 'Control-click increment' }).click();
  await page.waitForTimeout(200);
  await expect(page.locator('#count')).toHaveText('3');
  await page
    .getByRole('button', { name: 'Control-click increment' })
    .click({ modifiers: ['ControlOrMeta'] });
  // ControlOrMeta presses Meta on macOS WebKit; only .ctrl is declared.
  if (process.platform !== 'darwin')
    await expect(page.locator('#count')).toHaveText('4');
  await page.locator('#query').focus();
  await page.keyboard.press('Escape');
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('Escape');
  await expect(page.locator('#hotkeys')).toHaveText('2');
  await noViolations(page);
});

test('loading delay, targeted disabling and quick work that never flashes', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    const quick = document.getElementById('quick-status');
    Reflect.set(window, 'nvQuickShown', 0);
    if (quick)
      new MutationObserver(() => {
        if (!quick.hidden)
          Reflect.set(
            window,
            'nvQuickShown',
            Number(Reflect.get(window, 'nvQuickShown')) + 1,
          );
      }).observe(quick, { attributes: true });
  });
  await page.getByRole('button', { name: 'Increment', exact: true }).click();
  await expect(page.locator('#count')).toHaveText('1');
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => Reflect.get(window, 'nvQuickShown'))).toBe(
    0,
  );
  const slow = page.getByRole('button', { name: 'Slow increment' });
  await slow.click();
  await expect(slow).toBeDisabled();
  await expect(page.locator('#slow-status')).toBeVisible();
  await expect(page.locator('#count')).toHaveText('2');
  await expect(slow).toBeEnabled();
  await expect(page.locator('#slow-status')).toBeHidden();
  await noViolations(page);
});

test('submit validation, deferred model, dirty state and live model synchronization', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(200);
  await expect(page.locator('#saved')).toHaveText('');
  await page.getByLabel('Email').fill('ada@example.test');
  await expect(page.locator('#email-dirty')).toBeVisible();
  await page.getByLabel('Email').press('Enter');
  await expect(page.locator('#saved')).toHaveText('ada@example.test');
  await expect(page.locator('#email-dirty')).toBeHidden();
  await expect(page.locator('#message')).toHaveText('Saved ada@example.test');
  await page.getByLabel('Search').pressSequentially('nest');
  await expect(page.locator('#server-query')).toHaveText('nest');
  await expect(page.locator('#syncing')).toBeHidden();
  await page.getByLabel('Quantity').fill('7');
  await expect(page.locator('#server-quantity')).toHaveText('1');
  await page.getByLabel('Quantity').blur();
  await expect(page.locator('#server-quantity')).toHaveText('7');
  await expect(page).toHaveURL('http://127.0.0.1:3360/');
  await noViolations(page);
});

test('native confirmation, visibility focus fallback and retained live region', async ({
  page,
}) => {
  await open(page);
  const message = await page.locator('#message').elementHandle();
  page.once('dialog', (dialog) => void dialog.dismiss());
  await page.getByRole('button', { name: 'Remove' }).click();
  await page.waitForTimeout(200);
  await expect(page.locator('#message')).toHaveText('Ready');
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('#message')).toHaveText('Removed');
  // The polite live region is the same node, updated in place.
  expect(
    await page.evaluate(
      (node) => node === document.getElementById('message'),
      message,
    ),
  ).toBe(true);
  await expect(
    page.getByRole('button', { name: 'Toggle panel' }),
  ).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('button', { name: 'Close panel' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#panel')).toBeHidden();
  await expect(
    page.getByRole('button', { name: 'Toggle panel' }),
  ).toHaveAttribute('aria-expanded', 'false');
  expect(
    await page.evaluate(
      () =>
        document.activeElement ===
        document.querySelector('[data-nv-component]'),
    ),
  ).toBe(true);
  await noViolations(page);
});

test('recoverable rejection keeps working; an uncertain failure suspends without a false offline hint', async ({
  page,
}) => {
  await open(page);
  // A server validator rejects the synchronized draft; a corrected edit proceeds.
  await page.getByLabel('Search').fill('x'.repeat(41));
  await expect(page.locator('#error')).toHaveText('Error: HTTP');
  await expect(page.locator('#server-query')).toHaveText('');
  await page.getByLabel('Search').fill('fixed');
  await expect(page.locator('#server-query')).toHaveText('fixed');
  await page.getByRole('button', { name: 'Increment', exact: true }).click();
  await expect(page.locator('#count')).toHaveText('1');
  await page.locator('#error').evaluate((node) => {
    node.textContent = '';
  });
  // An action exception is uncertain: the client suspends transport.
  await page.getByRole('button', { name: 'Failing action' }).click();
  await expect(page.locator('#error')).toHaveText('Error: HTTP');
  await expect(page.locator('#offline')).toBeHidden();
  await page.getByRole('button', { name: 'Increment once' }).click();
  await page.waitForTimeout(300);
  await expect(page.locator('#count')).toHaveText('1');
  await expect(page.locator('[data-nv-component]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  // Recovery is an authoritative reload.
  await page.reload();
  await page.getByRole('button', { name: 'Increment', exact: true }).click();
  await expect(page.locator('#count')).toHaveText('1');
});

test('nv:navigate swaps documents under enforced Trusted Types and returns to a working lab', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => Reflect.set(window, 'nvSameWindow', true));
  await page.getByRole('link', { name: 'About this lab' }).click();
  await expect(page.locator('#about-title')).toBeVisible();
  await expect(page).toHaveURL('http://127.0.0.1:3360/about');
  await page.getByRole('link', { name: 'Back to the lab' }).click();
  await expect(page.locator('#lab-title')).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, 'nvSameWindow'))).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Increment', exact: true }).click();
  await expect(page.locator('#count')).toHaveText('1');
  await noViolations(page);
});

test('accessibility scan of the directive lab has no axe violations', async ({
  page,
}) => {
  await open(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
