import { expect, test } from '@playwright/test';
import { exampleUrl } from './example-url.js';

// DX-033 / DX-035 against examples/devtools-tracing: a real browser Live
// client with `tracing: true` and the devtools reporter, a Nest server with
// traceContextMiddleware, the OpenTelemetry SDK bridge and DevtoolsModule.

const base = exampleUrl('devtools-tracing', 4340);
const traceparentPattern = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/;

interface Snapshot {
  readonly actions: readonly {
    readonly name: string;
    readonly traceId?: string;
    readonly attributes: Record<string, unknown>;
  }[];
  readonly browser: {
    readonly network: readonly {
      readonly component: string;
      readonly requests: number;
      readonly requestBytes: number;
      readonly responseBytes: number;
    }[];
    readonly morphs: readonly { readonly component: string; morphs: number }[];
    readonly timings: readonly { readonly traceId?: string }[];
  };
  readonly cache: {
    readonly summary: readonly {
      readonly namespace: string;
      readonly hits: number;
      readonly misses: number;
    }[];
  };
}
interface ExportedSpan {
  readonly name: string;
  readonly traceId: string;
  readonly parentSpanId: string | null;
}

test('the server joins the browser trace and the panel shows browser timing, network batches and cache hits', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const sent: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/_nestvexa/live/meter/bump'))
      sent.push(request.headers()['traceparent'] ?? '');
  });
  await page.goto(base);
  const csrf = await page
    .locator('[data-nv-component]')
    .getAttribute('data-nv-csrf');
  await page.getByRole('button', { name: 'Bump' }).click();
  await expect(page.locator('#count')).toHaveText('1');
  await expect(page.locator('#plan')).toHaveText('Team plan');
  await page.getByRole('button', { name: 'Bump' }).click();
  await expect(page.locator('#count')).toHaveText('2');

  expect(sent).toHaveLength(2);
  for (const header of sent) expect(header).toMatch(traceparentPattern);
  const [traceId, spanId] = (
    traceparentPattern.exec(sent[1] ?? '') ?? []
  ).slice(1);

  // The reporter flushes browser timings about a second after a request.
  let data: Snapshot | undefined;
  await expect
    .poll(
      async () => {
        data = (await (
          await page.request.get(`${base}/_nestvexa/devtools/data.json`)
        ).json()) as Snapshot;
        return data.browser.network[0]?.requests ?? 0;
      },
      { timeout: 10_000 },
    )
    .toBe(2);
  const network = data?.browser.network[0];
  expect(network?.component).toBe('meter');
  expect(network?.requestBytes).toBeGreaterThan(100);
  expect(network?.responseBytes).toBeGreaterThan(100);
  expect(data?.browser.morphs[0]).toMatchObject({
    component: 'meter',
    morphs: 2,
  });
  expect(data?.browser.timings.map((timing) => timing.traceId)).toContain(
    traceId,
  );
  // The Live action span (devtools recorder) carries the browser's trace id.
  expect(
    data?.actions
      .filter((record) => record.name === 'nestvexa.live.action')
      .map((record) => record.traceId),
  ).toContain(traceId);
  expect(data?.cache.summary).toContainEqual(
    expect.objectContaining({
      namespace: 'data:meter-plan',
      hits: 1,
      misses: 1,
    }),
  );

  // The OpenTelemetry SDK span is a child of the browser's span.
  const spans = (await (
    await page.request.get(`${base}/api/traces`)
  ).json()) as ExportedSpan[];
  expect(
    spans.find(
      (span) =>
        span.name === 'nestvexa.live.action' && span.traceId === traceId,
    )?.parentSpanId,
  ).toBe(spanId);

  // The panel is server-rendered, script-free and leaks no credentials.
  const panel = await page.request.get(`${base}/_nestvexa/devtools`);
  const html = await panel.text();
  for (const heading of [
    'Browser morph timing',
    'Network batches',
    'Cache',
    'Recent browser timings',
  ])
    expect(html).toContain(heading);
  expect(html).not.toMatch(/<script/i);
  const everything = html + JSON.stringify(data);
  expect(csrf?.length).toBeGreaterThan(20);
  expect(everything).not.toContain(csrf ?? 'missing-csrf');
  expect(errors).toEqual([]);
});

test('a traceparent never replaces the CSRF token', async ({ page }) => {
  await page.goto(base);
  const root = page.locator('[data-nv-component]');
  const snapshot = await root.getAttribute('data-nv-snapshot');
  const response = await page.request.post(
    `${base}/_nestvexa/live/meter/bump`,
    {
      headers: {
        origin: base,
        'content-type': 'application/json',
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        'x-nestvexa-csrf': 'forged-csrf-token-0123456789012345678901',
      },
      data: {
        protocol: 'nestvexa-live/1',
        requestId: crypto.randomUUID(),
        snapshot,
        revision: 0,
        updates: {},
        input: null,
      },
    },
  );
  expect(response.status()).toBe(403);
  expect(response.headers()['traceparent']).toBeUndefined();
  // Browser reports also need the devtools header; a plain cross-site style
  // form post is refused.
  const report = await page.request.post(`${base}/_nestvexa/devtools/client`, {
    headers: { 'content-type': 'text/plain' },
    data: JSON.stringify({ timings: [] }),
  });
  expect(report.status()).toBe(403);
});
