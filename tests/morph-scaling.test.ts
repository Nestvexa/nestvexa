/**
 * Morph scaling on large tables and forms (QA-010). Every scenario runs the
 * built `morphChildren` (`packages/client/dist/morph.js`) in a real browser
 * against 1,000 and 5,000 rows and checks:
 *
 * - correctness: the patched DOM equals the server fragment and keyed rows
 *   keep their identity;
 * - complexity: the median morph time grows near linearly. Five times more
 *   rows must cost less than 12.5 times more (2.5x headroom over linear for
 *   timer noise and GC); a quadratic common path would cost about 25 times
 *   more and fail.
 *
 * The timings are evidence of shape, not a promise of milliseconds on any
 * host. Chromium by default; `NV_FUZZ_BROWSERS` selects more engines, as for
 * the client fuzz suite.
 */
import { chromium, firefox, webkit } from '@playwright/test';
import type { Browser, BrowserType, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFile } from 'node:fs/promises';

interface ScenarioResult {
  readonly rows: number;
  readonly medianMs: number;
  readonly equal: boolean;
  readonly keptIdentity: boolean;
  readonly mutations: number;
}
declare global {
  interface Window {
    nvMorph: {
      morphChildren(
        parent: Element,
        incoming: DocumentFragment,
        dirty: ReadonlyMap<string, unknown>,
      ): void;
    };
  }
}

const engines: Readonly<Record<string, BrowserType>> = {
  chromium,
  firefox,
  webkit,
};
const selected = (process.env['NV_FUZZ_BROWSERS'] ?? 'chromium')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
for (const name of selected)
  if (!Object.hasOwn(engines, name))
    throw new Error(`Unknown NV_FUZZ_BROWSERS entry: ${name}`);

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><html lang="en"><title>Morph scaling fixture</title><script type="module">import * as morph from "/morph.js"; window.nvMorph = morph;</script><body><main></main></body></html>',
      );
      return;
    }
    // Test-only static server for built client modules; nothing else is served.
    if (!/^\/[a-z-]+\.js$/.test(pathname)) {
      response.writeHead(404).end();
      return;
    }
    void readFile(
      new URL(`../packages/client/dist${pathname}`, import.meta.url),
      'utf8',
    ).then(
      (source) => {
        response.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
        });
        response.end(source);
      },
      () => {
        response.writeHead(404).end();
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing morph fixture port');
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});

type Scenario =
  | 'table-update'
  | 'table-reverse'
  | 'table-churn'
  | 'table-checkboxes'
  | 'list-prepend'
  | 'form-values';

/**
 * Builds the current and the incoming markup in the page, morphs a fresh copy
 * `runs` times and reports the median. Each run starts from the same current
 * DOM, so runs are independent.
 */
function measure(
  page: Page,
  scenario: Scenario,
  rows: number,
  runs: number,
): Promise<ScenarioResult> {
  return page.evaluate(
    ({ scenario, rows, runs }) => {
      const cells = (index: number, version: number) =>
        `<td>${index}</td><td>Item ${index} v${version}</td><td>${(index * 7) % 101}</td><td>${version ? 'open' : 'closed'}</td>`;
      const row = (index: number, version: number, keyed = true) =>
        `<tr${keyed ? ` data-nv-key="r${index}"` : ''}>${cells(index, version)}</tr>`;
      const range = (count: number) =>
        Array.from({ length: count }, (_, index) => index);
      let before = '';
      let after = '';
      let tag = 'tbody';
      switch (scenario) {
        case 'table-update':
          before = range(rows)
            .map((index) => row(index, 0))
            .join('');
          after = range(rows)
            .map((index) => row(index, 1))
            .join('');
          break;
        case 'table-reverse':
          before = range(rows)
            .map((index) => row(index, 0))
            .join('');
          after = range(rows)
            .reverse()
            .map((index) => row(index, 0))
            .join('');
          break;
        case 'table-churn':
          // Every tenth row is removed and as many new rows are inserted.
          before = range(rows)
            .map((index) => row(index, 0))
            .join('');
          after = range(rows)
            .map((index) =>
              index % 10 === 0 ? row(rows + index, 1) : row(index, 0),
            )
            .join('');
          break;
        case 'table-checkboxes':
          // An unnamed selection checkbox per keyed row, as in admin tables.
          before = range(rows)
            .map(
              (index) =>
                `<tr data-nv-key="r${index}"><td><input type="checkbox" aria-label="Select ${index}"></td>${cells(index, 0)}</tr>`,
            )
            .join('');
          after = range(rows)
            .map(
              (index) =>
                `<tr data-nv-key="r${index}"><td><input type="checkbox" aria-label="Select ${index}"${index % 2 ? ' checked' : ''}></td>${cells(index, 1)}</tr>`,
            )
            .join('');
          break;
        case 'list-prepend':
          // Unkeyed rows pair by position: one new first row shifts every row.
          tag = 'ul';
          before = range(rows)
            .map((index) => `<li>Entry ${index}</li>`)
            .join('');
          after =
            '<li>Entry new</li>' +
            range(rows)
              .map((index) => `<li>Entry ${index}</li>`)
              .join('');
          break;
        case 'form-values':
          // A large form: one labelled named input per row inside one form.
          tag = 'form';
          before = range(rows)
            .map(
              (index) =>
                `<p><label for="f${index}">Field ${index}</label><input id="f${index}" name="f${index}" value="a${index}"></p>`,
            )
            .join('');
          after = range(rows)
            .map(
              (index) =>
                `<p><label for="f${index}">Field ${index}</label><input id="f${index}" name="f${index}" value="b${index}"></p>`,
            )
            .join('');
          break;
      }
      const main = document.querySelector('main');
      if (!main) throw new Error('Missing fixture root');
      const template = document.createElement('template');
      template.innerHTML =
        tag === 'tbody'
          ? `<table><tbody>${after}</tbody></table>`
          : `<${tag}>${after}</${tag}>`;
      const incomingRoot = template.content.querySelector(tag);
      if (!incomingRoot) throw new Error('Missing incoming root');
      const samples: number[] = [];
      let equal = true;
      let keptIdentity = true;
      let mutations = 0;
      for (let run = 0; run < runs + 1; run++) {
        main.innerHTML =
          tag === 'tbody'
            ? `<table><tbody>${before}</tbody></table>`
            : `<${tag}>${before}</${tag}>`;
        const parent = main.querySelector(tag);
        if (!parent) throw new Error('Missing current root');
        const firstKeyed = parent.querySelector('[data-nv-key="r1"]');
        const incoming = document.createDocumentFragment();
        for (const child of incomingRoot.childNodes)
          incoming.append(child.cloneNode(true));
        const observer = new MutationObserver(() => undefined);
        observer.observe(parent, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        const start = performance.now();
        window.nvMorph.morphChildren(parent, incoming, new Map());
        const elapsed = performance.now() - start;
        const records = observer.takeRecords().length;
        observer.disconnect();
        // The first run warms the JIT and is not counted.
        if (run > 0) samples.push(elapsed);
        mutations = records;
        if (parent.innerHTML !== incomingRoot.innerHTML) equal = false;
        if (
          firstKeyed &&
          firstKeyed !== parent.querySelector('[data-nv-key="r1"]')
        )
          keptIdentity = false;
      }
      samples.sort((left, right) => left - right);
      return {
        rows,
        medianMs: samples[Math.floor(samples.length / 2)] ?? 0,
        equal,
        keptIdentity,
        mutations,
      };
    },
    { scenario, rows, runs },
  );
}

const scenarios: readonly Scenario[] = [
  'table-update',
  'table-reverse',
  'table-churn',
  'table-checkboxes',
  'list-prepend',
  'form-values',
];
const small = 1_000;
const large = 5_000;
/** Five times the rows may cost at most this many times the time. */
const maxGrowth = 12.5;
/** Medians below this are dominated by timer resolution, not by the algorithm. */
const resolutionMs = 2;

describe.each(selected)('morph scaling in %s', (name) => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    const engine = engines[name];
    if (!engine) throw new Error(`Unknown browser ${name}`);
    browser = await engine.launch();
    page = await browser.newPage();
    await page.goto(base, { timeout: 120_000 });
    await page.waitForFunction(() => 'nvMorph' in window);
  });
  afterAll(async () => {
    await browser?.close();
  });

  it.each(scenarios)(
    '%s stays correct and near linear from 1,000 to 5,000 rows',
    async (scenario) => {
      const lower = await measure(page, scenario, small, 5);
      const upper = await measure(page, scenario, large, 5);
      for (const result of [lower, upper]) {
        expect(result.equal).toBe(true);
        expect(result.keptIdentity).toBe(true);
        expect(result.mutations).toBeGreaterThan(0);
      }
      const growth = upper.medianMs / Math.max(lower.medianMs, resolutionMs);
      expect(
        growth,
        `${scenario}: ${lower.medianMs.toFixed(2)} ms at ${small} rows, ${upper.medianMs.toFixed(2)} ms at ${large} rows`,
      ).toBeLessThan(maxGrowth);
    },
    120_000,
  );

  it('a second identical morph of 5,000 keyed rows changes nothing', async () => {
    const records = await page.evaluate((rows) => {
      const main = document.querySelector('main');
      if (!main) throw new Error('Missing fixture root');
      const markup = Array.from(
        { length: rows },
        (_, index) =>
          `<tr data-nv-key="r${index}"><td>${index}</td><td><input type="checkbox" aria-label="Select ${index}"></td></tr>`,
      ).join('');
      main.innerHTML = `<table><tbody>${markup}</tbody></table>`;
      const parent = main.querySelector('tbody');
      const template = document.createElement('template');
      template.innerHTML = markup;
      if (!parent) throw new Error('Missing current root');
      const observer = new MutationObserver(() => undefined);
      observer.observe(parent, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      window.nvMorph.morphChildren(parent, template.content, new Map());
      const count = observer.takeRecords().length;
      observer.disconnect();
      return count;
    }, large);
    expect(records).toBe(0);
  });
});
