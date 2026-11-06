/**
 * LIVE-014 optional decorators: `@Renderless`, `@Validate` (functions,
 * Standard Schema and safeParse schemas), `schemaPipe` for action input and
 * `@Title`. `@Transition` and `@Layout` are intentionally not provided (see
 * packages/live/README.md).
 */
import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Action,
  ActionInput,
  LIVE_RESPONSE_SCHEMA,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  Renderless,
  State,
  Title,
  Validate,
  schemaPipe,
} from '../packages/live/dist/index.js';
import type {
  SafeParseSchemaLike,
  StandardSchemaLike,
} from '../packages/live/dist/index.js';
import { definition } from '../packages/live/dist/metadata.js';
import {
  application,
  cleanup,
  envelope,
  marker,
  platforms,
  policies,
  renderer,
  send,
} from './support/live-fixture.js';
import type { Platform } from './support/live-fixture.js';

afterEach(cleanup);

/** Minimal Standard Schema v1 for a bounded string, like Zod/Valibot produce. */
const nameSchema: StandardSchemaLike = {
  '~standard': {
    version: 1,
    validate: (value: unknown) =>
      typeof value === 'string' && value.length >= 2 && value.length <= 20
        ? { value: value.trim() }
        : { issues: [{ message: 'Name must be 2–20 characters', path: [] }] },
  },
};
/** Zod-style safeParse schema for `{ quantity: 1..10 }` that coerces strings. */
const orderSchema: SafeParseSchemaLike = {
  safeParse: (value: unknown) => {
    const quantity: unknown =
      value && typeof value === 'object'
        ? Reflect.get(value, 'quantity')
        : undefined;
    const number = typeof quantity === 'string' ? Number(quantity) : quantity;
    return typeof number === 'number' &&
      Number.isInteger(number) &&
      number >= 1 &&
      number <= 10
      ? { success: true, data: { quantity: number } }
      : {
          success: false,
          error: {
            issues: [{ message: 'Quantity must be 1–10', path: ['quantity'] }],
          },
        };
  },
};

const ran: string[] = [];
@LiveComponent({ name: 'profile', view: 'profile' })
class Profile {
  @Validate(nameSchema) @State({ writable: true }) name = 'Ada';
  @Validate((value) => typeof value === 'number' && value >= 0)
  @State({ writable: true })
  age = 36;
  @State({ writable: true }) @Validate(orderSchema) order = { quantity: 1 };
  @State() quantity = 0;
  @Title() get pageTitle(): string {
    return `Profile of ${this.name}`;
  }
  @Action() @Renderless() touch(): void {
    ran.push('touch');
  }
  @Action() save(): void {
    ran.push('save');
  }
  @Action() buy(
    @ActionInput(schemaPipe(orderSchema)) input: { quantity: number },
  ): void {
    ran.push(`buy:${typeof input.quantity}`);
    this.quantity = input.quantity;
  }
}

describe('optional decorator metadata', () => {
  it('merges @Renderless and @Validate into the definition', () => {
    const profile = definition(Profile);
    expect(profile.actions.get('touch')).toMatchObject({ renderless: true });
    expect(profile.actions.get('save')?.renderless).toBeUndefined();
    expect(typeof profile.states.get('name')?.validate).toBe('function');
    expect(typeof profile.states.get('order')?.validate).toBe('function');
    expect(profile.title).toBe('pageTitle');
    expect(LIVE_RESPONSE_SCHEMA.properties).toHaveProperty('title');
  });

  it('rejects misuse at startup', () => {
    @LiveComponent({ name: 'renderless-only', view: 'x' })
    class RenderlessOnly {
      @Renderless() touch(): void {}
    }
    expect(() => definition(RenderlessOnly)).toThrow(
      /@Renderless without @Action/,
    );
    @LiveComponent({ name: 'locked-validate', view: 'x' })
    class LockedValidate {
      @Validate(() => true) @State() name = '';
    }
    expect(() => definition(LockedValidate)).toThrow(/writable: true/);
    @LiveComponent({ name: 'double-validate', view: 'x' })
    class DoubleValidate {
      @Validate(() => true)
      @State({ writable: true, validate: () => true })
      name = '';
    }
    expect(() => definition(DoubleValidate)).toThrow(/both/);
    expect(() => Validate({} as unknown as StandardSchemaLike)).toThrow(
      /Standard Schema/,
    );
    expect(() => schemaPipe({} as unknown as StandardSchemaLike)).toThrow();
    expect(() => {
      class TwoTitles {
        @Title() get a(): string {
          return 'a';
        }
        @Title() get b(): string {
          return 'b';
        }
      }
      return TwoTitles;
    }).toThrow(/Only one @Title/);
  });
});

describe.each(platforms)(
  'optional decorators over HTTP: %s',
  (platform: Platform) => {
    async function fixture() {
      ran.length = 0;
      const { engine, module, resource } = await renderer({
        profile: '<p>{{name}} {{age}} {{quantity}}</p>',
      });
      const app = await application(
        platform,
        [
          LiveModule.registerAsync({
            components: [Profile],
            imports: [module],
            useFactory: () => policies(engine),
          }),
        ],
        [],
        resource,
      );
      const html = (await app.get(LiveRuntime).mount(Profile, { headers: {} }))
        .value;
      return { app, reference: marker(html) };
    }

    it('validates writes with schemas and functions before any action runs', async () => {
      const { app, reference } = await fixture();
      const rejected = [
        { name: 'A' },
        { name: 42 },
        { age: -1 },
        { order: { quantity: 11 } },
      ];
      for (const updates of rejected) {
        const reply = await send(
          app,
          '/_nestvexa/live/profile/save',
          envelope(reference, { updates }),
        );
        expect(reply.status).toBe(422);
        expect(reply.json()['code']).toMatch(/STATE_(INVALID|TYPE)/);
      }
      expect(ran).toEqual([]);
      const accepted = await send(
        app,
        '/_nestvexa/live/profile/save',
        envelope(reference, {
          updates: { name: 'Grace', age: 40, order: { quantity: 3 } },
        }),
      );
      expect(accepted.status).toBe(201);
      expect(accepted.json()['state']).toMatchObject({
        name: 'Grace',
        age: 40,
      });
      // @Title is evaluated after rendering and returned as plain text.
      expect(accepted.json()['title']).toBe('Profile of Grace');
      expect(ran).toEqual(['save']);
    });

    it('acknowledges @Renderless actions without HTML when negotiated', async () => {
      const { app, reference } = await fixture();
      const reply = await send(
        app,
        '/_nestvexa/live/profile/touch',
        envelope(reference),
        { 'x-nestvexa-capabilities': 'renderless-v1' },
      );
      expect(reply.status).toBe(201);
      expect(reply.json()).toMatchObject({ renderless: true, html: '' });
      expect(reply.json()['title']).toBeUndefined();
    });

    it('passes schema output to the action and rejects invalid input without echoing it', async () => {
      const { app, reference } = await fixture();
      const invalid = await send(
        app,
        '/_nestvexa/live/profile/buy',
        envelope(reference, { input: { quantity: '<b>99</b>' } }),
      );
      expect(invalid.status).toBe(400);
      expect(invalid.json()).toMatchObject({
        message: 'Invalid action input',
        issues: [{ path: 'quantity', message: 'Quantity must be 1–10' }],
      });
      expect(invalid.body).not.toContain('<b>99</b>');
      expect(ran).toEqual([]);
      const valid = await send(
        app,
        '/_nestvexa/live/profile/buy',
        envelope(reference, { input: { quantity: '4' } }),
      );
      expect(valid.status).toBe(201);
      expect(valid.json()['state']).toMatchObject({ quantity: 4 });
      expect(ran).toEqual(['buy:number']);
    });
  },
);
