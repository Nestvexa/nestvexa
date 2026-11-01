import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  FORM_ERROR,
  FormInputError,
  MemoryDraftStore,
  createDraftManager,
  createFormMeta,
  customAdapter,
  defineWizard,
  dirtyFields,
  errorSummary,
  fieldView,
  formView,
  getPath,
  insertItem,
  moveItem,
  recordSubmit,
  removeItem,
  setPath,
  touchFields,
  visibleFields,
  zodAdapter,
} from '../packages/forms/dist/index.js';
import type { DraftStore, WizardState } from '../packages/forms/dist/index.js';

describe('accessible view helpers', () => {
  const errors = {
    email: ['Enter a valid email address.', 'Second message'],
    'items.0.name': ['Name each item.'],
    [FORM_ERROR]: ['Check the highlighted fields.'],
  };

  it('builds per-field aria data', () => {
    expect(fieldView(errors, 'email', { idPrefix: 'profile-' })).toEqual({
      id: 'profile-email',
      errorId: 'profile-email-error',
      invalid: true,
      ariaInvalid: 'true',
      message: 'Enter a valid email address.',
      messages: ['Enter a valid email address.', 'Second message'],
      describedBy: 'profile-email-error',
    });
    expect(
      fieldView(errors, 'name', {
        idPrefix: 'profile-',
        hints: { name: 'profile-name-hint' },
      }),
    ).toMatchObject({
      invalid: false,
      ariaInvalid: 'false',
      message: '',
      describedBy: 'profile-name-hint',
    });
    expect(fieldView(errors, 'items.0.name')).toMatchObject({
      id: 'items-0-name',
      errorId: 'items-0-name-error',
      invalid: true,
    });
  });

  it('hides errors of untouched fields when visible is given', () => {
    const meta = touchFields(createFormMeta(), ['name']);
    const visible = visibleFields(meta, ['name', 'email']);
    expect(visible).toEqual(['name']);
    expect(fieldView(errors, 'email', { visible }).invalid).toBe(false);
    expect(
      fieldView(errors, 'email', {
        visible: visibleFields(recordSubmit(meta), ['name', 'email']),
      }).invalid,
    ).toBe(true);
  });

  it('refuses unsafe ids and paths', () => {
    expect(() => fieldView(errors, 'email', { idPrefix: '"><x' })).toThrow(
      /idPrefix/,
    );
    expect(() => fieldView(errors, '__proto__')).toThrow(/Invalid field/);
    expect(() =>
      fieldView(errors, 'email', { hints: { email: 'a b' } }),
    ).toThrow(/Hint/);
  });

  it('builds an ordered error summary with in-page links', () => {
    const summary = errorSummary(errors, {
      idPrefix: 'profile-',
      labels: { email: 'Email', 'items.0.name': 'First item' },
      order: ['items', 'email'],
    });
    expect(summary).toEqual({
      hasErrors: true,
      count: 3,
      title: 'There are 3 problems',
      items: [
        {
          path: FORM_ERROR,
          label: '',
          message: 'Check the highlighted fields.',
          href: '',
        },
        {
          path: 'items.0.name',
          label: 'First item',
          message: 'Name each item.',
          href: '#profile-items-0-name',
        },
        {
          path: 'email',
          label: 'Email',
          message: 'Enter a valid email address.',
          href: '#profile-email',
        },
      ],
    });
    expect(errorSummary({}).hasErrors).toBe(false);
    expect(errorSummary({ a: ['x'] }).title).toBe('There is 1 problem');
    expect(
      errorSummary({ a: ['x'] }, { title: (count) => `${count} erreur` }).title,
    ).toBe('1 erreur');
    expect(Object.keys(formView(errors, ['email', 'name']))).toEqual([
      'email',
      'name',
    ]);
  });
});

describe('form meta, dirty tracking and repeaters', () => {
  it('tracks touched, submitted and submit count immutably', () => {
    const initial = createFormMeta();
    const touched = touchFields(initial, ['email', 'name', 'email']);
    expect(touched.touched).toEqual(['email', 'name']);
    expect(initial.touched).toEqual([]);
    const submitted = recordSubmit(recordSubmit(touched));
    expect(submitted).toEqual({
      touched: ['email', 'name'],
      submitted: true,
      submitCount: 2,
    });
    expect(() => touchFields(initial, ['__proto__'])).toThrow(/Invalid field/);
    // Corrupted stored meta is normalized rather than trusted.
    expect(
      recordSubmit({
        touched: ['ok', 7, '__proto__'],
        submitted: 'yes',
        submitCount: -3,
      } as never),
    ).toEqual({ touched: ['ok'], submitted: true, submitCount: 1 });
  });

  it('computes structural dirtiness', () => {
    expect(
      dirtyFields(
        { name: 'Ada', tags: ['a'], meta: { a: 1, b: 2 } },
        { name: 'Ada', tags: ['a', 'b'], meta: { b: 2, a: 1 } },
        ['name', 'tags', 'meta', 'missing'],
      ),
    ).toEqual(['tags']);
  });

  it('reads and writes nested paths without holes or prototype keys', () => {
    const value = { items: [{ name: 'Lamp' }] };
    const next = setPath(value, 'items.1.name', 'Desk');
    expect(next).toEqual({ items: [{ name: 'Lamp' }, { name: 'Desk' }] });
    expect(value).toEqual({ items: [{ name: 'Lamp' }] });
    expect(getPath(next, 'items.1.name')).toBe('Desk');
    expect(getPath(next, ['items', 5, 'name'])).toBeUndefined();
    expect(() => setPath(value, 'items.3.name', 'x')).toThrow(FormInputError);
    expect(() => setPath(value, 'items.__proto__', 'x')).toThrow(
      FormInputError,
    );
    expect(() => setPath(value, 'items.name', 'x')).toThrow(FormInputError);
    expect(setPath({}, ['a', 'b'], 1)).toEqual({ a: { b: 1 } });
  });

  it('inserts, removes and moves repeater items with bounds', () => {
    const list = [{ name: 'a' }, { name: 'b' }];
    expect(insertItem(list, 1, { name: 'x' })).toEqual([
      { name: 'a' },
      { name: 'x' },
      { name: 'b' },
    ]);
    expect(() => insertItem(list, 3, null)).toThrow(RangeError);
    expect(() => insertItem(list, 0, null, { max: 2 })).toThrow(/full/);
    expect(removeItem(list, 0)).toEqual([{ name: 'b' }]);
    expect(() => removeItem(list, 2)).toThrow(RangeError);
    expect(moveItem(list, 0, 1)).toEqual([{ name: 'b' }, { name: 'a' }]);
    expect(() => moveItem(list, 0, 9)).toThrow(RangeError);
    expect(() =>
      insertItem(list, 0, JSON.parse('{"__proto__":{"x":1}}')),
    ).toThrow(FormInputError);
  });
});

describe('multi-step wizard', () => {
  const taken = new Set(['taken@example.com']);
  const wizard = defineWizard(
    [
      {
        id: 'account',
        title: 'Account',
        fields: ['email'],
        adapter: zodAdapter(
          z.strictObject({
            email: z
              .email('Enter a valid email address.')
              .refine(
                async (email) => !taken.has(email),
                'This email is already registered.',
              ),
          }),
        ),
      },
      {
        id: 'profile',
        title: 'Profile',
        fields: ['name', 'plan'],
        adapter: zodAdapter(
          z.strictObject({
            name: z.string().min(2, 'Enter at least 2 characters.'),
            plan: z.enum(['free', 'team']),
          }),
        ),
      },
      {
        id: 'team',
        fields: ['seats'],
        adapter: zodAdapter(
          z.strictObject({ seats: z.number().int().min(1).max(50) }),
        ),
      },
    ],
    {
      final: zodAdapter(
        z
          .object({
            email: z.string(),
            name: z.string(),
            plan: z.enum(['free', 'team']),
            seats: z.number(),
          })
          .refine((value) => value.plan === 'team' || value.seats === 1, {
            path: ['seats'],
            message: 'Free plans have one seat.',
          }),
      ),
    },
  );
  const values = {
    email: 'ada@example.com',
    name: 'Ada',
    plan: 'free',
    seats: 1,
  };

  it('validates the current step only and advances', async () => {
    let state: WizardState = wizard.initial();
    expect(wizard.position(state)).toMatchObject({
      id: 'account',
      number: 1,
      count: 3,
      first: true,
      last: false,
    });
    const failed = await wizard.next(state, {
      ...values,
      email: 'taken@example.com',
      name: '',
    });
    expect(failed.ok).toBe(false);
    expect(failed.errors).toEqual({
      email: ['This email is already registered.'],
    });
    expect(failed.state.step).toBe(0);
    const passed = await wizard.next(state, values);
    expect(passed).toMatchObject({ ok: true, errors: {} });
    state = passed.state;
    expect(state).toEqual({ step: 1, completed: ['account'] });
    expect(wizard.back(state)).toEqual({ step: 0, completed: ['account'] });
    expect(wizard.goTo(state, 'account').step).toBe(0);
    expect(() => wizard.goTo(state, 'team')).toThrow(/not reachable/);
    expect(wizard.reset()).toEqual({ step: 0, completed: [] });
    expect(wizard.fields).toEqual(['email', 'name', 'plan', 'seats']);
  });

  it('never trusts forged progress', async () => {
    const forged = { step: 2, completed: ['team'] } as WizardState;
    expect(wizard.position(forged).id).toBe('account');
    const outOfOrder = { step: 9, completed: ['account', 'team'] };
    expect(wizard.position(outOfOrder).id).toBe('profile');
    // finish re-validates every step regardless of the claimed state.
    const finish = await wizard.finish(
      { step: 2, completed: ['account', 'profile', 'team'] },
      { ...values, name: 'A' },
    );
    expect(finish).toEqual({
      ok: false,
      errors: { name: ['Enter at least 2 characters.'] },
      state: { step: 1, completed: ['account'] },
    });
  });

  it('runs final cross-step validation and returns typed output', async () => {
    const crossStep = await wizard.finish(wizard.initial(), {
      ...values,
      seats: 3,
    });
    expect(crossStep).toEqual({
      ok: false,
      errors: { seats: ['Free plans have one seat.'] },
      state: { step: 2, completed: ['account', 'profile'] },
    });
    const done = await wizard.finish(wizard.initial(), values);
    expect(done.ok).toBe(true);
    if (done.ok) {
      const plan: 'free' | 'team' = done.value.plan;
      expect(plan).toBe('free');
      expect(done.state.completed).toEqual(['account', 'profile', 'team']);
    }
  });

  it('validates definitions at startup', () => {
    const adapter = customAdapter(() => null);
    expect(() => defineWizard([])).toThrow(/1–20/);
    expect(() =>
      defineWizard([
        { id: 'a', fields: ['x'], adapter },
        { id: 'a', fields: ['y'], adapter },
      ]),
    ).toThrow(/duplicate/);
    expect(() =>
      defineWizard([
        { id: 'a', fields: ['x'], adapter },
        { id: 'b', fields: ['x'], adapter },
      ]),
    ).toThrow(/two steps/);
    expect(() =>
      defineWizard([{ id: 'a', fields: ['__proto__'], adapter }]),
    ).toThrow(/Invalid wizard field/);
    const plain = defineWizard([{ id: 'only', fields: ['x'], adapter }]);
    expect(plain.position(plain.initial()).last).toBe(true);
  });
});

describe('drafts with consent, expiry and version conflicts', () => {
  it('saves, loads and rejects stale versions', async () => {
    let now = 1_000_000;
    const store = new MemoryDraftStore();
    const drafts = createDraftManager({
      store,
      ttlMs: 60_000,
      now: () => now,
    });
    expect(
      await drafts.save(
        'user:1',
        'profile',
        { bio: 'x' },
        {
          expectedVersion: 0,
          consent: false,
        },
      ),
    ).toEqual({ ok: false, reason: 'consent' });
    expect(await drafts.load('user:1', 'profile')).toBeUndefined();
    const first = await drafts.save(
      'user:1',
      'profile',
      { bio: 'one' },
      {
        expectedVersion: 0,
        consent: true,
      },
    );
    expect(first).toEqual({ ok: true, version: 1, savedAt: now });
    // A second tab that also started from version 0 must not overwrite newer work.
    const stale = await drafts.save(
      'user:1',
      'profile',
      { bio: 'two' },
      {
        expectedVersion: 0,
        consent: true,
      },
    );
    expect(stale).toMatchObject({
      ok: false,
      reason: 'conflict',
      current: { value: { bio: 'one' }, version: 1 },
    });
    expect(
      await drafts.save(
        'user:1',
        'profile',
        { bio: 'two' },
        {
          expectedVersion: 1,
          consent: true,
        },
      ),
    ).toMatchObject({ ok: true, version: 2 });
    // Owners are isolated.
    expect(await drafts.load('user:2', 'profile')).toBeUndefined();
    now += 60_001;
    expect(await drafts.load('user:1', 'profile')).toBeUndefined();
    expect(store.size).toBe(0);
    await drafts.save(
      'user:1',
      'profile',
      { bio: 'three' },
      {
        expectedVersion: 0,
        consent: true,
      },
    );
    await drafts.discard('user:1', 'profile');
    expect(await drafts.load('user:1', 'profile')).toBeUndefined();
  });

  it('enforces size, hardening and key rules', async () => {
    const drafts = createDraftManager({
      store: new MemoryDraftStore(2),
      maxBytes: 64,
    });
    expect(
      await drafts.save(
        'u',
        'notes',
        { text: 'x'.repeat(100) },
        {
          expectedVersion: 0,
          consent: true,
        },
      ),
    ).toEqual({ ok: false, reason: 'too-large' });
    await expect(
      drafts.save('u', 'notes', JSON.parse('{"__proto__":{}}'), {
        expectedVersion: 0,
        consent: true,
      }),
    ).rejects.toBeInstanceOf(FormInputError);
    await expect(drafts.load('u\n', 'notes')).rejects.toThrow(/owner/);
    await expect(drafts.load('u', 'Notes!')).rejects.toThrow(/form id/);
    await expect(
      drafts.save('u', 'notes', {}, { expectedVersion: -1, consent: true }),
    ).rejects.toThrow(/expectedVersion/);
    expect(() =>
      createDraftManager({ store: new MemoryDraftStore(), ttlMs: 10 }),
    ).toThrow(/ttlMs/);
    expect(() => new MemoryDraftStore(0)).toThrow(/maxEntries/);
  });

  it('reports a conflict when the store loses an atomic race', async () => {
    const inner = new MemoryDraftStore();
    const racing: DraftStore = {
      get: (key) => inner.get(key),
      delete: (key) => inner.delete(key),
      compareAndSet: (key, expected, draft) => {
        // Another writer commits between the read and the write.
        inner.compareAndSet(key, expected, { ...draft, value: 'other' });
        return inner.compareAndSet(key, expected, draft);
      },
    };
    const drafts = createDraftManager({ store: racing });
    expect(
      await drafts.save('u', 'notes', 'mine', {
        expectedVersion: 0,
        consent: true,
      }),
    ).toMatchObject({
      ok: false,
      reason: 'conflict',
      current: { value: 'other' },
    });
  });

  it('evicts the oldest draft when the memory store is full', () => {
    const store = new MemoryDraftStore(2);
    const draft = { value: 1, version: 1, savedAt: 0, expiresAt: 1e15 };
    store.compareAndSet('a', 0, draft);
    store.compareAndSet('b', 0, draft);
    store.compareAndSet('c', 0, draft);
    expect(store.get('a')).toBeUndefined();
    expect(store.size).toBe(2);
  });
});
