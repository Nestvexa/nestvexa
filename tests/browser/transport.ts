import type { Page } from '@playwright/test';

/** Holds delivery of an actual server response so in-flight assertions do not race IPC delays. */
export async function holdResponse(
  page: Page,
  pattern: string,
): Promise<() => void> {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    pattern,
    async (route) => {
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  return release;
}
