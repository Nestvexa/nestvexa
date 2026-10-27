import { expect, test } from '@playwright/test';
import { holdResponse } from './transport.js';

test.use({ baseURL: 'http://127.0.0.1:3101' });

test('unbound form drafts, keyed choices and file selections survive unrelated live renders', async ({
  page,
}) => {
  await page.goto('/');
  const updates: unknown[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    const body: unknown = request.postDataJSON();
    if (body && typeof body === 'object')
      updates.push(Reflect.get(body, 'updates'));
  });
  await page
    .getByLabel('Local note', { exact: true })
    .fill('private local draft');
  await page
    .getByLabel('Local memo', { exact: true })
    .fill('private local memo');
  await page.getByLabel('Local priority', { exact: true }).selectOption('high');
  await page
    .getByLabel('Local labels', { exact: true })
    .selectOption(['b', 'c']);
  await page.getByLabel('Local flag', { exact: true }).check();
  await page.getByLabel('Tone B', { exact: true }).check();
  await page.getByLabel('Local attachment selection').setInputFiles({
    name: 'draft.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('local test fixture only'),
  });
  await page.getByRole('button', { name: 'Increase', exact: true }).click();
  await expect(page.locator('#count')).toHaveText('1');
  await page.getByRole('button', { name: 'Reorder local options' }).click();
  await expect(page.locator('#native-priority option').first()).toHaveAttribute(
    'value',
    'high',
  );
  await expect(page.getByLabel('Local note', { exact: true })).toHaveValue(
    'private local draft',
  );
  await expect(page.getByLabel('Local memo', { exact: true })).toHaveValue(
    'private local memo',
  );
  await expect(page.getByLabel('Local priority', { exact: true })).toHaveValue(
    'high',
  );
  await expect(page.getByLabel('Local labels', { exact: true })).toHaveValues([
    'b',
    'c',
  ]);
  await expect(page.getByLabel('Local flag', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Tone B', { exact: true })).toBeChecked();
  expect(
    await page
      .getByLabel('Local attachment selection')
      .evaluate((element) => (element as HTMLInputElement).files?.[0]?.name),
  ).toBe('draft.txt');
  expect(updates).toEqual([{}, {}]);
  const state = await page
    .locator('[data-nv-component]')
    .getAttribute('data-nv-state');
  expect(state).not.toContain('private local');
  expect(state).not.toContain('draft.txt');
});

test('changed server defaults are authoritative and native reset uses the new defaults', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Local note', { exact: true }).fill('edited note');
  await page.getByLabel('Local memo', { exact: true }).fill('edited memo');
  await page.getByLabel('Local priority', { exact: true }).selectOption('high');
  await page
    .getByLabel('Local labels', { exact: true })
    .selectOption(['a', 'c']);
  await page.getByRole('button', { name: 'Change server defaults' }).click();
  await expect(page.getByLabel('Local note', { exact: true })).toHaveValue(
    'New server default',
  );
  await expect(page.getByLabel('Local memo', { exact: true })).toHaveValue(
    'New server memo',
  );
  await expect(page.getByLabel('Local priority', { exact: true })).toHaveValue(
    'high',
  );
  await expect(page.getByLabel('Local labels', { exact: true })).toHaveValues([
    'b',
  ]);
  await expect(page.getByLabel('Local flag', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Tone B', { exact: true })).toBeChecked();
  await page.getByLabel('Local memo', { exact: true }).fill('another edit');
  await page.getByLabel('Local note', { exact: true }).fill('another note');
  await page.getByLabel('Local priority', { exact: true }).selectOption('low');
  await page.getByLabel('Local labels', { exact: true }).selectOption(['c']);
  await page.getByLabel('Local flag', { exact: true }).uncheck();
  await page.getByLabel('Tone A', { exact: true }).check();
  await page.getByRole('button', { name: 'Reset local form' }).click();
  await expect(page.getByLabel('Local note', { exact: true })).toHaveValue(
    'New server default',
  );
  await expect(page.getByLabel('Local memo', { exact: true })).toHaveValue(
    'New server memo',
  );
  await expect(page.getByLabel('Local priority', { exact: true })).toHaveValue(
    'high',
  );
  await expect(page.getByLabel('Local labels', { exact: true })).toHaveValues([
    'b',
  ]);
  await expect(page.getByLabel('Local flag', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Tone B', { exact: true })).toBeChecked();
});

test('a new server radio option cannot replace a newer pending model choice', async ({
  page,
}) => {
  await page.goto('/');
  const releaseAction = await holdResponse(
    page,
    '**/counter/enableColorChoice',
  );
  const releaseSync = await holdResponse(page, '**/counter/_sync');
  try {
    await page.getByRole('button', { name: 'Enable green choice' }).click();
    await page.getByLabel('Blue', { exact: true }).check();
    releaseAction();
    await expect(page.getByLabel('Green', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Green', { exact: true })).not.toBeChecked();
    await expect(page.getByLabel('Blue', { exact: true })).toBeChecked();
    await expect(page.locator('[data-nv-component]')).toHaveAttribute(
      'data-nv-revision',
      '1',
    );
  } finally {
    releaseAction();
    releaseSync();
  }
  await expect(page.locator('[data-nv-component]')).toHaveAttribute(
    'data-nv-revision',
    '2',
  );
  await expect(page.locator('#color-server')).toHaveText('blue');
  await expect(page.getByLabel('Blue', { exact: true })).toBeChecked();
});

test('unresolved form references follow native radio grouping across real server renders', async ({
  page,
}) => {
  await page.goto('/');
  const first = page.getByLabel('Unassociated A', { exact: true });
  const second = page.getByLabel('Unassociated B', { exact: true });
  expect(
    await first.evaluate((element) => (element as HTMLInputElement).form),
  ).toBeNull();
  expect(
    await second.evaluate((element) => (element as HTMLInputElement).form),
  ).toBeNull();
  await second.check();
  await page.getByRole('button', { name: 'Increase', exact: true }).click();
  await expect(page.locator('#count')).toHaveText('1');
  await expect(second).toBeChecked();
  await page.getByRole('button', { name: 'Change server defaults' }).click();
  await expect(first).toBeChecked();
  await expect(second).not.toBeChecked();
  await page.getByRole('button', { name: 'Increase', exact: true }).click();
  await expect(page.locator('#count')).toHaveText('2');
  await expect(first).toBeChecked();
});

test('marker invalidation aborts client work and cannot silently dispatch another action', async ({
  page,
}) => {
  await page.goto('/');
  let requests = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST') requests++;
  });
  const release = await holdResponse(page, '**/counter/slow');
  try {
    await page
      .getByRole('button', { name: 'Slow increase', exact: true })
      .click();
    await release.started;
    await page.locator('[data-nv-component]').evaluate((element) => {
      element.setAttribute('data-nv-name', 'tampered');
      const button = element.querySelector<HTMLButtonElement>(
        '[nv\\:click="increment"]',
      );
      if (!button) throw new Error('Missing action fixture');
      button.click();
    });
    await expect(page.locator('#status')).toContainText('marker changed');
  } finally {
    release();
    await release.wait();
  }
  await expect(page.locator('#count')).toHaveText('0');
  await page.getByRole('button', { name: 'Increase', exact: true }).click();
  expect(requests).toBe(1);
});
