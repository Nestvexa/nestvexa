import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { holdResponse } from './transport.js';

test.use({ baseURL: 'http://127.0.0.1:3102' });

declare global {
  interface Window {
    nvEditorSelectionNodes?: readonly [Node, Node];
  }
}

async function start(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('[data-nv-component]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  return errors;
}

async function select(page: Page, mode: string) {
  return page.locator('#local-editor').evaluate((editor, mode) => {
    if (!(editor instanceof HTMLElement)) throw new Error('Missing editor');
    editor.innerHTML = 'Typed 😀 <strong>local draft</strong> tail';
    const first = editor.firstChild;
    const last = editor.querySelector('strong')?.firstChild;
    if (!first || !last) throw new Error('Missing editor points');
    editor.focus();
    const anchor = mode === 'backward' ? last : first;
    const focus = mode === 'caret' ? first : mode === 'backward' ? first : last;
    const anchorOffset = mode === 'backward' ? 7 : 8;
    const focusOffset = mode === 'backward' ? 8 : mode === 'caret' ? 8 : 7;
    document
      .getSelection()
      ?.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
    window.nvEditorSelectionNodes = [anchor, focus];
    return { anchorOffset, focusOffset };
  }, mode);
}

async function points(page: Page) {
  return page.evaluate(() => {
    const selected = document.getSelection();
    return {
      anchor: selected?.anchorNode === window.nvEditorSelectionNodes?.[0],
      focus: selected?.focusNode === window.nvEditorSelectionNodes?.[1],
      anchorOffset: selected?.anchorOffset,
      focusOffset: selected?.focusOffset,
    };
  });
}

async function reorder(page: Page): Promise<void> {
  // Actual keyboard activation keeps the editor focused while the Nest endpoint
  // performs its authorized action and returns the next revision.
  await page
    .getByRole('textbox', { name: 'Local editor', exact: true })
    .press('Control+Enter');
}

for (const mode of ['caret', 'forward', 'backward']) {
  test(`local editor ${mode} survives a real keyed server update without exposing draft HTML`, async ({
    page,
  }) => {
    const errors = await start(page);
    const expected = await select(page, mode);
    const request = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        request.url().endsWith('/counter/reorderEditor'),
    );
    await reorder(page);
    const body: unknown = (await request).postDataJSON();
    expect(body).toMatchObject({ updates: {} });
    expect(JSON.stringify(body)).not.toContain('local draft');
    await expect(page.locator('[data-nv-component]')).toHaveAttribute(
      'data-nv-revision',
      '1',
    );
    await expect(page.locator('#local-editor')).toBeFocused();
    expect(await points(page)).toEqual({
      anchor: true,
      focus: true,
      ...expected,
    });
    await expect(page.locator('#local-editor')).toHaveText(
      'Typed 😀 local draft tail',
    );
    // A second mutation uses the acknowledged revision, with the same local DOM.
    await reorder(page);
    await expect(page.locator('[data-nv-component]')).toHaveAttribute(
      'data-nv-revision',
      '2',
    );
    expect(await points(page)).toEqual({
      anchor: true,
      focus: true,
      ...expected,
    });
    expect(errors).toEqual([]);
  });
}

test('editor selection changed during an in-flight response is sampled at application', async ({
  page,
}) => {
  const errors = await start(page);
  await select(page, 'caret');
  const release = await holdResponse(page, '**/counter/reorderEditor');
  let expected;
  try {
    await reorder(page);
    await release.started;
    expected = await select(page, 'backward');
  } finally {
    release();
    await release.wait();
  }
  await expect(page.locator('[data-nv-component]')).toHaveAttribute(
    'data-nv-revision',
    '1',
  );
  expect(await points(page)).toEqual({
    anchor: true,
    focus: true,
    ...expected,
  });
  expect(errors).toEqual([]);
});

test('editor reconciliation preserves a focus handler selection', async ({
  page,
}) => {
  const errors = await start(page);
  await select(page, 'caret');
  await page.locator('#local-editor').evaluate((editor) => {
    const text = editor.firstChild;
    if (!text) throw new Error('Missing local text');
    editor.addEventListener('focus', () =>
      document.getSelection()?.setBaseAndExtent(text, 1, text, 3),
    );
  });
  await reorder(page);
  await expect(page.locator('[data-nv-component]')).toHaveAttribute(
    'data-nv-revision',
    '1',
  );
  expect(
    await page.evaluate(() => ({
      anchor: document.getSelection()?.anchorOffset,
      focus: document.getSelection()?.focusOffset,
    })),
  ).toEqual({ anchor: 1, focus: 3 });
  expect(errors).toEqual([]);
});

test('editor update leaves focus and selection in an outside editor untouched', async ({
  page,
}) => {
  const errors = await start(page);
  await select(page, 'forward');
  const release = await holdResponse(page, '**/counter/reorderEditor');
  try {
    await reorder(page);
    await release.started;
    await page.evaluate(() => {
      const outside = document.createElement('div');
      outside.contentEditable = 'true';
      outside.id = 'outside-editor';
      outside.textContent = 'Outside editor';
      document.body.append(outside);
      const text = outside.firstChild;
      if (!text) throw new Error('Missing outside text');
      outside.focus();
      document.getSelection()?.setBaseAndExtent(text, 2, text, 7);
    });
  } finally {
    release();
    await release.wait();
  }
  await expect(page.locator('[data-nv-component]')).toHaveAttribute(
    'data-nv-revision',
    '1',
  );
  await expect(page.locator('#outside-editor')).toBeFocused();
  expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(
    'tside',
  );
  expect(errors).toEqual([]);
});

test('editor selection restoration respects a focus handler choosing an outside control', async ({
  page,
}) => {
  const errors = await start(page);
  await select(page, 'forward');
  await page.locator('#local-editor').evaluate((editor) => {
    editor.addEventListener('focus', () =>
      document.querySelector<HTMLAnchorElement>('a[href="/about"]')?.focus(),
    );
  });
  await reorder(page);
  await expect(page.locator('[data-nv-component]')).toHaveAttribute(
    'data-nv-revision',
    '1',
  );
  await expect(
    page.getByRole('link', { name: 'About', exact: true }),
  ).toBeFocused();
  expect(errors).toEqual([]);
});

test('retained editor range restoration does not jump document scroll', async ({
  page,
}) => {
  const errors = await start(page);
  await page.evaluate(() => {
    const spacer = document.createElement('div');
    for (let index = 0; index < 100; index++) {
      const paragraph = document.createElement('p');
      paragraph.textContent = 'Scroll fixture';
      spacer.append(paragraph);
    }
    document.body.prepend(spacer);
    document
      .getElementById('local-editor')
      ?.scrollIntoView({ block: 'center' });
  });
  const expected = await select(page, 'backward');
  const scroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  await reorder(page);
  await expect(page.locator('[data-nv-component]')).toHaveAttribute(
    'data-nv-revision',
    '1',
  );
  expect(await points(page)).toEqual({
    anchor: true,
    focus: true,
    ...expected,
  });
  expect(await page.evaluate(() => ({ x: scrollX, y: scrollY }))).toEqual(
    scroll,
  );
  expect(errors).toEqual([]);
});
