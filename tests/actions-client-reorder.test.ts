import { describe, expect, it } from 'vitest';
import {
  ActionClientError,
  createActionController,
} from '../packages/actions/dist/client/index.js';
import type {
  ActionCallOptions,
  ActionMethod,
} from '../packages/actions/dist/client/index.js';

// EXT-007: reorder-safe result handling. Parallel calls (`abortPrevious:
// false`) and controllers of different components settle out of order; an
// older or foreign result must never overwrite the newer state.

type Rename = ActionMethod<{ title: string }, { title: string }, 'title'>;

/** A fake action method whose calls the test settles in any order. */
function scripted() {
  const calls: {
    input: { title: string };
    signal: AbortSignal | undefined;
    resolve(value: { title: string }): void;
    reject(error: unknown): void;
  }[] = [];
  const method = ((input: { title: string }, options?: ActionCallOptions) =>
    new Promise<{ title: string }>((resolve, reject) => {
      options?.signal?.addEventListener('abort', () =>
        reject(new DOMException('Aborted', 'AbortError')),
      );
      calls.push({ input, signal: options?.signal, resolve, reject });
    })) as Rename;
  return { method, calls };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('parallel action results settling out of order', () => {
  it('ignores an older result that arrives after the newer one', async () => {
    const { method, calls } = scripted();
    const successes: string[] = [];
    const controller = createActionController(method, {
      abortPrevious: false,
      initialData: { title: 'initial' },
      optimistic: (_current, input) => ({ title: `${input.title}…` }),
      onSuccess: (data) => successes.push(data.title),
    });
    const older = controller.run({ title: 'older' });
    const newer = controller.run({ title: 'newer' });
    expect(calls.map((call) => call.signal?.aborted)).toEqual([false, false]);
    calls[1]?.resolve({ title: 'newer' });
    expect(await newer).toEqual({ ok: true, data: { title: 'newer' } });
    calls[0]?.resolve({ title: 'older' });
    // The caller still gets its own result; the shared state does not move back.
    expect(await older).toEqual({ ok: true, data: { title: 'older' } });
    expect(controller.getSnapshot()).toMatchObject({
      status: 'success',
      data: { title: 'newer' },
      optimistic: false,
    });
    expect(successes).toEqual(['newer']);
  });

  it('keeps the newest optimistic value pending when an older call settles first', async () => {
    const { method, calls } = scripted();
    const controller = createActionController(method, {
      abortPrevious: false,
      optimistic: (_current, input) => ({ title: `${input.title}…` }),
    });
    const older = controller.run({ title: 'older' });
    void controller.run({ title: 'newer' });
    calls[0]?.resolve({ title: 'older' });
    await older;
    expect(controller.getSnapshot()).toMatchObject({
      status: 'pending',
      data: { title: 'newer…' },
      optimistic: true,
    });
    // An older failure does not roll the newer projection back either.
    const third = controller.run({ title: 'third' });
    calls[1]?.reject(
      new ActionClientError('CONFLICT', 'Conflict', { status: 409 }),
    );
    await tick();
    expect(controller.getSnapshot()).toMatchObject({
      status: 'pending',
      data: { title: 'third…' },
    });
    calls[2]?.resolve({ title: 'third' });
    await third;
    expect(controller.getSnapshot()).toMatchObject({
      status: 'success',
      data: { title: 'third' },
      error: undefined,
    });
  });
});

describe('actions across components settling out of order', () => {
  it('applies each component its own result whatever the arrival order', async () => {
    const { method, calls } = scripted();
    // Two components (for example two cards) sharing one typed action.
    const cardA = createActionController(method, {
      initialData: { title: 'A' },
      optimistic: (_current, input) => ({ title: `${input.title}…` }),
    });
    const cardB = createActionController(method, {
      initialData: { title: 'B' },
      optimistic: (_current, input) => ({ title: `${input.title}…` }),
    });
    const a1 = cardA.run({ title: 'A1' });
    const b1 = cardB.run({ title: 'B1' });
    const a2 = cardA.run({ title: 'A2' });
    // A's first call was superseded within A only; B's call is untouched.
    expect(calls.map((call) => call.signal?.aborted)).toEqual([
      true,
      false,
      false,
    ]);
    calls[2]?.resolve({ title: 'A2' });
    await a2;
    expect(cardB.getSnapshot()).toMatchObject({
      status: 'pending',
      data: { title: 'B1…' },
    });
    calls[1]?.resolve({ title: 'B1' });
    await b1;
    // A's aborted stale call settles last and changes nothing.
    calls[0]?.resolve({ title: 'A1-stale' });
    expect((await a1).ok).toBe(false);
    expect(cardA.getSnapshot()).toMatchObject({
      status: 'success',
      data: { title: 'A2' },
    });
    expect(cardB.getSnapshot()).toMatchObject({
      status: 'success',
      data: { title: 'B1' },
    });
  });

  it('rolls back only the component whose parallel call failed', async () => {
    const { method, calls } = scripted();
    const cardA = createActionController(method, {
      abortPrevious: false,
      initialData: { title: 'A' },
      optimistic: (_current, input) => ({ title: `${input.title}…` }),
    });
    const cardB = createActionController(method, {
      abortPrevious: false,
      initialData: { title: 'B' },
      optimistic: (_current, input) => ({ title: `${input.title}…` }),
    });
    const a = cardA.run({ title: 'A1' });
    const b = cardB.run({ title: 'B1' });
    calls[1]?.resolve({ title: 'B1' });
    calls[0]?.reject(
      new ActionClientError('CONFLICT', 'Conflict', { status: 409 }),
    );
    await Promise.all([a, b]);
    expect(cardA.getSnapshot()).toMatchObject({
      status: 'error',
      data: { title: 'A' },
      optimistic: false,
    });
    expect(cardA.getSnapshot().error?.code).toBe('CONFLICT');
    expect(cardB.getSnapshot()).toMatchObject({
      status: 'success',
      data: { title: 'B1' },
      error: undefined,
    });
  });
});
