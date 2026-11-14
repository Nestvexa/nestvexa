import { expect, test } from '@playwright/test';
import { wcagAxe } from './axe.js';
import { admin, settle, targets } from './display-accessibility-support.js';

// Forced colors (Windows high contrast): with `forced-colors: active`
// emulated, the theme's forced-colors rules apply, every keyboard focus stop
// keeps an outline (box shadows are dropped in this mode), and axe finds no
// violations against the forced palette. Only Chromium implements the
// emulation; the `*.chromium.spec.ts` suffix keeps this file out of the
// Firefox and WebKit projects instead of reporting skipped tests.

for (const target of targets)
  test.describe(`display accessibility (forced colors): ${target.name}`, () => {
    test.describe.configure({ timeout: 180_000 });

    test('stays operable and accessible with forced colors (high contrast)', async ({
      page,
    }) => {
      await page.emulateMedia({ forcedColors: 'active' });
      await target.open(page);
      await settle(page);
      expect(
        await page.evaluate(
          () => window.matchMedia('(forced-colors: active)').matches,
        ),
      ).toBe(true);
      // Every keyboard focus stop shows an outline: box-shadow focus rings
      // disappear in forced colors, outlines do not.
      const stops: { element: string; outline: string }[] = [];
      for (let index = 0; index < 12; index++) {
        await page.keyboard.press('Tab');
        const stop = await page.evaluate(() => {
          const element = document.activeElement;
          if (!element || element === document.body) return null;
          const style = getComputedStyle(element);
          return {
            element: `${element.localName}${element.id ? '#' + element.id : ''} "${(element.textContent ?? '').trim().slice(0, 24)}"`,
            outline:
              style.outlineStyle !== 'none' &&
              parseFloat(style.outlineWidth) >= 1
                ? 'visible'
                : `${style.outlineStyle} ${style.outlineWidth}`,
          };
        });
        if (stop) stops.push(stop);
      }
      expect(stops.length).toBeGreaterThan(0);
      expect(stops.filter((stop) => stop.outline !== 'visible')).toEqual([]);
      // Contrast and the other rules hold against the forced palette.
      expect((await wcagAxe(page).analyze()).violations).toEqual([]);
    });
  });

test.describe('display accessibility (forced colors): UI kit theme', () => {
  test('the UI kit theme switches to system colors in forced-colors mode', async ({
    page,
  }) => {
    await page.goto(admin + '/admin/kit');
    await expect(page.locator('#kit-actions-menu')).toBeHidden();
    const alert = page.locator('.nv-alert').first();
    await expect(alert).toBeVisible();
    const normal = await alert.evaluate(
      (element) => getComputedStyle(element).borderInlineStartColor,
    );
    await page.emulateMedia({ forcedColors: 'active' });
    // The theme's forced-colors block maps the alert accent to CanvasText,
    // which is the page text color in this mode.
    const forced = await alert.evaluate((element) => ({
      border: getComputedStyle(element).borderInlineStartColor,
      text: getComputedStyle(document.body).color,
    }));
    expect(forced.border).toBe(forced.text);
    expect(forced.border).not.toBe(normal);
  });
});
