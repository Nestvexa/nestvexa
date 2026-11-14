import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { exampleUrl } from './example-url.js';

// Shared by display-accessibility.spec.ts (reflow, every browser) and
// display-forced-colors.chromium.spec.ts (forced colors, Chromium only).

export interface Target {
  readonly name: string;
  /** Signs in when needed and opens the page to audit. */
  readonly open: (page: Page) => Promise<void>;
}

export const starterLive = exampleUrl('starter-live', 3102);
export const admin = exampleUrl('admin-i18n', 3110);
export const showcase = exampleUrl('showcase', 3124);

export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('load');
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

export const targets: readonly Target[] = [
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
