import { chromium } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ActionClientError,
  createActionController,
  settle,
} from '../packages/actions/dist/client/index.js';
import type {
  ActionCallOptions,
  ActionMethod,
} from '../packages/actions/dist/client/index.js';

type Rename = ActionMethod<{ title: string }, { title: string }, 'title'>;

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** A fake action method whose calls are settled by the test. */
function fakeMethod() {
  const calls: {
    input: { title: string };
    signal: AbortSignal | undefined;
    result: ReturnType<typeof deferred<{ title: string }>>;
  }[] = [];
  const method = ((input: { title: string }, options?: ActionCallOptions) => {
    const result = deferred<{ title: string }>();
    options?.signal?.addEventListener('abort', () =>
      result.reject(new DOMException('Aborted', 'AbortError')),
    );
    calls.push({ input, signal: options?.signal, result });
    return result.promise;
  }) as Rename;
  return { method, calls };
}

const validation = () =>
  new ActionClientError('VALIDATION', 'Invalid', {
    status: 400,
    issues: [{ path: ['title'], message: 'Too short' }],
  });

describe('framework-neutral action controller', () => {
  it('tracks pending, success and typed validation errors with optimistic rollback', async () => {
    const { method, calls } = fakeMethod();
    const errors: string[] = [];
    const controller = createActionController(method, {
      initialData: { title: 'Initial' },
      optimistic: (_current, input) => ({ title: `${input.title}…` }),
      onError: (error) => errors.push(String(error.issues[0]?.path[0])),
    });
    const states: string[] = [];
    controller.subscribe((state) =>
      states.push(
        `${state.status}:${state.data?.title ?? ''}:${state.optimistic}`,
      ),
    );
    const first = controller.run({ title: 'One' });
    calls[0]?.result.resolve({ title: 'One' });
    expect(await first).toEqual({ ok: true, data: { title: 'One' } });
    const second = controller.run({ title: 'x' });
    calls[1]?.result.reject(validation());
    const failed = await second;
    expect(failed.ok).toBe(false);
    expect(errors).toEqual(['title']);
    expect(controller.getSnapshot().error?.code).toBe('VALIDATION');
    expect(states).toEqual([
      'idle:Initial:false',
      'pending:One…:true',
      'success:One:false',
      'pending:x…:true',
      'error:One:false',
    ]);
  });

  it('aborts superseded calls and ignores their stale results', async () => {
    const { method, calls } = fakeMethod();
    const controller = createActionController(method);
    const first = controller.run({ title: 'first' });
    const second = controller.run({ title: 'second' });
    expect(calls[0]?.signal?.aborted).toBe(true);
    calls[1]?.result.resolve({ title: 'second' });
    expect((await first).ok).toBe(false);
    await second;
    expect(controller.getSnapshot()).toMatchObject({
      status: 'success',
      data: { title: 'second' },
    });

    const parallel = createActionController(method, { abortPrevious: false });
    void parallel.run({ title: 'a' });
    void parallel.run({ title: 'b' });
    expect(calls[2]?.signal?.aborted).toBe(false);
  });

  it('rolls back on abort, resets, honours caller signals and bounds listeners', async () => {
    const { method, calls } = fakeMethod();
    const controller = createActionController(method, {
      optimistic: () => ({ title: 'optimistic' }),
    });
    const pending = controller.run({ title: 'a' });
    expect(controller.getSnapshot().data).toEqual({ title: 'optimistic' });
    controller.abort();
    const aborted = await pending;
    expect(!aborted.ok && aborted.error.reason).toBe('ABORTED');
    expect(controller.getSnapshot()).toMatchObject({
      status: 'idle',
      data: undefined,
      pending: false,
    });
    const external = new AbortController();
    const viaSignal = controller.run(
      { title: 'b' },
      { signal: external.signal },
    );
    external.abort();
    expect((await viaSignal).ok).toBe(false);
    expect(calls[1]?.signal?.aborted).toBe(true);

    controller.reset();
    expect(controller.getSnapshot().status).toBe('idle');
    const stops = Array.from({ length: 256 }, () =>
      controller.listen(() => undefined),
    );
    expect(() => controller.listen(() => undefined)).toThrow(/Too many/);
    for (const stop of stops) stop();
    expect(() => controller.listen(() => undefined)).not.toThrow();
    // A throwing subscriber never breaks the others.
    let notified = 0;
    controller.listen(() => {
      throw new Error('subscriber bug');
    });
    controller.listen(() => notified++);
    controller.reset();
    expect(notified).toBe(1);
  });

  it('settle() turns failures into typed results and rethrows programming errors', async () => {
    expect(await settle(Promise.resolve(1))).toEqual({ ok: true, data: 1 });
    const failed = await settle<number, 'title'>(Promise.reject(validation()));
    expect(!failed.ok && failed.error.issues[0]?.path[0]).toBe('title');
    // An error from another bundled copy of the client (separate island chunk).
    const foreign = Object.defineProperty(
      Object.assign(new Error('Invalid'), { code: 'VALIDATION', issues: [] }),
      Symbol.for('nestvexa.actions.ActionClientError'),
      { value: true },
    );
    expect((await settle(Promise.reject(foreign))).ok).toBe(false);
    await expect(settle(Promise.reject(new TypeError('bug')))).rejects.toThrow(
      'bug',
    );
  });
});

describe('Live/HBS element binding in a browser', () => {
  let browser: Browser;
  let bundle = '';
  beforeAll(async () => {
    browser = await chromium.launch();
    const result = await build({
      entryPoints: ['packages/actions/dist/client/index.js'],
      bundle: true,
      format: 'iife',
      globalName: 'nvActions',
      write: false,
      logLevel: 'silent',
    });
    bundle = result.outputFiles[0]?.text ?? '';
  });
  afterAll(async () => {
    await browser.close();
  });

  it('reflects state, maps field issues to aria-invalid and dispatches nv:action', async () => {
    const page = await browser.newPage();
    await page.setContent(`<form id="f">
      <input name="title" />
      <span data-nv-error-for="title"></span>
      <button type="submit">Save</button>
    </form>`);
    await page.addScriptTag({ content: bundle });
    await page.evaluate(() => {
      const scope = window as unknown as {
        nvActions: typeof import('../packages/actions/dist/client/index.js');
        events: unknown[];
        unbind: () => void;
      };
      const client = scope.nvActions.createActionsClient({
        csrf: 'csrf-token-0123456789',
        fetch: (async (_url: string, init: RequestInit) => {
          const { input } = JSON.parse(String(init.body)) as {
            input: { title: string };
          };
          const ok = input.title.length >= 3;
          return new Response(
            JSON.stringify(
              ok
                ? {
                    protocol: 'nestvexa-actions/1',
                    ok: true,
                    requestId: 'r',
                    data: { title: input.title },
                  }
                : {
                    protocol: 'nestvexa-actions/1',
                    ok: false,
                    requestId: 'r',
                    error: {
                      code: 'VALIDATION',
                      message: 'Invalid',
                      issues: [
                        { path: ['title'], message: '<b>Too short</b>' },
                      ],
                    },
                  },
            ),
            { status: ok ? 200 : 400 },
          );
        }) as typeof fetch,
      });
      const rename = (input: unknown) =>
        client.call(
          {
            group: 'notes',
            action: 'rename',
            version: null,
            idempotent: false,
          },
          input,
        );
      scope.events = [];
      const form = document.getElementById('f') as HTMLFormElement;
      document.addEventListener('nv:action', (event) =>
        scope.events.push((event as CustomEvent).detail),
      );
      scope.unbind = scope.nvActions.bindActionElement(form, rename, {
        input: (element) => ({
          title: String(new FormData(element as HTMLFormElement).get('title')),
        }),
      });
    });
    await page.fill('input[name=title]', 'no');
    await page.click('button');
    const form = page.locator('#f');
    await expect
      .poll(() => form.getAttribute('data-nv-action-state'))
      .toBe('error');
    expect(await page.getAttribute('input[name=title]', 'aria-invalid')).toBe(
      'true',
    );
    // Server messages are text, never HTML.
    expect(await page.textContent('[data-nv-error-for=title]')).toBe(
      '<b>Too short</b>',
    );
    expect(await page.locator('[data-nv-error-for=title] b').count()).toBe(0);
    await page.fill('input[name=title]', 'long enough');
    await page.click('button');
    await expect
      .poll(() => form.getAttribute('data-nv-action-state'))
      .toBe('success');
    expect(
      await page.getAttribute('input[name=title]', 'aria-invalid'),
    ).toBeNull();
    expect(await form.getAttribute('aria-busy')).toBeNull();
    const events = await page.evaluate(
      () => (window as unknown as { events: unknown[] }).events,
    );
    expect(events).toEqual([
      {
        ok: false,
        code: 'VALIDATION',
        issues: [{ path: ['title'], message: '<b>Too short</b>' }],
      },
      { ok: true, data: { title: 'long enough' } },
    ]);
    // Unbinding removes the listener: a further submit is a native submit.
    await page.evaluate(() =>
      (window as unknown as { unbind: () => void }).unbind(),
    );
    await page.close();
  });
});
