import { afterAll, afterEach, beforeAll, expect } from 'vitest';

/**
 * Process-level guard for server-side failure suites (QA-073): any promise
 * rejection that nothing handles while a test runs fails that test, with the
 * rejection reason in the message. Import it for its side effect at the top
 * of a suite. Vitest also reports such rejections at the end of the run; this
 * guard attributes them to the test that caused them and makes them fatal.
 */
const seen: unknown[] = [];
const record = (reason: unknown): void => {
  seen.push(reason);
};

beforeAll(() => {
  process.on('unhandledRejection', record);
});
afterEach(async () => {
  // Rejections are reported after the microtask queue drains; let callbacks
  // scheduled by the test (timers of zero delay, socket closes) run first.
  await new Promise((resolve) => setImmediate(resolve));
  const reasons = seen.splice(0);
  expect(
    reasons.map((reason) =>
      reason instanceof Error
        ? `${reason.name}: ${reason.message}`
        : String(reason),
    ),
    'unhandled promise rejections during the test',
  ).toEqual([]);
});
afterAll(() => {
  process.off('unhandledRejection', record);
});
