import { expect, test } from '@playwright/test';

test.use({ baseURL: 'http://127.0.0.1:3101' });

test('event once, self, prevent and native ancestor propagation follow the directive contract', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Once increase' }).dblclick();
  await expect(page.locator('#count')).toHaveText('1');
  await page.getByRole('button', { name: 'Once increase' }).click();
  await page.locator('#self-child').click();
  await page.getByRole('button', { name: 'Self increase' }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#count')).toHaveText('2');
  let nativeClicks = 0;
  await page.exposeFunction('recordNativeClick', () => {
    nativeClicks++;
  });
  await page.evaluate(() => {
    const parent = document.getElementById('event-parent');
    if (!parent) throw new Error('Missing event fixture');
    const record: unknown = Reflect.get(window, 'recordNativeClick');
    if (typeof record !== 'function')
      throw new Error('Missing native event observer');
    parent.addEventListener('click', () => {
      void Reflect.apply(record, window, []);
    });
  });
  await page.getByRole('button', { name: 'Stopped increase' }).click();
  await expect(page.locator('#count')).toHaveText('3');
  expect(nativeClicks).toBe(0);
  await page.getByRole('link', { name: 'Prevented navigation' }).click();
  await expect(page.locator('#count')).toHaveText('4');
  await expect(page).toHaveURL('http://127.0.0.1:3101/');
});

test('debounce coalesces and throttle invokes only its leading event', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Debounced increase' }).dblclick();
  await expect(page.locator('#count')).toHaveText('1');
  await page
    .getByRole('button', { name: 'Throttled increase' })
    .evaluate((element) => {
      // Keep both events inside one throttle window despite automation/IPC delays.
      (element as HTMLButtonElement).click();
      (element as HTMLButtonElement).click();
    });
  await expect(page.locator('#count')).toHaveText('2');
  await page.waitForTimeout(550);
  await expect(page.locator('#count')).toHaveText('2');
  await page.getByRole('button', { name: 'Throttled increase' }).click();
  await expect(page.locator('#count')).toHaveText('3');
});

test('keyboard filters require the selected key and system modifier', async ({
  page,
}) => {
  await page.goto('/');
  const keyboard = page.getByLabel('Keyboard action', { exact: true });
  await keyboard.press('Escape');
  await keyboard.press('Enter');
  await expect(page.locator('#count')).toHaveText('1');
  const shortcut = page.getByLabel('Control shortcut');
  await shortcut.press('Enter');
  await shortcut.press('Control+Enter');
  await expect(page.locator('#count')).toHaveText('2');
});

test('a removed debounced node never sends its pending action', async ({
  page,
}) => {
  await page.goto('/');
  let mutations = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST') mutations++;
  });
  await page
    .getByRole('button', { name: 'Debounced increase' })
    .evaluate((element) => {
      // Registered after the Live document listener: remove in the same event turn after scheduling.
      document.addEventListener(
        'click',
        (event) => {
          if (event.target === element) element.remove();
        },
        { once: true },
      );
    });
  await page.getByRole('button', { name: 'Debounced increase' }).click();
  await page.waitForTimeout(180);
  await expect(page.locator('#count')).toHaveText('0');
  expect(mutations).toBe(0);
});
