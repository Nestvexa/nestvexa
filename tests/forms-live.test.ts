import 'reflect-metadata';
import { Inject, Injectable, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import {
  Action,
  Computed,
  DateSynthesizer,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  State,
  describeLiveState,
} from '../packages/live/dist/index.js';
import type { LiveUpdateContext } from '../packages/live/dist/index.js';
import {
  createFormMeta,
  errorSummary,
  formView,
  visibleFields,
  zodAdapter,
} from '../packages/forms/dist/index.js';
import type { FormErrors, FormMeta } from '../packages/forms/dist/index.js';
import {
  readLiveFields,
  validateField,
  validateLive,
} from '../packages/forms/dist/live.js';

const origin = 'http://localhost:3104';
const csrf = 'forms-live-host-csrf-0123456789012345678901';
const resources: {
  app: INestApplication;
  root: string;
  renderer: HbsEngine;
}[] = [];
afterEach(async () => {
  for (const { app, root, renderer } of resources.splice(0)) {
    await app.close();
    await renderer.dispose();
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep))
      throw new Error('Unexpected fixture directory');
    await rm(root, { recursive: true, force: true });
  }
});

@Injectable()
class Directory {
  readonly emails = new Set(['taken@example.com']);
  lookups = 0;
  async available(email: string): Promise<boolean> {
    this.lookups++;
    await new Promise((done) => setTimeout(done, 5));
    return !this.emails.has(email.toLowerCase());
  }
}
@Module({ providers: [Directory], exports: [Directory] })
class DirectoryModule {}

const fields = ['name', 'email', 'age'] as const;
function profileAdapter(directory: Directory) {
  return zodAdapter(
    z.strictObject({
      name: z.string().trim().min(2, 'Enter at least 2 characters.').max(60),
      email: z
        .email('Enter a valid email address.')
        .refine(
          (email) => directory.available(email),
          'This email is already registered.',
        ),
      age: z.number().int().min(13, 'You must be at least 13.'),
    }),
  );
}

const textState = (max: number) => ({
  writable: true as const,
  validate: (value: unknown) =>
    typeof value === 'string' && value.length <= max,
});

@LiveComponent({ name: 'profile-form', view: 'profile-form' })
class ProfileForm {
  constructor(@Inject(Directory) private readonly directory: Directory) {}
  @State(textState(200)) name = '';
  @State(textState(200)) email = '';
  @State({ writable: true }) age = 0;
  @State() errors: FormErrors = {};
  @State() form: FormMeta = createFormMeta();
  @State() saved = '';
  @Computed() get view() {
    return formView(this.errors, [...fields], {
      idPrefix: 'profile-',
      visible: visibleFields(this.form, [...fields]),
    });
  }
  @Computed() get summary() {
    return errorSummary(this.errors, {
      idPrefix: 'profile-',
      order: [...fields],
    });
  }
  async afterUpdate(update: LiveUpdateContext): Promise<void> {
    await validateField(
      this,
      profileAdapter(this.directory),
      [...fields],
      update.field,
      {
        metaField: 'form',
      },
    );
  }
  @Action() async save(): Promise<void> {
    const result = await validateLive(
      this,
      profileAdapter(this.directory),
      [...fields],
      {
        metaField: 'form',
      },
    );
    if (!result.ok) return;
    const name: string = result.value.name;
    this.saved = `${name} <${result.value.email}> ${result.value.age}`;
  }
}

const template = `<form nv:submit="save" novalidate>
{{#if summary.hasErrors}}<div id="summary" role="group" aria-labelledby="summary-title"><h2 id="summary-title">{{summary.title}}</h2><ul>{{#each summary.items}}<li><a href="{{href}}">{{message}}</a></li>{{/each}}</ul></div>{{/if}}
<label for="{{view.name.id}}">Name</label>
<input id="{{view.name.id}}" nv:model.blur="name" aria-invalid="{{view.name.ariaInvalid}}"{{#if view.name.describedBy}} aria-describedby="{{view.name.describedBy}}"{{/if}}>
{{#if view.name.invalid}}<p id="{{view.name.errorId}}" role="alert">{{view.name.message}}</p>{{/if}}
<label for="{{view.email.id}}">Email</label>
<input id="{{view.email.id}}" nv:model.blur="email" aria-invalid="{{view.email.ariaInvalid}}"{{#if view.email.describedBy}} aria-describedby="{{view.email.describedBy}}"{{/if}}>
{{#if view.email.invalid}}<p id="{{view.email.errorId}}" role="alert">{{view.email.message}}</p>{{/if}}
<output id="saved">{{saved}}</output><button>Save</button></form>`;

interface Reply {
  status: number;
  body: {
    state: {
      errors: Record<string, string[]>;
      form: FormMeta;
      saved: string;
      name: string;
    };
    html: string;
    component: { revision: number };
    snapshot: string;
    code?: string;
  };
}
function post(url: string, body: object): Promise<Reply> {
  return new Promise((done, reject) => {
    const request = httpRequest(
      url,
      {
        method: 'POST',
        headers: {
          origin,
          'content-type': 'application/json',
          'x-nestvexa-csrf': csrf,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () =>
          done({
            status: response.statusCode ?? 500,
            body: JSON.parse(
              Buffer.concat(chunks).toString('utf8'),
            ) as Reply['body'],
          }),
        );
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

async function fixture(platform: 'express' | 'fastify') {
  const root = await mkdtemp(join(tmpdir(), 'nestvexa-forms-live-'));
  await writeFile(join(root, 'profile-form.hbs'), template);
  const renderer = new HbsEngine({ root });
  await renderer.initialize();
  const module = await Test.createTestingModule({
    imports: [
      LiveModule.register({
        components: [ProfileForm],
        imports: [DirectoryModule],
        renderer,
        origin,
        maxRequestsPerMinute: 200,
        resolveIdentity: () => ({
          binding: 'forms-live/session/alice',
          csrfToken: csrf,
        }),
        authorize: (_identity, _component, action) =>
          ['$mount', '$sync', 'save'].includes(action),
      }),
    ],
  }).compile();
  const app =
    platform === 'fastify'
      ? module.createNestApplication(new FastifyAdapter(), { logger: false })
      : module.createNestApplication({ logger: false });
  resources.push({ app, root, renderer });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const html = (await app.get(LiveRuntime).mount(ProfileForm, { headers: {} }))
    .value;
  let snapshot = /data-nv-snapshot="([^"]+)"/.exec(html)?.[1] ?? '';
  let revision = 0;
  const call = async (
    action: string,
    updates: object = {},
    override?: { revision?: number },
  ) => {
    const reply = await post(`${base}/_nestvexa/live/profile-form/${action}`, {
      protocol: 'nestvexa-live/1',
      requestId: randomUUID(),
      snapshot,
      revision: override?.revision ?? revision,
      updates,
      input: null,
    });
    if (reply.status === 201 || reply.status === 200) {
      snapshot = reply.body.snapshot;
      revision = reply.body.component.revision;
    }
    return reply;
  };
  return { call, directory: app.get(Directory), html };
}

describe.each(['express', 'fastify'] as const)(
  'Live form validation over real HTTP on %s',
  (platform) => {
    it('validates changed fields live, keeps other errors and runs async rules', async () => {
      const { call } = await fixture(platform);
      const first = await call('_sync', { name: 'A' });
      expect(first.status).toBe(201);
      expect(first.body.state.errors).toEqual({
        name: ['Enter at least 2 characters.'],
      });
      expect(first.body.state.form.touched).toEqual(['name']);
      expect(first.body.html).toContain('aria-invalid="true"');
      expect(first.body.html).toContain(
        'aria-describedby="profile-name-error"',
      );
      expect(first.body.html).toContain('role="alert">Enter at least 2');
      // Untouched invalid fields stay quiet until touched or submitted.
      expect(first.body.html).not.toContain('profile-email-error');
      const second = await call('_sync', { email: 'Taken@example.com' });
      expect(second.body.state.errors).toEqual({
        name: ['Enter at least 2 characters.'],
        email: ['This email is already registered.'],
      });
      const third = await call('_sync', { name: 'Ada' });
      expect(third.body.state.errors).toEqual({
        email: ['This email is already registered.'],
      });
      expect(third.body.state.form.touched).toEqual(['email', 'name']);
    });

    it('validates every field on submit, renders a summary and returns early', async () => {
      const { call } = await fixture(platform);
      const invalid = await call('save', { name: 'A', age: 9 });
      expect(invalid.status).toBe(201);
      expect(invalid.body.state.errors).toEqual({
        name: ['Enter at least 2 characters.'],
        email: ['Enter a valid email address.'],
        age: ['You must be at least 13.'],
      });
      expect(invalid.body.state.saved).toBe('');
      expect(invalid.body.state.form).toMatchObject({
        submitted: true,
        submitCount: 1,
      });
      expect(invalid.body.html).toContain('There are 3 problems');
      expect(invalid.body.html).toContain('href="#profile-name"');
      expect(invalid.body.html).toContain('profile-email-error');
      const valid = await call('save', {
        name: ' Ada ',
        email: 'ada@example.com',
        age: 36,
      });
      expect(valid.body.state.errors).toEqual({});
      expect(valid.body.state.saved).toBe('Ada <ada@example.com> 36');
      expect(valid.body.html).not.toContain('aria-invalid="true"');
      expect(valid.body.state.form.submitCount).toBe(2);
    });

    it('keeps the error bag server-owned and the protocol strictly typed', async () => {
      const { call } = await fixture(platform);
      const forged = await call('_sync', { errors: {} });
      expect(forged.status).toBe(422);
      expect(forged.body.code).toBe('STATE_LOCKED');
      const meta = await call('_sync', { form: { submitted: true } });
      expect(meta.body.code).toBe('STATE_LOCKED');
      // Type confusion is refused before any hook or validator runs.
      for (const updates of [{ age: '36' }, { name: 7 }, { name: ['Ada'] }]) {
        const reply = await call('_sync', updates);
        expect(reply.status, JSON.stringify(updates)).toBe(422);
        expect(reply.body.code).toBe('STATE_TYPE');
      }
      const oversized = await call('_sync', { name: 'x'.repeat(201) });
      expect(oversized.body.code).toBe('STATE_INVALID');
    });

    it('rejects obsolete validation requests by revision', async () => {
      const { call, directory } = await fixture(platform);
      await call('_sync', { name: 'Ada' });
      const lookups = directory.lookups;
      const stale = await call(
        '_sync',
        { email: 'old@example.com' },
        { revision: 0 },
      );
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('STALE_REVISION');
      // The obsolete request never reached the async validator.
      expect(directory.lookups).toBe(lookups);
    });
  },
);

describe('validateLive guards', () => {
  @LiveComponent({ name: 'guarded-form', view: 'unused' })
  class Guarded {
    secret = 'server only';
    @State({ writable: true }) name = 'Ada';
    @State({ synthesizer: DateSynthesizer, writable: true }) when = new Date(0);
    @State() errors: FormErrors = {};
    @State({ writable: true }) openErrors: FormErrors = {};
  }
  const adapter = zodAdapter(z.object({ name: z.string().min(2) }));

  it('reads only declared, non-synthesized state', () => {
    const component = new Guarded();
    expect(describeLiveState(component, 'name')).toEqual({
      writable: true,
      synthesized: false,
    });
    expect(describeLiveState(component, 'secret')).toBeUndefined();
    expect(describeLiveState({ name: 'x' }, 'name')).toBeUndefined();
    expect(readLiveFields(component, ['name'])).toEqual({ name: 'Ada' });
    expect(() => readLiveFields(component, ['secret'])).toThrow(/declared/);
    expect(() => readLiveFields(component, ['when'])).toThrow(/synthesizer/);
    expect(() => readLiveFields(component, ['name', 'name'])).toThrow(/unique/);
    expect(() => readLiveFields(component, [])).toThrow(/1–200/);
    expect(() => readLiveFields(component, ['__proto__'])).toThrow(/unique/);
  });

  it('requires a read-only declared errors field', async () => {
    const component = new Guarded();
    await expect(
      validateLive(component, adapter, ['name'], { errorsField: 'openErrors' }),
    ).rejects.toThrow(/read-only @State/);
    await expect(
      validateLive(component, adapter, ['name'], { errorsField: 'secret' }),
    ).rejects.toThrow(/read-only @State/);
    await expect(
      validateLive({ name: 'x', errors: {} }, adapter, ['name']),
    ).rejects.toThrow(/read-only @State/);
    const result = await validateLive(component, adapter, ['name']);
    expect(result.ok).toBe(true);
    component.name = 'A';
    const failed = await validateLive(component, adapter, ['name']);
    expect(failed.ok).toBe(false);
    expect(component.errors).toEqual({ name: [expect.any(String)] });
    expect(
      await validateField(component, adapter, ['name'], 'other'),
    ).toBeUndefined();
  });

  it('maps hardening violations to 400 Bad Request', async () => {
    const component = new Guarded();
    component.name = 'x'.repeat(50);
    await expect(
      validateLive(component, adapter, ['name'], {
        limits: { maxStringLength: 10 },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
