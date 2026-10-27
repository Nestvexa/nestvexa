import type { Page } from '@playwright/test';

export interface HeldResponse {
  (): void;
  readonly started: Promise<void>;
  wait(): Promise<void>;
}

/** Holds delivery of an actual server response so in-flight assertions do not race IPC delays. */
export async function holdResponse(
  page: Page,
  pattern: string,
): Promise<HeldResponse> {
  let release = () => {};
  let started = () => {};
  let finished = () => {};
  let failed: (error: Error) => void = () => {};
  const begin = new Promise<void>((resolve) => {
    started = resolve;
  });
  const completion = new Promise<void>((resolve, reject) => {
    finished = resolve;
    failed = reject;
  });
  // The route callback still throws failures; this prevents a second unhandled diagnostic.
  void completion.catch(() => undefined);
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    pattern,
    async (route) => {
      started();
      try {
        const response = await route.fetch();
        await gate;
        if (route.request().failure() === null)
          await route.fulfill({ response });
        finished();
      } catch (error) {
        // Playwright appends cookie/CSRF request headers to its call log; keep the cause line only.
        const safe = new Error(
          error instanceof Error
            ? error.message.split('\n')[0]
            : 'Live test response transport failed',
        );
        failed(safe);
        throw safe;
      }
    },
    { times: 1 },
  );
  return Object.assign(release, { started: begin, wait: () => completion });
}
