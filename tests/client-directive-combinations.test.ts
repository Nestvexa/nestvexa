/**
 * Table-driven directive combination matrix in real Chromium, Firefox and WebKit. Every row
 * mounts the canonical bundled client against an in-page fake Live server
 * (tests/support/live-matrix.ts), performs real Playwright input and asserts
 * requests, DOM, ARIA and errors. Rows combine modifiers on one element and
 * directives sharing a component.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from '@playwright/test';
import {
  expectActions,
  matrixBrowsers,
  mountMatrix,
  openPage,
  releaseAll,
  snapshot,
  startMatrix,
} from './support/live-matrix.js';
import type { MatrixComponent, MatrixFixture } from './support/live-matrix.js';

type Modifier = 'Control' | 'Shift' | 'Alt' | 'Meta';
type Step =
  | { readonly click: string; readonly modifiers?: readonly Modifier[] }
  | { readonly forceClick: string }
  /** Synchronous element.click() bursts inside one browser task. */
  | { readonly burst: string; readonly count: number }
  | { readonly fill: string; readonly value: string }
  | { readonly type: string; readonly text: string }
  | { readonly press: string; readonly key: string }
  | { readonly keyboard: string }
  | { readonly focus: string }
  | { readonly blur: string }
  | { readonly select: string; readonly value: string | readonly string[] }
  | { readonly check: string }
  /** Native pointer drag from one element onto the top or bottom half of another. */
  | {
      readonly drag: string;
      readonly to: string;
      readonly half: 'top' | 'bottom';
    }
  | { readonly wait: number }
  | { readonly release: 'next' | 'all' }
  /** Trusted test instrumentation evaluated in the page (never by the client). */
  | { readonly run: string }
  | { readonly expect: Expectation };
interface Expectation {
  /** Exact ordered action names received by the fake server. */
  readonly actions?: readonly string[];
  /** Per-request `updates` payloads, in order. */
  readonly updates?: readonly Readonly<Record<string, unknown>>[];
  /** Per-request action `input` payloads, in order. */
  readonly inputs?: readonly unknown[];
  readonly text?: Readonly<Record<string, string>>;
  readonly attrs?: Readonly<
    Record<string, Readonly<Record<string, string | null>>>
  >;
  /** Exact error codes reported through onError. */
  readonly errors?: readonly string[];
  /** Events that must have been observed at least once. */
  readonly events?: readonly string[];
  /** Page expressions and their expected JSON-comparable values. */
  readonly values?: Readonly<Record<string, unknown>>;
}
interface Row extends MatrixComponent {
  readonly name: string;
  readonly steps: readonly Step[];
}

let fixture: MatrixFixture | undefined;
let page: Page | undefined;

async function verify(target: Page, expected: Expectation): Promise<void> {
  const options = { timeout: 5000 };
  if (expected.actions) await expectActions(target, expected.actions);
  if (expected.inputs)
    await expect
      .poll(
        async () =>
          (await snapshot(target)).requests.map((request) => request.input),
        options,
      )
      .toEqual(expected.inputs);
  if (expected.updates)
    await expect
      .poll(
        async () =>
          (await snapshot(target)).requests.map((request) => request.updates),
        options,
      )
      .toEqual(expected.updates);
  for (const [selector, text] of Object.entries(expected.text ?? {}))
    await expect
      .poll(
        () =>
          target.evaluate(
            (query) => document.querySelector(query)?.textContent?.trim(),
            selector,
          ),
        options,
      )
      .toBe(text);
  for (const [selector, attributes] of Object.entries(expected.attrs ?? {}))
    await expect
      .poll(
        () =>
          target.evaluate(
            ({ query, names }) => {
              const element = document.querySelector(query);
              return Object.fromEntries(
                names.map((name) => [
                  name,
                  element ? element.getAttribute(name) : 'missing',
                ]),
              );
            },
            { query: selector, names: Object.keys(attributes) },
          ),
        options,
      )
      .toEqual(attributes);
  if (expected.errors)
    await expect
      .poll(async () => (await snapshot(target)).errors, options)
      .toEqual(expected.errors);
  if (expected.events)
    await expect
      .poll(async () => (await snapshot(target)).events, options)
      .toEqual(expect.arrayContaining([...expected.events]));
  for (const [expression, value] of Object.entries(expected.values ?? {}))
    await expect
      .poll(() => target.evaluate(expression), options)
      .toEqual(value);
}

async function run(row: Row): Promise<void> {
  if (!fixture) throw new Error('Matrix fixture is not running');
  page = await openPage(fixture);
  const target = page;
  await mountMatrix(target, row);
  for (const step of row.steps) {
    if ('click' in step)
      await target.click(step.click, {
        modifiers: step.modifiers ? [...step.modifiers] : [],
      });
    else if ('forceClick' in step)
      await target.click(step.forceClick, { force: true });
    else if ('burst' in step)
      await target.evaluate(
        ({ selector, count }) => {
          const element = document.querySelector(selector);
          if (!(element instanceof HTMLElement))
            throw new Error(`Missing ${selector}`);
          for (let index = 0; index < count; index++) element.click();
        },
        { selector: step.burst, count: step.count },
      );
    else if ('fill' in step) await target.fill(step.fill, step.value);
    else if ('type' in step)
      await target.locator(step.type).pressSequentially(step.text);
    else if ('press' in step) await target.press(step.press, step.key);
    else if ('keyboard' in step) await target.keyboard.press(step.keyboard);
    else if ('focus' in step) await target.focus(step.focus);
    else if ('blur' in step)
      await target.locator(step.blur).evaluate((element) => {
        if (element instanceof HTMLElement) element.blur();
      });
    else if ('select' in step)
      await target.selectOption(
        step.select,
        typeof step.value === 'string' ? step.value : [...step.value],
      );
    else if ('check' in step) await target.check(step.check);
    else if ('drag' in step) {
      const box = await target.locator(step.to).boundingBox();
      if (!box) throw new Error(`Missing drop target ${step.to}`);
      await target.locator(step.drag).dragTo(target.locator(step.to), {
        targetPosition: {
          x: box.width / 2,
          y: step.half === 'top' ? 4 : box.height - 4,
        },
      });
    } else if ('wait' in step) await target.waitForTimeout(step.wait);
    else if ('release' in step) {
      if (step.release === 'all') await releaseAll(target);
      else {
        await expect
          .poll(async () => (await snapshot(target)).pending, {
            timeout: 5000,
          })
          .toBeGreaterThan(0);
        await target.evaluate(() => window.nvHarness.release(0));
      }
    } else if ('run' in step) await target.evaluate(step.run);
    else await verify(target, step.expect);
  }
}

const counter = {
  state: { count: 0 },
  actions: { increment: { increment: 'count' } },
} as const;
const output = '<output id="count">{{count}}</output>';

const eventRows: Row[] = [
  {
    name: 'nv:click invokes one registered action per click',
    ...counter,
    html: `${output}<button id="go" type="button" nv:click="increment">Go</button>`,
    steps: [
      { click: '#go' },
      { click: '#go' },
      {
        expect: {
          actions: ['increment', 'increment'],
          text: { '#count': '2' },
        },
      },
    ],
  },
  {
    name: 'nv:click ignores disabled controls',
    ...counter,
    html: `${output}<button id="go" type="button" disabled nv:click="increment">Go</button>`,
    steps: [{ forceClick: '#go' }, { wait: 150 }, { expect: { actions: [] } }],
  },
  {
    name: 'nv:click ignores clicks inside a disabled fieldset',
    ...counter,
    html: `${output}<fieldset disabled><button id="go" type="button" nv:click="increment">Go</button></fieldset>`,
    steps: [{ forceClick: '#go' }, { wait: 150 }, { expect: { actions: [] } }],
  },
  {
    name: 'keyboard activation of a button (Enter and Space) is a click',
    ...counter,
    html: `${output}<button id="go" type="button" nv:click="increment">Go</button>`,
    steps: [
      { press: '#go', key: 'Enter' },
      { press: '#go', key: ' ' },
      { expect: { actions: ['increment', 'increment'] } },
    ],
  },
  {
    name: 'nv:click.prevent blocks link navigation and still invokes',
    ...counter,
    html: `${output}<a id="go" href="#elsewhere" nv:click.prevent="increment">Go</a>`,
    steps: [
      { click: '#go' },
      { expect: { actions: ['increment'], values: { 'location.hash': '' } } },
    ],
  },
  {
    name: 'nv:click without .prevent leaves the link default intact',
    ...counter,
    html: `${output}<a id="go" href="#elsewhere" nv:click="increment">Go</a>`,
    steps: [
      { click: '#go' },
      {
        expect: {
          actions: ['increment'],
          values: { 'location.hash': '#elsewhere' },
        },
      },
    ],
  },
  {
    name: 'nv:click.stop stops native ancestor listeners',
    ...counter,
    html: `${output}<div id="parent"><button id="go" type="button" nv:click.stop="increment">Go</button></div>`,
    steps: [
      {
        run: "window.nvParent = 0; document.getElementById('parent').addEventListener('click', () => window.nvParent++)",
      },
      { click: '#go' },
      { expect: { actions: ['increment'], values: { 'window.nvParent': 0 } } },
    ],
  },
  {
    name: 'nv:click.self ignores events from descendants',
    ...counter,
    html: `${output}<button id="go" type="button" nv:click.self="increment"><span id="child">Child</span></button>`,
    steps: [
      { click: '#child' },
      { wait: 150 },
      { expect: { actions: [] } },
      { burst: '#go', count: 1 },
      { expect: { actions: ['increment'] } },
    ],
  },
  {
    name: 'nv:click.once invokes once per element configuration',
    ...counter,
    html: `${output}<button id="go" type="button" nv:click.once="increment">Go</button>`,
    steps: [
      { click: '#go' },
      { click: '#go' },
      { click: '#go' },
      { wait: 150 },
      { expect: { actions: ['increment'] } },
    ],
  },
  {
    name: 'nv:click.debounce.120ms coalesces a burst into one trailing call',
    ...counter,
    html: `${output}<button id="go" type="button" nv:click.debounce.120ms="increment">Go</button>`,
    steps: [
      { burst: '#go', count: 4 },
      { expect: { actions: [] } },
      { wait: 300 },
      { expect: { actions: ['increment'] } },
    ],
  },
  {
    name: 'nv:click.throttle.400ms keeps only the leading call',
    ...counter,
    html: `${output}<button id="go" type="button" nv:click.throttle.400ms="increment">Go</button>`,
    steps: [
      { burst: '#go', count: 4 },
      { wait: 500 },
      { expect: { actions: ['increment'] } },
      { burst: '#go', count: 2 },
      { expect: { actions: ['increment', 'increment'] } },
    ],
  },
  {
    name: 'nv:click.once.debounce reschedules until the single call fires',
    ...counter,
    html: `${output}<button id="go" type="button" nv:click.once.debounce.80ms="increment">Go</button>`,
    steps: [
      { burst: '#go', count: 3 },
      { wait: 250 },
      { click: '#go' },
      { wait: 250 },
      { expect: { actions: ['increment'] } },
    ],
  },
  {
    name: 'nv:click.ctrl requires the control key; extra keys are allowed',
    ...counter,
    html: `${output}<button id="go" type="button" nv:click.ctrl="increment">Go</button>`,
    steps: [
      { click: '#go' },
      { click: '#go', modifiers: ['Shift'] },
      { wait: 150 },
      { expect: { actions: [] } },
      { click: '#go', modifiers: ['Control'] },
      { click: '#go', modifiers: ['Control', 'Shift'] },
      { expect: { actions: ['increment', 'increment'] } },
    ],
  },
  {
    name: 'nv:click.alt.meta requires both system keys',
    ...counter,
    html: `${output}<button id="go" type="button" nv:click.alt.meta="increment">Go</button>`,
    steps: [
      { click: '#go', modifiers: ['Alt'] },
      { wait: 150 },
      { expect: { actions: [] } },
      { click: '#go', modifiers: ['Alt', 'Meta'] },
      { expect: { actions: ['increment'] } },
    ],
  },
  {
    name: 'nv:click.prevent.stop.self combine their filters before effects',
    ...counter,
    html: `${output}<div id="parent"><a id="go" href="#moved" nv:click.prevent.stop.self="increment"><span id="child">Child</span> link</a></div>`,
    steps: [
      {
        run: "window.nvParent = 0; document.getElementById('parent').addEventListener('click', () => window.nvParent++)",
      },
      { click: '#child' },
      { wait: 150 },
      {
        expect: {
          actions: [],
          values: { 'location.hash': '#moved', 'window.nvParent': 1 },
        },
      },
      { run: "history.replaceState(null, '', location.pathname)" },
      { burst: '#go', count: 1 },
      {
        expect: {
          actions: ['increment'],
          values: { 'location.hash': '', 'window.nvParent': 1 },
        },
      },
    ],
  },
  {
    name: 'nv:keydown.enter fires only for Enter',
    ...counter,
    html: `${output}<input id="field" aria-label="Field" nv:keydown.enter="increment">`,
    steps: [
      { press: '#field', key: 'a' },
      { press: '#field', key: 'Escape' },
      { wait: 150 },
      { expect: { actions: [] } },
      { press: '#field', key: 'Enter' },
      { expect: { actions: ['increment'] } },
    ],
  },
  {
    name: 'nv:keydown.shift.enter requires shift',
    ...counter,
    html: `${output}<textarea id="field" aria-label="Field" nv:keydown.shift.enter.prevent="increment"></textarea>`,
    steps: [
      { press: '#field', key: 'Shift+Enter' },
      {
        expect: {
          actions: ['increment'],
          values: { "document.getElementById('field').value": '' },
        },
      },
      { press: '#field', key: 'Enter' },
      { wait: 150 },
      {
        expect: {
          actions: ['increment'],
          values: { "document.getElementById('field').value": '\n' },
        },
      },
    ],
  },
  ...(
    [
      ['escape', 'Escape'],
      ['space', ' '],
      ['tab', 'Tab'],
      ['arrow-up', 'ArrowUp'],
      ['arrow-down', 'ArrowDown'],
    ] as const
  ).map(([modifier, key]): Row => ({
    name: `nv:keydown.${modifier}.prevent selects ${JSON.stringify(key)}`,
    ...counter,
    html: `${output}<input id="field" aria-label="Field" nv:keydown.${modifier}.prevent="increment"><button id="next" type="button">Next</button>`,
    steps: [
      { press: '#field', key: 'Enter' },
      { press: '#field', key },
      {
        expect: {
          actions: ['increment'],
          // .prevent keeps focus in the field for Tab and blocks typing a space.
          values: {
            "document.activeElement?.id + ':' + document.getElementById('field').value":
              'field:',
          },
        },
      },
    ],
  })),
  {
    name: 'nv:keydown.window.escape listens globally while its element is owned',
    ...counter,
    html: `${output}<button id="close" type="button" nv:keydown.window.escape="increment">Close</button><input id="elsewhere" aria-label="Elsewhere">`,
    steps: [
      { focus: '#elsewhere' },
      { keyboard: 'Escape' },
      { run: 'document.activeElement.blur()' },
      { keyboard: 'Escape' },
      { keyboard: 'Enter' },
      { expect: { actions: ['increment', 'increment'] } },
    ],
  },
  {
    name: 'window/document scopes ignore untrusted synthetic events',
    ...counter,
    html: `${output}<button id="close" type="button" nv:keydown.document.escape="increment">Close</button>`,
    steps: [
      {
        run: "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))",
      },
      { wait: 150 },
      { expect: { actions: [] } },
      { keyboard: 'Escape' },
      { expect: { actions: ['increment'] } },
    ],
  },
  {
    name: 'nv:click.document fires for clicks outside its element and honors .once',
    ...counter,
    html: `${output}<div id="panel" nv:click.document.once="increment">Panel</div><button id="outside" type="button">Outside</button>`,
    steps: [
      { click: '#outside' },
      { click: '#outside' },
      { wait: 150 },
      { expect: { actions: ['increment'] } },
    ],
  },
  {
    name: 'scoped bindings are released when server markup removes the element',
    state: { count: 0, open: true },
    actions: { close: { toggle: 'open' }, increment: { increment: 'count' } },
    html: `${output}{{#open}}<button id="close" type="button" nv:keydown.window.escape="increment" nv:click="close">Close</button>{{/open}}<p id="done">done</p>`,
    steps: [
      { keyboard: 'Escape' },
      { expect: { actions: ['increment'] } },
      { click: '#close' },
      {
        expect: {
          actions: ['increment', 'close'],
          values: { "document.getElementById('close')": null },
        },
      },
      { keyboard: 'Escape' },
      { wait: 150 },
      { expect: { actions: ['increment', 'close'] } },
    ],
  },
  {
    name: 'nv:keydown.window.debounce coalesces global key repeats',
    ...counter,
    html: `${output}<span id="hotkey" nv:keydown.window.arrow-down.debounce.100ms="increment">Hotkey</span>`,
    steps: [
      { keyboard: 'ArrowDown' },
      { keyboard: 'ArrowDown' },
      { keyboard: 'ArrowDown' },
      { wait: 300 },
      { expect: { actions: ['increment'] } },
    ],
  },
];

const formRows: Row[] = [
  {
    name: 'nv:submit prevents native submission and invokes once',
    state: { name: '', saved: '' },
    actions: { save: { copy: ['name', 'saved'] } },
    html: '<form id="form" action="/other" nv:submit="save"><label for="name">Name</label><input id="name" nv:model="name"><button id="send" type="submit">Save</button></form><p id="saved">{{saved}}</p>',
    steps: [
      { fill: '#name', value: 'Ada' },
      { click: '#send' },
      {
        expect: {
          actions: ['save'],
          updates: [{ name: 'Ada' }],
          text: { '#saved': 'Ada' },
          values: { 'location.pathname': '/' },
        },
      },
    ],
  },
  {
    name: 'nv:submit suppresses duplicate submits while pending',
    state: { saved: 0 },
    hold: true,
    actions: { save: { increment: 'saved' } },
    html: '<form nv:submit="save"><button id="send" type="submit">Save</button></form><output id="saved">{{saved}}</output>',
    steps: [
      { click: '#send' },
      { click: '#send' },
      { press: '#send', key: 'Enter' },
      { wait: 100 },
      { expect: { actions: ['save'] } },
      { release: 'all' },
      { expect: { text: { '#saved': '1' } } },
      { click: '#send' },
      { release: 'all' },
      { expect: { actions: ['save', 'save'], text: { '#saved': '2' } } },
    ],
  },
  {
    name: 'nested submit buttons and implicit Enter submission share one binding',
    state: { saved: 0 },
    actions: { save: { increment: 'saved' } },
    html: '<form nv:submit.prevent="save"><input id="field" aria-label="Field"><button id="first" type="submit">First</button><button id="second" type="submit">Second</button><button id="plain" type="button">Plain</button></form><output id="saved">{{saved}}</output>',
    steps: [
      { click: '#second' },
      { expect: { text: { '#saved': '1' } } },
      { press: '#field', key: 'Enter' },
      { expect: { text: { '#saved': '2' } } },
      { click: '#plain' },
      { wait: 150 },
      { expect: { actions: ['save', 'save'] } },
    ],
  },
  {
    name: 'native constraint validation blocks nv:submit until the form is valid',
    state: { email: '' },
    actions: { save: {} },
    html: '<form nv:submit="save"><label for="email">Email</label><input id="email" type="email" required nv:model="email"><button id="send" type="submit">Save</button></form>',
    steps: [
      { click: '#send' },
      { wait: 150 },
      { expect: { actions: [] } },
      { fill: '#email', value: 'ada@example.test' },
      { click: '#send' },
      {
        expect: { actions: ['save'], updates: [{ email: 'ada@example.test' }] },
      },
    ],
  },
  {
    name: 'nv:submit + nv:loading.attr disables the submitter only while pending',
    state: {},
    hold: true,
    actions: { save: {} },
    html: '<form nv:submit="save"><button id="send" type="submit" nv:loading.attr="disabled" nv:target="save">Save</button></form>',
    steps: [
      { click: '#send' },
      { expect: { attrs: { '#send': { disabled: '' } } } },
      { release: 'all' },
      { expect: { attrs: { '#send': { disabled: null } } } },
    ],
  },
  {
    name: 'nv:submit.debounce coalesces rapid submissions',
    state: { saved: 0 },
    actions: { save: { increment: 'saved' } },
    html: '<form id="form" nv:submit.debounce.80ms="save"><button id="send" type="submit">Save</button></form><output id="saved">{{saved}}</output>',
    steps: [
      { burst: '#send', count: 3 },
      { wait: 250 },
      { expect: { actions: ['save'], values: { 'location.pathname': '/' } } },
    ],
  },
];

const confirmRows: Row[] = [
  {
    name: 'nv:click + nv:confirm approved invokes',
    ...counter,
    confirm: 'approve',
    html: `${output}<button id="go" type="button" nv:click="increment" nv:confirm="Really?">Go</button>`,
    steps: [{ click: '#go' }, { expect: { actions: ['increment'] } }],
  },
  {
    name: 'nv:click + nv:confirm denied sends nothing',
    ...counter,
    confirm: 'deny',
    html: `${output}<button id="go" type="button" nv:click="increment" nv:confirm="Really?">Go</button>`,
    steps: [{ click: '#go' }, { wait: 150 }, { expect: { actions: [] } }],
  },
  {
    name: 'nv:submit + nv:confirm denied still prevents native submission',
    state: {},
    confirm: 'deny',
    actions: { save: {} },
    html: '<form action="/other" nv:submit="save" nv:confirm="Submit?"><button id="send" type="submit">Save</button></form>',
    steps: [
      { click: '#send' },
      { wait: 150 },
      { expect: { actions: [], values: { 'location.pathname': '/' } } },
    ],
  },
  {
    name: 'nv:confirm on a link prevents navigation even when approved',
    ...counter,
    confirm: 'approve',
    html: `${output}<a id="go" href="#away" nv:click="increment" nv:confirm="Leave?">Go</a>`,
    steps: [
      { click: '#go' },
      { expect: { actions: ['increment'], values: { 'location.hash': '' } } },
    ],
  },
  {
    name: 'nv:confirm + nv:click.once: a denied attempt consumes the single invocation',
    ...counter,
    confirm: 'deny',
    html: `${output}<button id="go" type="button" nv:click.once="increment" nv:confirm="Really?">Go</button>`,
    steps: [
      { click: '#go' },
      { click: '#go' },
      { wait: 150 },
      { expect: { actions: [] } },
    ],
  },
  {
    name: 'nv:keydown.enter + nv:confirm approved invokes from the keyboard',
    ...counter,
    confirm: 'approve',
    html: `${output}<input id="field" aria-label="Field" nv:keydown.enter="increment" nv:confirm="Send?">`,
    steps: [
      { press: '#field', key: 'Enter' },
      { expect: { actions: ['increment'] } },
    ],
  },
];

const loadingRows: Row[] = [
  {
    name: 'nv:loading shows a status only while any request is pending',
    ...counter,
    hold: true,
    html: `${output}<button id="go" type="button" nv:click="increment">Go</button><span id="status" role="status" nv:loading="">Saving…</span>`,
    steps: [
      {
        expect: { attrs: { '#status': { hidden: '', 'aria-hidden': 'true' } } },
      },
      { click: '#go' },
      {
        expect: {
          attrs: {
            '#status': { hidden: null, 'aria-hidden': 'false' },
            '[data-nv-component]': { 'aria-busy': 'true' },
          },
        },
      },
      { release: 'all' },
      {
        expect: {
          attrs: {
            '#status': { hidden: '', 'aria-hidden': 'true' },
            '[data-nv-component]': { 'aria-busy': 'false' },
          },
        },
      },
    ],
  },
  {
    name: 'nv:loading.remove hides idle content while pending',
    ...counter,
    hold: true,
    html: `${output}<button id="go" type="button" nv:click="increment">Go</button><span id="idle" nv:loading.remove="">Ready</span>`,
    steps: [
      { expect: { attrs: { '#idle': { hidden: null } } } },
      { click: '#go' },
      { expect: { attrs: { '#idle': { hidden: '' } } } },
      { release: 'all' },
      { expect: { attrs: { '#idle': { hidden: null } } } },
    ],
  },
  {
    name: 'nv:loading.class + .class.remove + .attr on one element with a target',
    state: { count: 0 },
    hold: true,
    actions: { increment: { increment: 'count' }, other: {} },
    html: `${output}<button id="go" type="button" class="ready" nv:click="increment" nv:loading.class="busy" nv:loading.class.remove="ready" nv:loading.attr="aria-disabled" nv:target="increment">Go</button><button id="other" type="button" nv:click="other">Other</button>`,
    steps: [
      { click: '#other' },
      {
        expect: { attrs: { '#go': { class: 'ready', 'aria-disabled': null } } },
      },
      { release: 'all' },
      { click: '#go' },
      {
        expect: {
          attrs: { '#go': { class: 'busy', 'aria-disabled': 'true' } },
        },
      },
      { release: 'all' },
      {
        expect: { attrs: { '#go': { class: 'ready', 'aria-disabled': null } } },
      },
    ],
  },
  {
    name: 'nv:loading.delay hides the indicator for work that settles quickly',
    ...counter,
    html: `${output}<button id="go" type="button" nv:click="increment">Go</button><span id="status" role="status" nv:loading.delay.150ms="">Saving…</span>`,
    steps: [
      {
        run: "window.nvShown = 0; new MutationObserver(() => { if (!document.getElementById('status').hidden) window.nvShown++; }).observe(document.getElementById('status'), { attributes: true })",
      },
      { click: '#go' },
      { click: '#go' },
      { wait: 300 },
      {
        expect: {
          actions: ['increment', 'increment'],
          values: { 'window.nvShown': 0 },
          attrs: { '#status': { hidden: '' } },
        },
      },
    ],
  },
  {
    name: 'nv:loading.delay shows slow work after the delay and hides it on settle',
    ...counter,
    hold: true,
    html: `${output}<button id="go" type="button" nv:click="increment">Go</button><span id="status" role="status" nv:loading.delay.150ms="" nv:target="increment">Saving…</span>`,
    steps: [
      { click: '#go' },
      { wait: 50 },
      { expect: { attrs: { '#status': { hidden: '' } } } },
      { wait: 250 },
      {
        expect: {
          attrs: { '#status': { hidden: null, 'aria-hidden': 'false' } },
        },
      },
      { release: 'all' },
      { expect: { attrs: { '#status': { hidden: '' } } } },
    ],
  },
  {
    name: 'nv:loading.attr.delay disables a slow control only after the delay',
    ...counter,
    hold: true,
    html: `${output}<button id="go" type="button" nv:click="increment" nv:loading.attr.delay.100ms="disabled">Go</button>`,
    steps: [
      { click: '#go' },
      { expect: { attrs: { '#go': { disabled: null } } } },
      { wait: 250 },
      { expect: { attrs: { '#go': { disabled: '' } } } },
      { release: 'all' },
      { expect: { attrs: { '#go': { disabled: null } } } },
    ],
  },
  {
    name: 'per-action counts keep a target busy until every matching request settles',
    state: { count: 0 },
    hold: true,
    actions: { increment: { increment: 'count' }, slow: {} },
    html: `${output}<button id="slow" type="button" nv:click="slow">Slow</button><button id="go" type="button" nv:click="increment">Go</button><span id="slow-status" nv:loading="" nv:target="slow">Slow pending</span><span id="any" nv:loading="">Any pending</span>`,
    steps: [
      { click: '#go' },
      { click: '#slow' },
      { click: '#slow' },
      {
        expect: {
          attrs: { '#slow-status': { hidden: null }, '#any': { hidden: null } },
        },
      },
      { release: 'next' },
      { wait: 50 },
      { expect: { attrs: { '#slow-status': { hidden: null } } } },
      { release: 'next' },
      { wait: 50 },
      { expect: { attrs: { '#slow-status': { hidden: null } } } },
      { release: 'next' },
      {
        expect: {
          actions: ['increment', 'slow', 'slow'],
          attrs: { '#slow-status': { hidden: '' }, '#any': { hidden: '' } },
        },
      },
    ],
  },
  {
    name: 'nv:target="$sync" tracks model synchronization but not actions',
    state: { query: '', count: 0 },
    hold: true,
    actions: { increment: { increment: 'count' } },
    html: `${output}<input id="query" aria-label="Query" nv:model.live.debounce.30ms="query"><button id="go" type="button" nv:click="increment">Go</button><span id="syncing" nv:loading="" nv:target="$sync">Syncing</span>`,
    steps: [
      { click: '#go' },
      { expect: { attrs: { '#syncing': { hidden: '' } } } },
      { release: 'all' },
      { fill: '#query', value: 'nest' },
      {
        expect: {
          actions: ['increment', '_sync'],
          attrs: { '#syncing': { hidden: null } },
        },
      },
      { release: 'all' },
      { expect: { attrs: { '#syncing': { hidden: '' } } } },
    ],
  },
  {
    name: 'mixed delayed and immediate loading declarations on one element are rejected at registration',
    ...counter,
    html: `${output}<button id="go" type="button" nv:click="increment">Go</button><span id="status" nv:loading.delay="" nv:loading.class="busy">Saving</span>`,
    steps: [
      { click: '#go' },
      { wait: 150 },
      { expect: { actions: [], errors: ['DIRECTIVE'] } },
    ],
  },
  {
    name: 'nv:loading restores a server-disabled control rather than enabling it',
    ...counter,
    hold: true,
    html: `${output}<button id="go" type="button" nv:click="increment">Go</button><button id="locked" type="button" disabled nv:loading.attr="disabled">Locked</button>`,
    steps: [
      { click: '#go' },
      { release: 'all' },
      { expect: { attrs: { '#locked': { disabled: '' } } } },
    ],
  },
];

const modelRows: Row[] = [
  {
    name: 'nv:model (deferred) sends edits only with the next action',
    state: { name: '', saved: '' },
    actions: { save: { copy: ['name', 'saved'] } },
    html: '<input id="name" aria-label="Name" nv:model="name"><button id="save" type="button" nv:click="save">Save</button><p id="saved">{{saved}}</p>',
    steps: [
      { type: '#name', text: 'Ada' },
      { blur: '#name' },
      { wait: 300 },
      { expect: { actions: [] } },
      { click: '#save' },
      {
        expect: {
          actions: ['save'],
          updates: [{ name: 'Ada' }],
          text: { '#saved': 'Ada' },
        },
      },
    ],
  },
  {
    name: 'nv:model.live debounces typing into one synchronization',
    state: { query: '' },
    html: '<input id="query" aria-label="Query" nv:model.live="query"><p id="echo">{{query}}</p>',
    steps: [
      { type: '#query', text: 'nest' },
      { wait: 400 },
      {
        expect: {
          actions: ['_sync'],
          updates: [{ query: 'nest' }],
          text: { '#echo': 'nest' },
        },
      },
    ],
  },
  {
    name: 'nv:model.live.debounce.60ms uses its explicit interval',
    state: { query: '' },
    html: '<input id="query" aria-label="Query" nv:model.debounce.60ms="query">',
    steps: [
      {
        run: "const q = document.getElementById('query'); q.value = 'a'; q.dispatchEvent(new Event('input', { bubbles: true })); setTimeout(() => { q.value = 'ab'; q.dispatchEvent(new Event('input', { bubbles: true })); }, 25)",
      },
      { wait: 250 },
      { expect: { actions: ['_sync'], updates: [{ query: 'ab' }] } },
    ],
  },
  {
    name: 'nv:model.live.throttle sends the leading edit with no trailing call',
    state: { query: '' },
    html: '<input id="query" aria-label="Query" nv:model.live.throttle.500ms="query">',
    steps: [
      {
        // The leading call reads the draft when dispatched; later edits inside the
        // window are not sent by a trailing call.
        run: "const q = document.getElementById('query'); const edit = (v) => { q.value = v; q.dispatchEvent(new Event('input', { bubbles: true })); }; edit('a'); setTimeout(() => edit('ab'), 100); setTimeout(() => edit('abc'), 200)",
      },
      { wait: 700 },
      { expect: { actions: ['_sync'], updates: [{ query: 'a' }] } },
    ],
  },
  {
    name: 'nv:model.blur synchronizes on focus loss only',
    state: { title: '' },
    html: '<input id="title" aria-label="Title" nv:model.blur="title"><button id="other" type="button">Other</button>',
    steps: [
      { type: '#title', text: 'Draft' },
      { wait: 300 },
      { expect: { actions: [] } },
      { click: '#other' },
      { expect: { actions: ['_sync'], updates: [{ title: 'Draft' }] } },
    ],
  },
  {
    name: 'nv:model.change and its .lazy alias synchronize on native change',
    state: { color: 'red', size: 's' },
    html: '<select id="color" aria-label="Color" nv:model.change="color"><option>red</option><option>blue</option></select><select id="size" aria-label="Size" nv:model.lazy="size"><option>s</option><option>m</option></select>',
    steps: [
      { select: '#color', value: 'blue' },
      { expect: { actions: ['_sync'], updates: [{ color: 'blue' }] } },
      { select: '#size', value: 'm' },
      {
        expect: {
          actions: ['_sync', '_sync'],
          updates: [{ color: 'blue' }, { size: 'm' }],
        },
      },
    ],
  },
  {
    name: 'nv:model.number converts complete decimals and blocks invalid input',
    state: { qty: 1 },
    actions: { save: {} },
    html: '<input id="qty" aria-label="Quantity" nv:model.number="qty"><button id="save" type="button" nv:click="save">Save</button>',
    steps: [
      { fill: '#qty', value: '2.5e1' },
      { click: '#save' },
      { expect: { actions: ['save'], updates: [{ qty: 25 }] } },
      { fill: '#qty', value: '0x10' },
      { click: '#save' },
      { wait: 150 },
      {
        expect: {
          actions: ['save'],
          values: {
            "window.nvHarness.errors.length > 0 && window.nvHarness.errors.every((code) => code === 'DIRECTIVE')": true,
          },
        },
      },
      { fill: '#qty', value: '7' },
      { click: '#save' },
      {
        expect: {
          actions: ['save', 'save'],
          updates: [{ qty: 25 }, { qty: 7 }],
        },
      },
    ],
  },
  {
    name: 'nv:model.change.boolean casts select values',
    state: { enabled: false },
    html: '<select id="enabled" aria-label="Enabled" nv:model.change.boolean="enabled"><option value="false">No</option><option value="true">Yes</option></select>',
    steps: [
      { select: '#enabled', value: 'true' },
      { expect: { actions: ['_sync'], updates: [{ enabled: true }] } },
    ],
  },
  {
    name: 'checkbox, radio and multiple select models produce typed values',
    state: { agree: false, plan: 'free', tags: [] },
    actions: { save: {} },
    html: '<input id="agree" type="checkbox" aria-label="Agree" nv:model="agree"><input id="free" type="radio" name="plan" value="free" aria-label="Free" nv:model="plan" checked><input id="pro" type="radio" name="plan" value="pro" aria-label="Pro" nv:model="plan"><select id="tags" multiple aria-label="Tags" nv:model="tags"><option>a</option><option>b</option><option>c</option></select><button id="save" type="button" nv:click="save">Save</button>',
    steps: [
      { check: '#agree' },
      { check: '#pro' },
      { select: '#tags', value: ['a', 'c'] },
      { click: '#save' },
      { expect: { updates: [{ agree: true, plan: 'pro', tags: ['a', 'c'] }] } },
    ],
  },
  {
    name: 'textarea nv:model.live synchronizes multi-line text',
    state: { notes: '' },
    html: '<textarea id="notes" aria-label="Notes" nv:model.live.debounce.40ms="notes"></textarea>',
    steps: [
      { fill: '#notes', value: 'one\ntwo' },
      { expect: { actions: ['_sync'], updates: [{ notes: 'one\ntwo' }] } },
    ],
  },
  {
    name: 'nv:model + nv:dirty + nv:text show the local draft until the server agrees',
    state: { name: 'Server', saved: '' },
    hold: true,
    actions: { save: { copy: ['name', 'saved'] } },
    html: '<input id="name" aria-label="Name" nv:model="name" value="{{name}}"><p id="preview" nv:text="name">{{name}}</p><span id="dirty" nv:dirty="name">Unsaved</span><span id="any" nv:dirty="">Any unsaved</span><button id="save" type="button" nv:click="save">Save</button>',
    steps: [
      {
        expect: { attrs: { '#dirty': { hidden: '' }, '#any': { hidden: '' } } },
      },
      { fill: '#name', value: 'Local' },
      {
        expect: {
          text: { '#preview': 'Local' },
          attrs: { '#dirty': { hidden: null }, '#any': { hidden: null } },
        },
      },
      { click: '#save' },
      { release: 'all' },
      {
        expect: {
          text: { '#preview': 'Local' },
          attrs: { '#dirty': { hidden: '' }, '#any': { hidden: '' } },
        },
      },
    ],
  },
  {
    name: 'nv:dirty returns hidden when the user restores the server value',
    state: { name: 'Server' },
    html: '<input id="name" aria-label="Name" nv:model="name" value="{{name}}"><span id="dirty" nv:dirty="name">Unsaved</span>',
    steps: [
      { fill: '#name', value: 'Changed' },
      { expect: { attrs: { '#dirty': { hidden: null } } } },
      { fill: '#name', value: 'Server' },
      { expect: { attrs: { '#dirty': { hidden: '' } } } },
    ],
  },
  {
    name: 'IME composition defers synchronization until composition ends',
    state: { query: '' },
    html: '<input id="query" aria-label="Query" nv:model.live.debounce.30ms="query">',
    steps: [
      {
        run: "const q = document.getElementById('query'); q.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); q.value = 'ni'; q.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));",
      },
      { wait: 200 },
      { expect: { actions: [] } },
      {
        run: "const q = document.getElementById('query'); q.value = '你'; q.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));",
      },
      { expect: { actions: ['_sync'], updates: [{ query: '你' }] } },
    ],
  },
  {
    name: 'an action cancels a pending model timer and carries the draft',
    state: { query: '', count: 0 },
    actions: { increment: { increment: 'count' } },
    html: `${output}<input id="query" aria-label="Query" nv:model.live.debounce.300ms="query"><button id="go" type="button" nv:click="increment">Go</button>`,
    steps: [
      { fill: '#query', value: 'x' },
      { click: '#go' },
      { wait: 500 },
      { expect: { actions: ['increment'], updates: [{ query: 'x' }] } },
    ],
  },
];

const checked = (id: string): string =>
  `document.getElementById('${id}').checked`;
const address = { city: 'Cairo', zip: '11511', geo: { lat: 30 } };
const structureRows: Row[] = [
  {
    name: 'nested nv:model path sends its whole top-level field with the draft leaf',
    state: { address, saved: 0 },
    actions: { save: { increment: 'saved' } },
    html: '<input id="city" aria-label="City" nv:model="address.city" value="{{address.city}}"><output id="echo" nv:text="address.city">{{address.city}}</output><span id="dirty" nv:dirty="address" hidden>Edited</span><span id="leaf" nv:dirty="address.zip" hidden>Zip edited</span><button id="save" type="button" nv:click="save">Save</button>',
    steps: [
      { fill: '#city', value: 'Giza' },
      {
        expect: {
          actions: [],
          text: { '#echo': 'Giza' },
          attrs: { '#dirty': { hidden: null }, '#leaf': { hidden: '' } },
        },
      },
      { click: '#save' },
      {
        expect: {
          actions: ['save'],
          updates: [{ address: { ...address, city: 'Giza' } }],
          text: { '#echo': 'Giza' },
          attrs: { '#dirty': { hidden: '' } },
          values: { "document.getElementById('city').value": 'Giza' },
        },
      },
    ],
  },
  {
    name: 'two nested leaves of one field merge into one live synchronization',
    state: { address },
    html: '<input id="city" aria-label="City" nv:model="address.city" value="{{address.city}}"><input id="lat" aria-label="Latitude" type="number" nv:model.live.number="address.geo.lat" value="{{address.geo.lat}}">',
    steps: [
      { fill: '#city', value: 'Giza' },
      { fill: '#lat', value: '29.9' },
      {
        expect: {
          actions: ['_sync'],
          updates: [
            { address: { ...address, city: 'Giza', geo: { lat: 29.9 } } },
          ],
        },
      },
    ],
  },
  {
    name: 'a nested radio group models one leaf',
    state: { prefs: { size: 's', color: 'red' } },
    html: '<label><input id="s" type="radio" name="size" value="s" nv:model.change="prefs.size" checked>S</label><label><input id="m" type="radio" name="size" value="m" nv:model.change="prefs.size">M</label><output id="size" nv:text="prefs.size">{{prefs.size}}</output>',
    steps: [
      // The static fixture template re-renders 's' as checked; assert the wire value.
      { click: '#m' },
      {
        expect: {
          actions: ['_sync'],
          updates: [{ prefs: { size: 'm', color: 'red' } }],
          text: { '#size': 'm' },
        },
      },
    ],
  },
  {
    name: 'a nested path to a missing leaf is rejected locally',
    state: { address },
    html: '<input id="street" aria-label="Street" nv:model.live="address.street">',
    steps: [
      { fill: '#street', value: 'Nile' },
      { wait: 300 },
      { expect: { actions: [], errors: ['DIRECTIVE'] } },
    ],
  },
  {
    name: 'a checkbox group models array state as checked values in document order',
    state: { tags: ['a'], saved: 0 },
    actions: { save: { increment: 'saved' } },
    html: '<input id="a" type="checkbox" aria-label="A" value="a" nv:model="tags" checked><input id="b" type="checkbox" aria-label="B" value="b" nv:model="tags"><input id="c" type="checkbox" aria-label="C" value="c" nv:model="tags"><span id="dirty" nv:dirty="tags" hidden>Edited</span><button id="save" type="button" nv:click="save">Save</button>',
    steps: [
      { check: '#c' },
      { check: '#b' },
      { expect: { attrs: { '#dirty': { hidden: null } } } },
      { click: '#save' },
      {
        expect: {
          actions: ['save'],
          updates: [{ tags: ['a', 'b', 'c'] }],
          attrs: { '#dirty': { hidden: '' } },
        },
      },
      { click: '#a' },
      { click: '#save' },
      {
        expect: {
          actions: ['save', 'save'],
          updates: [{ tags: ['a', 'b', 'c'] }, { tags: ['b', 'c'] }],
          values: { [checked('a')]: false, [checked('b')]: true },
        },
      },
    ],
  },
  {
    name: 'checkbox group membership follows authoritative server arrays',
    state: { ids: [1, 2] },
    actions: { only: { set: { ids: [3] } } },
    html: '<input id="one" type="checkbox" aria-label="One" value="1" nv:model.number="ids" checked><input id="two" type="checkbox" aria-label="Two" value="2" nv:model.number="ids" checked><input id="three" type="checkbox" aria-label="Three" value="3" nv:model.number="ids"><button id="only" type="button" nv:click="only">Only three</button>',
    steps: [
      { click: '#only' },
      {
        expect: {
          actions: ['only'],
          values: {
            [checked('one')]: false,
            [checked('two')]: false,
            [checked('three')]: true,
          },
        },
      },
    ],
  },
  {
    name: 'a checkbox group with .change.number synchronizes each change with typed values',
    state: { ids: [] },
    html: '<input id="one" type="checkbox" aria-label="One" value="1" nv:model.change.number="ids"><input id="two" type="checkbox" aria-label="Two" value="2" nv:model.change.number="ids">',
    steps: [
      { check: '#two' },
      { expect: { actions: ['_sync'], updates: [{ ids: [2] }] } },
      { check: '#one' },
      {
        expect: {
          actions: ['_sync', '_sync'],
          updates: [{ ids: [2] }, { ids: [1, 2] }],
        },
      },
    ],
  },
  {
    name: 'a checkbox group may alias a multiple select of the same cast',
    state: { tags: ['a'] },
    html: '<input id="a" type="checkbox" aria-label="A" value="a" nv:model="tags" checked><input id="b" type="checkbox" aria-label="B" value="b" nv:model="tags"><select id="pick" aria-label="Tags" multiple nv:model="tags"><option value="a" selected>A</option><option value="b">B</option></select>',
    steps: [
      { check: '#b' },
      {
        expect: {
          errors: [],
          values: {
            "[...document.getElementById('pick').selectedOptions].map((o) => o.value)":
              ['a', 'b'],
          },
        },
      },
    ],
  },
  {
    name: 'a scalar control cannot alias a checkbox group',
    state: { tags: ['a'] },
    html: '<input id="a" type="checkbox" aria-label="A" value="a" nv:model="tags" checked><input id="text" aria-label="Text" nv:model="tags">',
    steps: [{ expect: { errors: ['DIRECTIVE'] } }],
  },
];

const pay = (fail: NonNullable<Row['actions']>[string]['fail']) =>
  ({
    state: { count: 0 },
    idempotent: ['pay'],
    actions: { pay: { increment: 'count', ...(fail ? { fail } : {}) } },
    html: `${output}<button id="pay" type="button" nv:click="pay">Pay</button>`,
  }) as const;
const oneRequestId = 'new Set(nvHarness.requests.map((r) => r.requestId)).size';
const request = (detail: Record<string, unknown>): string =>
  `nestvexa:request:${JSON.stringify(detail)}`;
const transportRows: Row[] = [
  {
    name: 'an idempotent action is resent after a dropped connection with the same requestId',
    ...pay({ times: 1, with: 'network' }),
    steps: [
      { click: '#pay' },
      {
        expect: {
          actions: ['pay', 'pay'],
          text: { '#count': '1' },
          errors: [],
          values: { [oneRequestId]: 1 },
          events: [
            request({ action: 'pay', phase: 'start', attempt: 0 }),
            request({ action: 'pay', phase: 'retry', attempt: 1 }),
            request({ action: 'pay', phase: 'end', outcome: 'succeeded' }),
          ],
        },
      },
    ],
  },
  {
    name: 'a lost reply of a committed idempotent action is replayed, not run twice',
    ...pay({ times: 1, with: 'network', commit: true }),
    steps: [
      { click: '#pay' },
      {
        expect: {
          actions: ['pay', 'pay'],
          text: { '#count': '1' },
          values: { 'nvHarness.state.count': 1, [oneRequestId]: 1 },
          errors: [],
        },
      },
    ],
  },
  {
    name: 'idempotent retries stop after two resends and report the failure',
    ...pay({ times: 9, with: 'network' }),
    steps: [
      { click: '#pay' },
      {
        expect: {
          actions: ['pay', 'pay', 'pay'],
          errors: ['NETWORK'],
          text: { '#count': '0' },
        },
      },
      { wait: 1500 },
      { expect: { actions: ['pay', 'pay', 'pay'] } },
    ],
  },
  {
    name: 'transient 503 and 409 replies are retried for idempotent actions',
    ...pay({ times: 2, with: 503 }),
    steps: [
      { click: '#pay' },
      {
        expect: {
          actions: ['pay', 'pay', 'pay'],
          text: { '#count': '1' },
          errors: [],
        },
      },
    ],
  },
  {
    name: 'a 422 rejection of an idempotent action is not retried',
    ...pay({ times: 1, with: 422 }),
    steps: [
      { click: '#pay' },
      { wait: 1200 },
      { expect: { actions: ['pay'], errors: ['HTTP'] } },
    ],
  },
  {
    name: 'actions the server did not declare idempotent are never retried',
    state: { count: 0 },
    actions: { increment: { fail: { times: 1, with: 'network' } } },
    html: `${output}<button id="go" type="button" nv:click="increment">Go</button>`,
    steps: [
      { click: '#go' },
      { wait: 1200 },
      { expect: { actions: ['increment'], errors: ['NETWORK'] } },
    ],
  },
  {
    name: 'a reply advertising another protocol major is rejected as PROTOCOL and suspends',
    ...counter,
    actions: { increment: { increment: 'count', protocol: 'nestvexa-live/2' } },
    html: `${output}<button id="go" type="button" nv:click="increment">Go</button>`,
    steps: [
      { click: '#go' },
      { expect: { errors: ['PROTOCOL'], text: { '#count': '0' } } },
      { click: '#go' },
      { wait: 300 },
      { expect: { actions: ['increment'] } },
    ],
  },
  {
    name: 'a 426 reply is reported as PROTOCOL',
    ...counter,
    actions: { increment: { status: 426 } },
    html: `${output}<button id="go" type="button" nv:click="increment">Go</button>`,
    steps: [{ click: '#go' }, { expect: { errors: ['PROTOCOL'] } }],
  },
  {
    name: 'a reply advertising the current protocol major is applied',
    ...counter,
    actions: { increment: { increment: 'count', protocol: 'nestvexa-live/1' } },
    html: `${output}<button id="go" type="button" nv:click="increment">Go</button>`,
    steps: [
      { click: '#go' },
      { expect: { errors: [], text: { '#count': '1' } } },
    ],
  },
  {
    name: 'model synchronizations queued behind an in-flight request fold into one',
    state: { query: '', count: 0 },
    actions: { increment: { increment: 'count', hold: true } },
    html: `${output}<button id="go" type="button" nv:click="increment">Go</button><input id="q" aria-label="Query" nv:model.live.debounce.50ms="query">`,
    steps: [
      { click: '#go' },
      { fill: '#q', value: 'a' },
      { wait: 200 },
      { fill: '#q', value: 'ab' },
      { wait: 200 },
      { fill: '#q', value: 'abc' },
      { wait: 200 },
      { release: 'all' },
      {
        expect: {
          actions: ['increment', '_sync'],
          updates: [{}, { query: 'abc' }],
          text: { '#count': '1' },
        },
      },
    ],
  },
  {
    name: 'a synchronization folds into a queued action that has not started',
    state: { query: '', count: 0, other: 0 },
    actions: {
      increment: { increment: 'count', hold: true },
      bump: { increment: 'other' },
    },
    html: `${output}<button id="go" type="button" nv:click="increment">Go</button><button id="bump" type="button" nv:click="bump">Bump</button><input id="q" aria-label="Query" nv:model.live.debounce.50ms="query">`,
    steps: [
      { click: '#go' },
      { click: '#bump' },
      { fill: '#q', value: 'x' },
      { wait: 200 },
      { release: 'all' },
      {
        expect: {
          actions: ['increment', 'bump'],
          updates: [{}, { query: 'x' }],
        },
      },
    ],
  },
];

const sortList = (extra = ''): string =>
  `<ol id="tasks" nv:sort="reorder" aria-label="Tasks"${extra}>${['a', 'b', 'c']
    .map(
      (id) =>
        `<li id="item-${id}" nv:sort.item="${id}" style="min-height:48px"><button id="h-${id}" type="button" nv:sort.handle aria-label="Move ${id}">${id}</button></li>`,
    )
    .join('')}</ol>`;
const sortRows: Row[] = [
  {
    name: 'nv:sort keyboard Alt+ArrowDown proposes the next position by stable IDs',
    state: { moves: 0 },
    actions: { reorder: { increment: 'moves' } },
    html: sortList(),
    steps: [
      { focus: '#h-a' },
      { keyboard: 'Alt+ArrowDown' },
      { expect: { actions: ['reorder'], inputs: [{ ids: ['b', 'a', 'c'] }] } },
    ],
  },
  {
    name: 'nv:sort keyboard Alt+End and Alt+Home move to the list edges',
    state: { moves: 0 },
    actions: { reorder: { increment: 'moves' } },
    html: sortList(),
    steps: [
      { focus: '#h-a' },
      { keyboard: 'Alt+End' },
      { expect: { inputs: [{ ids: ['b', 'c', 'a'] }] } },
      { focus: '#h-c' },
      { keyboard: 'Alt+Home' },
      {
        expect: {
          inputs: [{ ids: ['b', 'c', 'a'] }, { ids: ['c', 'a', 'b'] }],
        },
      },
    ],
  },
  {
    name: 'nv:sort ignores unmodified, Shift and Control arrows and edge moves',
    state: { moves: 0 },
    actions: { reorder: { increment: 'moves' } },
    html: sortList(),
    steps: [
      { focus: '#h-b' },
      { keyboard: 'ArrowDown' },
      { keyboard: 'Shift+Alt+ArrowDown' },
      { keyboard: 'Control+Alt+ArrowDown' },
      { focus: '#h-a' },
      { keyboard: 'Alt+ArrowUp' },
      { wait: 300 },
      { expect: { actions: [] } },
    ],
  },
  {
    name: 'nv:sort native pointer drag onto the lower half of a later item',
    state: { moves: 0 },
    actions: { reorder: { increment: 'moves' } },
    html: sortList(),
    steps: [
      { drag: '#h-a', to: '#item-c', half: 'bottom' },
      { expect: { actions: ['reorder'], inputs: [{ ids: ['b', 'c', 'a'] }] } },
    ],
  },
  {
    name: 'nv:sort native pointer drag onto the upper half of an earlier item',
    state: { moves: 0 },
    actions: { reorder: { increment: 'moves' } },
    html: sortList(),
    steps: [
      { drag: '#h-c', to: '#item-a', half: 'top' },
      { expect: { actions: ['reorder'], inputs: [{ ids: ['c', 'a', 'b'] }] } },
    ],
  },
  {
    name: 'nv:sort blocks keyboard and pointer moves while a move is pending, with nv:loading',
    state: { moves: 0 },
    actions: { reorder: { increment: 'moves', hold: true } },
    html: `${sortList()}<p id="busy" nv:loading nv:target="reorder" hidden>Saving order</p>`,
    steps: [
      { focus: '#h-a' },
      { keyboard: 'Alt+ArrowDown' },
      { expect: { attrs: { '#busy': { hidden: null } } } },
      { keyboard: 'Alt+ArrowDown' },
      { drag: '#h-c', to: '#item-a', half: 'top' },
      { wait: 300 },
      { expect: { actions: ['reorder'] } },
      { release: 'all' },
      { expect: { attrs: { '#busy': { hidden: '' } } } },
      { focus: '#h-b' },
      { keyboard: 'Alt+ArrowDown' },
      {
        expect: {
          inputs: [{ ids: ['b', 'a', 'c'] }, { ids: ['a', 'c', 'b'] }],
        },
      },
    ],
  },
  {
    name: 'nv:sort inside nv:ignore is not bound',
    state: { moves: 0 },
    html: `<div nv:ignore>${sortList()}</div>`,
    steps: [
      { focus: '#h-a' },
      { keyboard: 'Alt+ArrowDown' },
      { drag: '#h-a', to: '#item-c', half: 'bottom' },
      { wait: 300 },
      { expect: { actions: [], errors: [] } },
    ],
  },
];

const lifecycleRows: Row[] = [
  {
    name: 'a browser-restored model value becomes an announced draft shown by nv:dirty',
    state: { name: 'Ada', saved: 0 },
    actions: { save: { increment: 'saved' } },
    restore: { '#name': 'Grace' },
    html: '<input id="name" aria-label="Name" nv:model="name" value="{{name}}"><span id="dirty" nv:dirty="name" hidden>Restored edit</span><button id="save" type="button" nv:click="save">Save</button>',
    steps: [
      {
        expect: {
          attrs: { '#dirty': { hidden: null } },
          events: ['nestvexa:restored:{"fields":["name"]}'],
          values: { "document.getElementById('name').value": 'Grace' },
        },
      },
      { click: '#save' },
      {
        expect: {
          actions: ['save'],
          updates: [{ name: 'Grace' }],
          attrs: { '#dirty': { hidden: '' } },
        },
      },
    ],
  },
  {
    name: 'markup without a rendered value is not mistaken for a restored edit',
    state: { name: 'Ada', saved: 0 },
    actions: { save: { increment: 'saved' } },
    html: '<input id="name" aria-label="Name" nv:model="name"><span id="dirty" nv:dirty hidden>Edited</span><button id="save" type="button" nv:click="save">Save</button>',
    steps: [
      { click: '#save' },
      {
        expect: {
          actions: ['save'],
          updates: [{}],
          attrs: { '#dirty': { hidden: '' } },
        },
      },
    ],
  },
  {
    name: 'restored checkbox groups, multiple selects and nested leaves become drafts',
    state: { tags: ['a'], picks: ['x'], address, saved: 0 },
    actions: { save: { increment: 'saved' } },
    restore: { '#b': true, '#y': true, '#city': 'Giza' },
    html: '<input id="a" type="checkbox" aria-label="A" value="a" nv:model="tags" checked><input id="b" type="checkbox" aria-label="B" value="b" nv:model="tags"><select aria-label="Picks" multiple nv:model="picks"><option id="x" value="x" selected>X</option><option id="y" value="y">Y</option></select><input id="city" aria-label="City" nv:model="address.city" value="{{address.city}}"><button id="save" type="button" nv:click="save">Save</button>',
    steps: [
      {
        expect: {
          events: [
            'nestvexa:restored:{"fields":["tags","picks","address.city"]}',
          ],
          values: { [checked('b')]: true },
        },
      },
      { click: '#save' },
      {
        expect: {
          updates: [
            {
              tags: ['a', 'b'],
              picks: ['x', 'y'],
              address: { ...address, city: 'Giza' },
            },
          ],
        },
      },
    ],
  },
  {
    name: 'an unrepresentable restored value is never sent',
    state: { amount: 1, saved: 0 },
    actions: { save: { increment: 'saved' } },
    restore: { '#amount': 'abc' },
    html: '<input id="amount" aria-label="Amount" nv:model.number="amount" value="{{amount}}"><button id="save" type="button" nv:click="save">Save</button>',
    steps: [
      { click: '#save' },
      { expect: { actions: ['save'], updates: [{}], errors: [] } },
    ],
  },
  {
    name: 'development inspect() lists draft names without values, tokens or endpoints',
    state: { name: '', count: 0 },
    development: true,
    idempotent: ['increment'],
    html: '<input id="name" aria-label="Name" nv:model="name">',
    steps: [
      { fill: '#name', value: 'secret-draft' },
      {
        expect: {
          values: {
            'nvHarness.client.inspect().map((c) => [c.name, c.revision, c.dirty, c.failure, c.idempotent])':
              [['matrix', 0, ['name'], null, ['increment']]],
            '/secret-draft|matrix-csrf|AAAAAAAA|\\/live\\/matrix/.test(JSON.stringify(nvHarness.client.inspect()))': false,
          },
        },
      },
    ],
  },
  {
    name: 'inspect() is unavailable without the development option',
    ...counter,
    html: output,
    steps: [
      {
        expect: {
          values: {
            "(() => { try { nvHarness.client.inspect(); return 'exposed'; } catch (error) { return error.code; } })()":
              'DIRECTIVE',
          },
        },
      },
    ],
  },
];

const presentationRows: Row[] = [
  {
    name: 'nv:show toggles hidden/aria-hidden and moves focus out of hidden content',
    state: { open: true },
    actions: { close: { toggle: 'open' } },
    html: '<div id="panel" nv:show="open"><button id="close" type="button" nv:click="close">Close</button></div>',
    steps: [
      { focus: '#close' },
      { press: '#close', key: 'Enter' },
      {
        expect: {
          attrs: { '#panel': { hidden: '', 'aria-hidden': 'true' } },
          values: {
            "document.activeElement === document.querySelector('[data-nv-component]')": true,
          },
        },
      },
    ],
  },
  {
    name: 'nv:text escapes markup and nv:bind updates allowlisted attributes',
    state: { label: '<b>bold</b>', expanded: false },
    actions: {
      change: {
        set: { label: '<img src=x onerror=alert(1)>', expanded: true },
      },
    },
    html: '<p id="label" nv:text="label" nv:bind="title:label"></p><button id="go" type="button" nv:click="change" nv:bind="aria-expanded:expanded">Go</button>',
    steps: [
      {
        expect: {
          text: { '#label': '<b>bold</b>' },
          values: { "document.querySelectorAll('#label *').length": 0 },
          attrs: {
            '#label': { title: '<b>bold</b>' },
            '#go': { 'aria-expanded': 'false' },
          },
        },
      },
      { click: '#go' },
      {
        expect: {
          text: { '#label': '<img src=x onerror=alert(1)>' },
          values: { "document.querySelectorAll('#label *').length": 0 },
          attrs: { '#go': { 'aria-expanded': 'true' } },
        },
      },
    ],
  },
  {
    name: 'nv:bind rejects executable URLs before writing them',
    state: { link: '/safe' },
    actions: { change: { set: { link: 'javascript:alert(1)' } } },
    html: '<a id="link" href="/safe" nv:bind="href:link">Link</a><button id="go" type="button" nv:click="change">Go</button>',
    steps: [
      { click: '#go' },
      {
        expect: {
          attrs: { '#link': { href: '/safe' } },
          errors: ['DIRECTIVE'],
        },
      },
    ],
  },
  {
    name: 'nv:cloak is removed after successful initialization',
    state: { name: 'Ada' },
    html: '<p id="cloaked" nv:cloak="" nv:text="name">Ada</p>',
    steps: [{ expect: { attrs: { '#cloaked': { 'nv:cloak': null } } } }],
  },
  {
    name: 'nv:ref resolves unique owned references through current DOM',
    state: { open: true },
    actions: { toggle: { toggle: 'open' } },
    html: '<button id="go" type="button" nv:click="toggle">Go</button>{{#open}}<section id="panel" nv:ref="panel">Panel</section>{{/open}}',
    steps: [
      {
        expect: {
          values: {
            "window.nvHarness.client.refs(window.nvHarness.root).get('panel')?.id ?? null":
              'panel',
          },
        },
      },
      { click: '#go' },
      {
        expect: {
          values: {
            "window.nvHarness.client.refs(window.nvHarness.root).get('panel')?.id ?? null":
              null,
          },
        },
      },
    ],
  },
  {
    name: 'nv:ignore preserves a subtree while siblings morph',
    ...counter,
    html: `${output}<div id="widget" nv:ignore=""><span id="local">server</span></div><button id="go" type="button" nv:click="increment">Go</button>`,
    steps: [
      { run: "document.getElementById('local').textContent = 'local state'" },
      { click: '#go' },
      { expect: { text: { '#count': '1', '#local': 'local state' } } },
    ],
  },
  {
    name: 'nv:ignore.self keeps wrapper attributes while children update',
    ...counter,
    html: '<div id="wrapper" nv:ignore.self="" class="server"><output id="count">{{count}}</output></div><button id="go" type="button" nv:click="increment">Go</button>',
    steps: [
      { run: "document.getElementById('wrapper').className = 'widget-owned'" },
      { click: '#go' },
      {
        expect: {
          text: { '#count': '1' },
          attrs: { '#wrapper': { class: 'widget-owned' } },
        },
      },
    ],
  },
  {
    name: 'nv:replace resets local input state that ordinary morphing preserves',
    ...counter,
    html: `${output}<section id="replaced" nv:replace=""><input id="temporary" aria-label="Temporary" value="default"></section><input id="kept" aria-label="Kept" value="default"><button id="go" type="button" nv:click="increment">Go</button>`,
    steps: [
      { fill: '#temporary', value: 'typed' },
      { fill: '#kept', value: 'typed' },
      { click: '#go' },
      {
        expect: {
          text: { '#count': '1' },
          values: {
            "document.getElementById('temporary').value": 'default',
            "document.getElementById('kept').value": 'typed',
          },
          events: ['nestvexa:before-remove', 'nestvexa:after-insert'],
        },
      },
    ],
  },
  {
    name: 'nv:current marks the matching link with its classes',
    state: {},
    html: '<a id="here" href="/" nv:current="active">Here</a><a id="there" href="/other" nv:current.exact="active">There</a>',
    steps: [
      {
        expect: {
          attrs: { '#here': { class: 'active' }, '#there': { class: null } },
        },
      },
    ],
  },
  {
    name: 'nv:init runs once after registration and survives re-render',
    state: { loaded: 0 },
    actions: { load: { increment: 'loaded' } },
    html: '<div nv:init="load"><output id="loaded">{{loaded}}</output></div>',
    steps: [
      { expect: { actions: ['load'], text: { '#loaded': '1' } } },
      { wait: 200 },
      { expect: { actions: ['load'] } },
    ],
  },
  {
    name: 'nv:init + nv:loading show placeholder content during initialization',
    state: { loaded: false },
    hold: true,
    actions: { load: { set: { loaded: true } } },
    html: '<div nv:init="load"><p id="placeholder" nv:loading="" nv:target="load">Loading…</p>{{#loaded}}<p id="content">Ready</p>{{/loaded}}</div>',
    steps: [
      {
        expect: {
          actions: ['load'],
          attrs: { '#placeholder': { hidden: null } },
        },
      },
      { release: 'all' },
      {
        expect: {
          text: { '#content': 'Ready' },
          attrs: { '#placeholder': { hidden: '' } },
        },
      },
    ],
  },
  {
    name: 'nv:intersect.once loads when scrolled into view',
    state: { seen: 0 },
    actions: { reveal: { increment: 'seen' } },
    html: '<div class="spacer"></div><p id="sentinel" nv:intersect.once="reveal">Sentinel <output id="seen">{{seen}}</output></p>',
    steps: [
      { wait: 200 },
      { expect: { actions: [] } },
      { run: "document.getElementById('sentinel').scrollIntoView()" },
      { expect: { actions: ['reveal'], text: { '#seen': '1' } } },
    ],
  },
  {
    name: 'nv:poll refreshes on its interval and pauses while the page is hidden',
    state: { ticks: 0 },
    actions: { tick: { increment: 'ticks' } },
    html: '<p nv:poll.1000ms="tick">Ticks <output id="ticks">{{ticks}}</output></p>',
    // Counts, not exact lists: a loaded machine may run a second tick before hiding.
    steps: [
      { expect: { values: { 'nvHarness.requests.length >= 1': true } } },
      {
        run: "Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); window.nvHidden = nvHarness.requests.length",
      },
      { wait: 2300 },
      {
        expect: {
          values: { 'nvHarness.requests.length === window.nvHidden': true },
        },
      },
      {
        run: "Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange'))",
      },
      {
        expect: {
          values: { 'nvHarness.requests.length > window.nvHidden': true },
        },
      },
    ],
  },
  {
    name: 'nv:optimistic.increment projects immediately and keeps the server value',
    ...counter,
    hold: true,
    html: `<output id="count" nv:text="count">{{count}}</output><button id="go" type="button" nv:click="increment" nv:optimistic.increment="count">Go</button>`,
    steps: [
      { click: '#go' },
      { expect: { text: { '#count': '1' }, actions: ['increment'] } },
      { release: 'all' },
      { expect: { text: { '#count': '1' } } },
    ],
  },
  {
    name: 'nv:optimistic rolls back on a recoverable rejection and emits nestvexa:rollback',
    state: { liked: false },
    hold: true,
    actions: { like: { status: 422 } },
    html: '<span id="liked" nv:text="liked">{{liked}}</span><button id="go" type="button" nv:click="like" nv:optimistic.toggle="liked">Like</button>',
    steps: [
      { click: '#go' },
      { expect: { text: { '#liked': 'true' } } },
      { release: 'all' },
      {
        expect: {
          text: { '#liked': 'false' },
          events: ['nestvexa:rollback'],
          errors: ['HTTP'],
        },
      },
    ],
  },
  {
    name: 'nv:optimistic + nv:loading + nv:confirm combine on one control',
    ...counter,
    hold: true,
    confirm: 'approve',
    html: `<output id="count" nv:text="count">{{count}}</output><button id="go" type="button" nv:click="increment" nv:confirm="Add?" nv:optimistic.increment="count" nv:loading.attr="disabled" nv:target="increment">Go</button>`,
    steps: [
      { click: '#go' },
      {
        expect: { text: { '#count': '1' }, attrs: { '#go': { disabled: '' } } },
      },
      { release: 'all' },
      {
        expect: {
          text: { '#count': '1' },
          attrs: { '#go': { disabled: null } },
        },
      },
    ],
  },
];

describe.each(matrixBrowsers)('%s', (engine) => {
  beforeAll(async () => {
    fixture = await startMatrix(engine);
  });
  afterEach(async () => {
    await page?.evaluate(() => window.nvHarness?.client.dispose());
    await page?.close();
    page = undefined;
  });
  afterAll(async () => {
    await fixture?.close();
    fixture = undefined;
  });
  describe.each([
    ['event modifiers', eventRows],
    ['forms and submission', formRows],
    ['confirmation', confirmRows],
    ['loading, target and delay', loadingRows],
    ['model modifiers', modelRows],
    ['nested paths and checkbox groups', structureRows],
    ['transport: bundling, retry, negotiation and progress', transportRows],
    ['restored drafts and development inspection', lifecycleRows],
    ['sort keyboard and pointer', sortRows],
    ['bindings, presentation and observers', presentationRows],
  ])('directive matrix: %s', (_group, rows) => {
    it.each(rows.map((row) => [row.name, row] as const))(
      '%s',
      async (_name, row) => {
        await run(row);
      },
      30_000,
    );
  });
});
