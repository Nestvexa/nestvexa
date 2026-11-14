import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { wcagAxe } from './axe.js';
import { exampleUrl } from './example-url.js';

// QA-075 display accessibility on the main examples: starter-live, the
// admin example and its UI kit page, and the showcase app.
//
// - Reflow (WCAG 1.4.10): 200% and 400% browser zoom of a 1280 px wide
//   window are 640 and 320 CSS px wide viewports. The page must not scroll
//   horizontally and no text or control may be cut off; wide data tables may
//   scroll inside their own container (the 1.4.10 exception).
// - Forced colors (Windows high contrast): with `forced-colors: active`
//   emulated, the theme's forced-colors rules apply, every keyboard focus
//   stop keeps an outline (box shadows are dropped in this mode), and axe
//   finds no violations against the forced palette.
//
// Screen-reader behaviour is not automated: see
// docs/testing/accessibility-checklist.md (manual, owner-run).

interface Target {
  readonly name: string;
  /** Signs in when needed and opens the page to audit. */
  readonly open: (page: Page) => Promise<void>;
}

const starterLive = exampleUrl('starter-live', 3102);
const admin = exampleUrl('admin-i18n', 3110);
const showcase = exampleUrl('showcase', 3124);

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('load');
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

const targets: readonly Target[] = [
  {
    name: 'starter-live counter',
    open: async (page) => {
      await page.goto(starterLive + '/');
    },
  },
  {
    name: 'starter-live work board',
    open: async (page) => {
      await page.goto(starterLive + '/board');
    },
  },
  {
    name: 'admin dashboard',
    open: async (page) => {
      await page.goto(admin + '/admin');
    },
  },
  {
    name: 'UI kit',
    open: async (page) => {
      await page.goto(admin + '/admin/kit');
      await expect(page.locator('#kit-actions-menu')).toBeHidden();
    },
  },
  {
    name: 'showcase sign-in',
    open: async (page) => {
      await page.goto(showcase + '/login');
    },
  },
  {
    name: 'showcase tasks',
    open: async (page) => {
      await page.goto(showcase + '/login');
      await page.getByLabel('Email').fill('ada@harbor.test');
      await page.getByLabel('Password').fill('showcase-demo-2026');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page.locator('.flash').first()).toContainText(
        'Signed in as',
      );
      await page.goto(showcase + '/app/tasks');
    },
  },
];

interface Overflow {
  readonly scrollWidth: number;
  readonly clientWidth: number;
  /** Visible text or controls that end outside the viewport or are clipped. */
  readonly offenders: readonly string[];
}
/** Horizontal overflow and clipping, measured in the page. */
function measureReflow(page: Page): Promise<Overflow> {
  return page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    const describe = (element: Element) => {
      const id = element.id ? `#${element.id}` : '';
      const classes = [...element.classList].slice(0, 2).join('.');
      const text = (element.textContent ?? '').trim().slice(0, 30);
      return `${element.localName}${id}${classes ? '.' + classes : ''} "${text}"`;
    };
    /** Inside a container that scrolls horizontally by design (data tables). */
    const scrolls = (element: Element) => {
      for (
        let node = element.parentElement;
        node && node !== document.body;
        node = node.parentElement
      ) {
        const style = getComputedStyle(node);
        if (
          ['auto', 'scroll'].includes(style.overflowX) &&
          node.scrollWidth > node.clientWidth
        )
          return true;
      }
      return false;
    };
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none')
        return false;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      // Visually hidden (screen-reader only) text is clipped on purpose.
      if (rect.width <= 1 && rect.height <= 1) return false;
      return !element.closest(
        '[hidden],[aria-hidden="true"],dialog:not([open])',
      );
    };
    const offenders: string[] = [];
    const candidates = document.querySelectorAll(
      'a, button, input, select, textarea, label, h1, h2, h3, p, li, td, th, output, summary',
    );
    for (const element of candidates) {
      if (!visible(element) || scrolls(element)) continue;
      let rect = element.getBoundingClientRect();
      const position = getComputedStyle(element).position;
      // A skip link parked off screen until focused: judge its focused box.
      if (
        (rect.right <= 0 || rect.left >= viewport) &&
        ['absolute', 'fixed'].includes(position) &&
        element instanceof HTMLElement
      ) {
        element.focus();
        rect = element.getBoundingClientRect();
        element.blur();
      }
      if (rect.left < -1 || rect.right > viewport + 1)
        offenders.push(`outside: ${describe(element)}`);
      // Text cut off by its own box (overflow hidden without wrapping).
      const style = getComputedStyle(element);
      if (
        ['hidden', 'clip'].includes(style.overflowX) &&
        element.scrollWidth > element.clientWidth + 1 &&
        style.textOverflow !== 'ellipsis' &&
        element.clientWidth > 1
      )
        offenders.push(`clipped: ${describe(element)}`);
    }
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: viewport,
      offenders,
    };
  });
}

for (const target of targets)
  test.describe(`display accessibility: ${target.name}`, () => {
    test.describe.configure({ timeout: 180_000 });

    for (const [zoom, width, height] of [
      ['200%', 640, 400],
      ['400%', 320, 256],
    ] as const)
      test(`reflows without horizontal scrolling or clipping at ${zoom} zoom (${width} CSS px)`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height });
        await target.open(page);
        await settle(page);
        const result = await measureReflow(page);
        expect(result.offenders).toEqual([]);
        expect(result.scrollWidth).toBeLessThanOrEqual(result.clientWidth);
        // Scrolling the page sideways must not reveal anything.
        await page.evaluate(() => window.scrollTo(400, 0));
        expect(await page.evaluate(() => window.scrollX)).toBe(0);
      });

    test('stays operable and accessible with forced colors (high contrast)', async ({
      page,
      browserName,
    }) => {
      test.skip(
        browserName !== 'chromium',
        'forced-colors emulation is implemented by Chromium only',
      );
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

test('the UI kit theme switches to system colors in forced-colors mode', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'forced-colors emulation is implemented by Chromium only',
  );
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

test('the reflow probe reports overflow and clipping when they exist', async ({
  page,
}) => {
  // Guards the measurement itself: a page that does not reflow must fail.
  await page.setViewportSize({ width: 320, height: 256 });
  await page.goto(starterLive + '/');
  await settle(page);
  await page.evaluate(() => {
    const wide = document.createElement('p');
    wide.id = 'probe-wide';
    wide.textContent = 'A fixed-width paragraph';
    wide.style.width = '900px';
    const clipped = document.createElement('button');
    clipped.id = 'probe-clipped';
    clipped.type = 'button';
    clipped.textContent = 'A label that cannot fit in its box';
    clipped.style.cssText =
      'width:60px;overflow:hidden;white-space:nowrap;display:inline-block';
    document.querySelector('main')?.append(wide, clipped);
  });
  const result = await measureReflow(page);
  expect(result.scrollWidth).toBeGreaterThan(result.clientWidth);
  expect(result.offenders.join('\n')).toContain('outside: p#probe-wide');
  expect(result.offenders.join('\n')).toContain(
    'clipped: button#probe-clipped',
  );
});
