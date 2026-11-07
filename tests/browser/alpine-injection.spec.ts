import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { exampleUrl } from './example-url.js';

// SEC-022: Alpine expression and directive injection. examples/live-counter
// runs the CSP build of Alpine next to Live, under `script-src 'self'`. The CSP
// build has no eval, but it does evaluate its own expression grammar, so
// `$live.call('increment')` in any x-* or @ attribute would run. The display
// name is user data: it is sent to the server, rendered by Handlebars into a
// text node, an attribute value and an input value, morphed into the page,
// and bound with nv:text / nv:bind. None of that may ever create an Alpine or
// Live directive, and the server count proves no injected call ran.

test.use({ baseURL: exampleUrl('LIVE_COUNTER', 3101) });

const payloads = [
  `" x-data x-init="$live.call('increment')" title="`,
  `' x-init='$live.call("increment")' '`,
  `<div x-data x-init="$live.call('increment')"></div>`,
  `<template x-if="true"><i x-init="$live.call('increment')"></i></template>`,
  `<b x-data @click="$live.call('increment')">click</b>`,
  `<button nv:click="increment" type="button">nv</button>`,
  `x-on:click="$live.call('increment')"`,
  `$live.call('increment')`,
  `{{count}} {{{name}}} {{> counter}}`,
];

/** Every directive-like attribute in the document, as `tag#id[name]` counts. */
async function directives(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const counts: Record<string, number> = {};
    for (const element of document.querySelectorAll('*'))
      for (const { name } of element.attributes)
        if (/^(?:x-|@|:|nv:|on)/i.test(name)) {
          const key = `${element.tagName.toLowerCase()}[${name}]`;
          counts[key] = (counts[key] ?? 0) + 1;
        }
    return counts;
  });
}

test('server-rendered user data never becomes an Alpine or Live directive', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const target = window as unknown as { __cspViolations: string[] };
    target.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) =>
      target.__cspViolations.push(`${event.violatedDirective}`),
    );
  });
  await page.goto('/');
  // Alpine has started and reads Live state through $live.
  await expect(page.locator('#alpine-server')).toHaveText('0');
  const baseline = await directives(page);
  const field = page.getByLabel('Display name', { exact: true });
  for (const payload of payloads) {
    await field.fill(payload);
    await field.press('Enter');
    // The server rendered the payload (Handlebars) and the client morphed it.
    await expect(page.locator('#saved')).toHaveText(payload);
    await expect(page.locator('#name-preview')).toHaveText(payload);
    await expect(page.locator('#name-preview')).toHaveAttribute(
      'title',
      payload,
    );
    await expect(field).toHaveValue(payload);
    for (const id of ['#saved', '#name-preview'])
      expect(
        await page.locator(id).evaluate((node) => node.children.length),
      ).toBe(0);
    // Give Alpine's mutation observer a chance to initialize anything new,
    // then prove nothing was: no new directive, no injected call.
    await page.locator('#alpine-widget button').first().hover();
    await page.locator('#saved').hover();
    await page.locator('#saved').click();
    await page.locator('#name-preview').click();
    expect(await directives(page)).toEqual(baseline);
    await expect(page.locator('#count')).toHaveText('0');
    await expect(page.locator('#alpine-server')).toHaveText('0');
  }
  // Control: Alpine is live after every morph (local state and $live calls).
  await page.getByRole('button', { name: 'Local Alpine click' }).click();
  await expect(page.locator('#alpine-local')).toHaveText('1');
  await page.getByRole('button', { name: 'Alpine server increment' }).click();
  await expect(page.locator('#count')).toHaveText('1');
  await expect(page.locator('#alpine-server')).toHaveText('1');
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __cspViolations: string[] }).__cspViolations,
    ),
  ).toEqual([]);
  expect(errors).toEqual([]);
});
